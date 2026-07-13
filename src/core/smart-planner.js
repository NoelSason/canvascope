/**
 * Canvascope v10 — Smart Planner view.
 * Generalizes the syllabus autopilot: instead of one PDF, it reads every
 * upcoming deadline (indexedContent + customTodos), asks the shared AIRouter
 * to split them into study blocks, and renders the same editable
 * checklist → /todo + Google Calendar + reminder flow the autopilot proved.
 */
(() => {
  let deps = null; // { markdown }
  let busy = false;

  const $ = (id) => document.getElementById(id);
  const MS_DAY = 24 * 60 * 60 * 1000;
  const DEADLINE_HANDOFF_BUFFER_MINUTES = 30;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Upcoming dated work: next 14 days plus anything overdue, soonest first. */
  async function loadDeadlines() {
    const corpus = await RAGCore.buildCorpus();
    const now = Date.now();
    return corpus
      .filter(i => i.dueAt && !i.done && i.type !== 'note')
      .map(i => ({ ...i, ts: new Date(i.dueAt).getTime() }))
      .filter(i => Number.isFinite(i.ts) && i.ts > now - 7 * MS_DAY && i.ts < now + 14 * MS_DAY)
      .sort((a, b) => a.ts - b.ts);
  }

  function renderRadar(items) {
    const mount = $('plan-radar-mount');
    if (!mount || typeof window.CanvascopeRadar === 'undefined') return;
    window.CanvascopeRadar.render(mount, {
      items,
      onOpen: (item) => { if (item && item.url) chrome.tabs.create({ url: item.url }); }
    });
  }

  function classifyDeadline(item, nowMs = Date.now()) {
    const ts = Number(item && item.ts);
    const hoursUntilDue = Number.isFinite(ts) ? (ts - nowMs) / (60 * 60 * 1000) : Infinity;
    const title = String((item && item.title) || '').toLowerCase();
    const body = `${title} ${String((item && (item.description || item.text || item.content)) || '').toLowerCase()}`;

    let urgency = 'later';
    if (hoursUntilDue < 0) urgency = 'overdue';
    else if (hoursUntilDue <= 24) urgency = 'today';
    else if (hoursUntilDue <= 72) urgency = 'soon';

    let effort = 'normal';
    if (/\b(exam|midterm|final|project|presentation|essay|paper|lab|portfolio|capstone|research)\b/.test(body)) {
      effort = 'high';
    } else if (/\b(quiz|worksheet|discussion|reading|reflection|survey|exit ticket|check[- ]?in)\b/.test(body)) {
      effort = 'quick';
    }

    return { urgency, effort };
  }

  function compactDeadlineText(item, maxLength = 180) {
    const text = String((item && (item.description || item.text || item.content)) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
  }

  function inferSubmissionChecklist(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const checks = [];
    const add = (label) => { if (!checks.includes(label)) checks.push(label); };

    if (/\b(github|git\b|commit|push|pull request|repo(?:sitory)?|branch)\b/.test(source)) add('push repo');
    if (/\b(gradescope|autograder|auto[- ]?grader|submitty|codegrade)\b/.test(source)) add('submit autograder');
    if (/\b(readme|write[- ]?up|report|reflection|design doc|implementation notes?)\b/.test(source)) add('attach write-up');
    if (/\b(test cases?|unit tests?|pytest|npm test|xcodebuild|junit|coverage)\b/.test(source)) add('run tests');
    if (/\b(pdf|slides?|screenshot|screen recording|demo video|presentation)\b/.test(source)) add('upload artifact');
    if (/\b(partner|team|group|peer review|collab(?:oration)?)\b/.test(source)) add('coordinate team');

    return checks.slice(0, 4);
  }

  function inferConceptReviewHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(big[- ]?o|runtime|complexit(?:y|ies)|asymptotic|theta|omega)\b/.test(source)) add('Big-O/runtime');
    if (/\b(recursion|recursive|backtracking|divide and conquer)\b/.test(source)) add('recursion patterns');
    if (/\b(graphs?|dfs|bfs|shortest path|dijkstra|topological|mst|minimum spanning)\b/.test(source)) add('graph traversal');
    if (/\b(dynamic programming|\bdp\b|memo(?:ization|ize)|knapsack|optimal substructure)\b/.test(source)) add('dynamic programming');
    if (/\b(sql|database|joins?|normalization|index(?:es|ing)?|transactions?)\b/.test(source)) add('database queries');
    if (/\b(networks?|networking|internet|tcp|udp|http|dns|routing|sockets?|packet|latency|bandwidth)\b/.test(source)) add('networking fundamentals');
    if (/\b(security|cryptograph(?:y|ic)|crypto\b|encryption|authentication|authorization|oauth|hash(?:ing)?|xss|csrf|injection)\b/.test(source)) add('security model');
    if (/\b(concurrency|parallel|threads?|locks?|mutex|semaphore|race condition|deadlock)\b/.test(source)) add('concurrency pitfalls');
    if (/\b(memory|pointers?|heap|stack|malloc|free|segfault|garbage collection)\b/.test(source)) add('memory model');
    if (/\b(probability|bayes|regression|gradient|matrix|linear algebra|statistics)\b/.test(source)) add('math foundations');

    return hints.slice(0, 3);
  }

  function inferSubmissionStatusFlags(item, nowMs = Date.now()) {
    const flags = [];
    const add = (label) => { if (!flags.includes(label)) flags.push(label); };
    const submission = item?.submission || item?.submissionStatus || item?.submission_status || {};
    const workflowState = String(submission.workflow_state || submission.workflowState || item?.workflowState || item?.workflow_state || '').toLowerCase();
    const submittedAt = submission.submitted_at || submission.submittedAt || item?.submittedAt || item?.submitted_at;
    const hasSubmission = Boolean(submittedAt || submission.submission_type || submission.submissionType || submission.url || submission.attachments?.length || item?.submitted === true);
    const gradedAt = submission.graded_at || submission.gradedAt || item?.gradedAt || item?.graded_at;
    const score = submission.score ?? item?.score ?? item?.grade;
    const ts = Number(item && item.ts);
    const isPastDue = Number.isFinite(ts) && ts < nowMs;
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();

    if (workflowState === 'unsubmitted' || item?.missing === true || (isPastDue && !hasSubmission && /\b(submit|submission|upload|assignment|project|lab|quiz|discussion|paper|essay|report)\b/.test(source))) {
      add('missing submission');
    }
    if (hasSubmission && !gradedAt && score == null && !/graded|complete/.test(workflowState)) add('awaiting grade');
    if (workflowState === 'graded' || gradedAt || score != null) add('graded');
    if (submission.late === true || item?.late === true || /\blate\b/.test(workflowState)) add('late');
    if (submission.excused === true || item?.excused === true) add('excused');

    return flags.slice(0, 2);
  }

  function inferPlannerRiskFlags(item, peers = [], nowMs = Date.now()) {
    const flags = [];
    const add = (label) => { if (!flags.includes(label)) flags.push(label); };
    const ts = Number(item && item.ts);
    const hoursUntilDue = Number.isFinite(ts) ? (ts - nowMs) / (60 * 60 * 1000) : Infinity;
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hasSourceNotes = Boolean(String(item?.description || item?.text || item?.content || '').trim());
    const explicitPoints = Number(item?.pointsPossible ?? item?.points ?? item?.points_possible ?? item?.maxPoints);
    const textPointMatches = Array.from(source.matchAll(/\b(\d{2,4})\s*(?:pts?|points?)\b/g), match => Number(match[1]))
      .filter(Number.isFinite);
    const pointValue = Number.isFinite(explicitPoints) ? explicitPoints : (textPointMatches.length ? Math.max(...textPointMatches) : NaN);

    inferSubmissionStatusFlags(item, nowMs).forEach(add);
    if (Number.isFinite(pointValue) && pointValue >= 100) add('large point value');
    if (hoursUntilDue < 0) add('overdue');
    else if (hoursUntilDue <= 48 && /\b(not started|starter|draft|proposal|milestone|checkpoint|practice|review|project|paper|essay|exam|final|lab)\b/.test(source)) {
      add('start now');
    }

    if (!hasSourceNotes && /\b(project|exam|midterm|final|paper|essay|lab|presentation|portfolio|capstone)\b/.test(source)) {
      add('link notes');
    }

    if (Number.isFinite(ts)) {
      const dayKey = new Date(ts).toDateString();
      const sameDay = (Array.isArray(peers) ? peers : []).filter(peer => {
        const peerTs = Number(peer && peer.ts);
        return Number.isFinite(peerTs) && !peer.done && new Date(peerTs).toDateString() === dayKey;
      }).length;
      if (sameDay >= 3) add('busy day');
    }

    if (/\b(upload|submit|submission|gradescope|canvas|autograder|attach|screenshot|pdf|slides?|repo|github|push)\b/.test(source)) {
      add('submission check');
    }

    if (/\b(install|setup|set up|environment|starter code|starter repo|clone|dataset|data set|api key|token|credentials?|access code|license|download)\b/.test(source)) {
      add('setup first');
    }
    if (/\b(stuck|blocked|office hours|piazza|edstem|ed discussion|ta\b|tutor|partner|group|peer review|collab(?:oration)?)\b/.test(source)) {
      add('ask for help');
    }

    return flags.slice(0, 3);
  }

  function inferStudyPhases(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const phases = [];
    const add = (label) => { if (!phases.includes(label)) phases.push(label); };

    const isProjectLike = /\b(project|portfolio|capstone|milestone|implementation|coding|lab)\b/.test(source);
    if (/\b(exam|midterm|final|test)\b/.test(source) && !isProjectLike) {
      add('Active recall drill');
      add('Practice problems');
      add('Review weak spots');
    } else if (isProjectLike) {
      add('Outline and unblock');
      add('Build or solve');
      add('Test and submit');
    } else if (/\b(essay|paper|research|report|write[- ]?up|reflection)\b/.test(source)) {
      add('Outline argument');
      add('Draft');
      add('Revise and cite');
    } else if (/\b(reading|chapter|lecture|notes?)\b/.test(source)) {
      add('Read and annotate');
      add('Self-quiz from notes');
    }

    return phases.slice(0, 3);
  }

  function inferLearningStrategyHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(exam|midterm|final|test|quiz)\b/.test(source)) {
      add('active recall');
      add('spaced review');
    }
    if (/\b(practice|problem set|pset|worksheet|drill|leetcode|coding challenge)\b/.test(source)) add('practice reps');
    if (/\b(lecture|slides?|chapter|reading|notes?|paper|article)\b/.test(source)) add('turn notes into questions');
    if (/\b(project|lab|implementation|coding|programming|github|repo|autograder|debug)\b/.test(source)) add('debug log');
    if (/\b(error analysis|postmortem|reflection|retrospective|mistakes?|wrong answers?)\b/.test(source)) add('mistake review');

    return hints.slice(0, 3);
  }

  function inferFocusSprintHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(project|lab|implementation|coding|programming|essay|paper|research|report|portfolio|capstone|final|midterm|exam)\b/.test(source)) {
      add('start focus sprint');
    }
    if (/\b(distraction|focus|deep work|pomodoro|time[- ]?box|timebox|study block|sprint|flow)\b/.test(source)) {
      add('protect attention');
    }
    if (/\b(checkpoint|milestone|draft|outline|starter|not started|progress|next steps?|todo|to[- ]?do)\b/.test(source)) {
      add('define done for block');
    }
    if (/\b(long|multi[- ]?part|multi part|cumulative|comprehensive|several|multiple|complex|large)\b/.test(source)) {
      add('take reset break');
    }

    return hints.slice(0, 3);
  }

  function inferPracticeArtifactHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(exam|midterm|final|test|quiz)\b/.test(source)) add('generate practice questions');
    if (/\b(practice exam|past exam|mock exam|sample exam|previous exam|released exam)\b/.test(source)) add('redo past exam');
    if (/\b(flashcards?|anki|quizlet|spaced repetition|vocab(?:ulary)?|definitions?|terms?)\b/.test(source)) add('review flashcards');
    if (/\b(formula sheet|cheat sheet|reference sheet|crib sheet|study guide)\b/.test(source)) add('build study sheet');
    if (/\b(wrong answers?|mistakes?|missed questions?|error log|corrections?)\b/.test(source)) add('drill missed questions');

    return hints.slice(0, 3);
  }

  function inferRetrievalCalibrationHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(exam|midterm|final|test|quiz|practice exam|mock exam|review)\b/.test(source)) add('rate confidence before answers');
    if (/\b(wrong answers?|mistakes?|missed questions?|error log|corrections?|postmortem|reflection)\b/.test(source)) add('log why misses happened');
    if (/\b(confus(?:ed|ing|ion)|unclear|weak spots?|struggl(?:e|ing)|hard topics?|don'?t understand)\b/.test(source)) add('mark red/yellow/green topics');
    if (/\b(cumulative|comprehensive|mixed review|multiple units?|chapters?|modules?|interleav(?:e|ed|ing))\b/.test(source)) add('interleave old and new topics');

    return hints.slice(0, 3);
  }

  function inferSocraticStudyHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(problem set|pset|homework|worksheet|practice problems?|coding challenge|leetcode|lab|debug|bug|proof|derivation)\b/.test(source)) {
      add('ask guiding questions first');
    }
    if (/\b(stuck|blocked|confus(?:ed|ing|ion)|unclear|don'?t understand|wrong answer|failed attempt|not working)\b/.test(source)) {
      add('diagnose misconception before answer');
    }
    if (/\b(ai tutor|tutor|chatgpt|copilot|llm|study mode|assistant|office hours|ta\b)\b/.test(source)) {
      add('prefer hints over solutions');
    }
    if (/\b(answer key|solutions?|spoilers?|academic integrity|unauthorized assistance|allowed tools?)\b/.test(source)) {
      add('avoid answer dumping');
    }

    return hints.slice(0, 3);
  }

  function inferTeachBackHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(exam|midterm|final|test|quiz|oral exam|presentation|demo|defense)\b/.test(source)) add('explain aloud');
    if (/\b(concept|theorem|proof|definition|algorithm|protocol|model|framework|mechanism|process)\b/.test(source)) add('teach key concepts');
    if (/\b(confus(?:ed|ing|ion)|unclear|weak spots?|struggl(?:e|ing)|hard topics?|don'?t understand|review)\b/.test(source)) add('find explanation gaps');
    if (/\b(study group|partner|peer|ta\b|tutor|office hours|discussion section)\b/.test(source)) add('prepare peer explanation');

    return hints.slice(0, 3);
  }

  function inferAcademicIntegrityHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(ai policy|generative ai|genai|chatgpt|copilot|llm|large language model|allowed tools?|unauthorized assistance)\b/.test(source)) {
      add('check AI policy');
    }
    if (/\b(citations?|bibliograph(?:y|ies)|works cited|references?|quote|quoted|sources?|academic integrity|plagiarism|turnitin)\b/.test(source)) {
      add('cite sources');
    }
    if (/\b(peer review|group|partner|team|collab(?:oration)?|shared repo)\b/.test(source)) {
      add('document collaboration');
    }

    return hints.slice(0, 3);
  }

  function inferCodeDebugHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`;
    const lower = source.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/```|\b(stack trace|traceback|exception|segfault|null pointer|undefined is not|typeerror|syntaxerror|referenceerror|assertion(?: failed)?|failing tests?)\b/i.test(source)) {
      add('explain error');
    }
    if (/\b(debug|bug|fix|failing|failure|regression|test failure|red test|flaky)\b/.test(lower)) add('write debug notes');
    if (/\b(api|endpoint|sdk|library|framework|hooks?|promise|async|await|component|state|props)\b/.test(lower)) add('trace API flow');
    if (/\b(cli|terminal|shell|command line|npm|pip|pytest|node|git|docker|make)\b/.test(lower)) add('verify commands');

    return hints.slice(0, 3);
  }

  function inferOfficeHoursPrepHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(stuck|blocked|confus(?:ed|ing|ion)|unclear|don'?t understand|office hours|ta\b|tutor|help|question|questions|piazza|edstem|ed discussion)\b/.test(source)) {
      add('write specific question');
    }
    if (/\b(error|bug|debug|failing|failure|traceback|exception|segfault|crash|wrong answer|autograder|gradescope)\b/.test(source)) {
      add('bring error trace');
    }
    if (/\b(attempt|tried|draft|starter|partial|prototype|not working|stuck on)\b/.test(source)) {
      add('summarize what you tried');
    }
    if (/\b(rubric|requirements?|spec(?:ification)?|prompt|instructions?|criteria|checklist)\b/.test(source)) {
      add('cite requirement');
    }

    return hints.slice(0, 3);
  }

  function inferCollaborationHandoffHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(group|partner|team|peer review|collab(?:oration)?|shared repo|pair programming)\b/.test(source)) {
      add('confirm owners');
    }
    if (/\b(shared repo|branch|merge|pull request|pr\b|github|gitlab|commit|push|conflicts?)\b/.test(source)) {
      add('sync branch early');
    }
    if (/\b(demo|presentation|slides?|walkthrough|recording|screencast|showcase)\b/.test(source)) {
      add('rehearse demo handoff');
    }
    if (/\b(peer review|review comments?|feedback|critique|revision|revise)\b/.test(source)) {
      add('close feedback loop');
    }

    return hints.slice(0, 3);
  }

  function inferLectureCaptureHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(lecture|class recording|recorded class|transcript|transcription|caption|captions|slides?|video|podcast|seminar|webinar)\b/.test(source)) {
      add('summarize lecture notes');
    }
    if (/\b(action items?|todo|to[- ]?do|follow[- ]?ups?|next steps?|assigned in class|announcements?)\b/.test(source)) {
      add('extract action items');
    }
    if (/\b(confus(?:ed|ing|ion)|unclear|missed|absent|catch up|rewatch|review recording)\b/.test(source)) {
      add('mark unclear moments');
    }
    if (/\b(quiz|exam|midterm|final|test|study guide|review session)\b/.test(source)) {
      add('turn transcript into quiz');
    }

    return hints.slice(0, 3);
  }

  function inferSourceGroundingHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(sources?|references?|citations?|evidence|quote|quoted|primary source|paper|article|reading|case study)\b/.test(source)) {
      add('keep answers source-backed');
    }
    if (/\b(compare|contrast|synthesize|synthesis|multiple readings?|two papers?|several sources?|conflicting|perspectives?)\b/.test(source)) {
      add('compare source claims');
    }
    if (/\b(open[- ]?book|notes allowed|cheat sheet|study guide|reference sheet|source packet|notebook|notebooklm)\b/.test(source)) {
      add('build cited study guide');
    }
    if (/\b(unsupported|hallucination|verify|fact[- ]?check|grounded|source[- ]?grounded)\b/.test(source)) {
      add('verify unsupported claims');
    }

    return hints.slice(0, 3);
  }

  function inferTutorContextPackHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(rubric|requirements?|spec(?:ification)?|prompt|instructions?|criteria|checklist|deliverables?)\b/.test(source)) {
      add('attach rubric');
    }
    if (/\b(syllabus|schedule|module overview|learning objectives?|outcomes?|unit guide|course policy)\b/.test(source)) {
      add('include course context');
    }
    if (/\b(example|sample|template|starter code|starter repo|scaffold|provided files?|reference implementation)\b/.test(source)) {
      add('include examples');
    }
    if (/\b(previous feedback|instructor feedback|ta feedback|comments?|graded attempt|prior submission|resubmit|revision)\b/.test(source)) {
      add('include prior feedback');
    }

    return hints.slice(0, 3);
  }

  function inferStudyWrapUpHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(lecture|reading|chapter|slides?|paper|article|notes?|transcript|video|recording)\b/.test(source)) {
      add('save summary notes');
    }
    if (/\b(exam|midterm|final|test|quiz|practice|review|cumulative|comprehensive|flashcards?|spaced repetition|anki)\b/.test(source)) {
      add('schedule next review');
    }
    if (/\b(confus(?:ed|ing|ion)|unclear|weak spots?|stuck|blocked|office hours|ta\b|tutor|wrong answers?|mistakes?|missed questions?)\b/.test(source)) {
      add('capture open questions');
    }
    if (/\b(project|lab|implementation|coding|programming|debug|autograder|gradescope|repo|github)\b/.test(source)) {
      add('log next debugging step');
    }

    return hints.slice(0, 3);
  }

  function inferRubricScoringHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(rubric|criteria|requirements?|spec(?:ification)?|deliverables?|checklist|acceptance criteria)\b/.test(source)) {
      add('map work to rubric');
    }
    if (/\b(points?|pts?|score|grade|grading|weighted|percent(?:age)?|extra credit)\b/.test(source)) {
      add('prioritize high-point parts');
    }
    if (/\b(part\s*[a-d]|section\s*\d+|milestone|checkpoint|required|optional|stretch|bonus)\b/.test(source)) {
      add('separate required vs bonus');
    }
    if (/\b(self[- ]?check|test cases?|unit tests?|autograder|gradescope|validation|verify|proofread|review before submitting)\b/.test(source)) {
      add('run final self-check');
    }

    return hints.slice(0, 3);
  }

  function inferPreSubmitVerificationHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(upload|attach|file types?|file formats?|pdf|docx?|zip|slides?|screenshot|screen recording|video|artifact)\b/.test(source)) {
      add('verify correct file');
    }
    if (/\b(submit|submission|canvas|gradescope|autograder|submitty|codegrade|portal|upload)\b/.test(source)) {
      add('confirm submission receipt');
    }
    if (/\b(github|git\b|repo(?:sitory)?|commit|push|branch|pull request|pr\b|tag|release)\b/.test(source)) {
      add('push final commit');
    }
    if (/\b(readme|write[- ]?up|report|reflection|design doc|implementation notes?|citation|bibliograph(?:y|ies)|works cited)\b/.test(source)) {
      add('include required docs');
    }
    if (/\b(deadline|due|late policy|grace period|lock date|available until)\b/.test(source)) {
      add('save timestamp proof');
    }

    return hints.slice(0, 3);
  }

  function inferNotebookStudyPackHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(notebooklm|study guide|source packet|course packet|open[- ]?book|notes allowed|reference sheet|cheat sheet)\b/.test(source)) {
      add('assemble source pack');
    }
    if (/\b(lecture|slides?|transcript|recording|reading|chapter|paper|article|case study|primary source|lab manual)\b/.test(source)) {
      add('ground answers in notes');
    }
    if (/\b(quiz|exam|midterm|final|test|practice|review|study session)\b/.test(source)) {
      add('generate self-quiz');
    }
    if (/\b(citations?|references?|quote|evidence|claim|compare|contrast|synthesi[sz]e)\b/.test(source)) {
      add('trace claims to citations');
    }

    return hints.slice(0, 3);
  }

  function recommendNextStudyAction(items, nowMs = Date.now()) {
    const candidates = (Array.isArray(items) ? items : [])
      .filter(item => item && !item.done && Number.isFinite(Number(item.ts)))
      .map(item => {
        const ts = Number(item.ts);
        const hoursUntilDue = (ts - nowMs) / (60 * 60 * 1000);
        const triage = classifyDeadline({ ...item, ts }, nowMs);
        let score = 0;
        const reasons = [];

        if (hoursUntilDue < 0) { score += 100; reasons.push('overdue'); }
        else if (hoursUntilDue <= 24) { score += 80; reasons.push('due today'); }
        else if (hoursUntilDue <= 72) { score += 45; reasons.push('due soon'); }
        else { score += Math.max(0, 20 - hoursUntilDue / 24); }

        if (triage.effort === 'high') { score += 40; reasons.push('high effort'); }
        else if (triage.effort === 'quick') { score += 8; reasons.push('quick win'); }

        const sourceText = `${item.title || ''} ${item.description || item.text || item.content || ''}`.toLowerCase();
        if (/\b(not started|starter|draft|proposal|milestone|checkpoint|practice|review)\b/.test(sourceText)) {
          score += 10;
          reasons.push('needs progress');
        }

        return { item, ts, triage, score, reasons };
      })
      .sort((a, b) => b.score - a.score || a.ts - b.ts);

    if (!candidates.length) return null;
    const best = candidates[0];
    const title = String(best.item.title || 'upcoming deadline').trim();
    const course = String(best.item.courseName || best.item.course || '').trim();
    const verb = best.triage.effort === 'quick' ? 'Finish' : best.triage.effort === 'high' ? 'Do a 45-minute deep-work sprint on' : 'Spend 45 minutes on';
    const reason = best.reasons.length ? best.reasons.slice(0, 3).join(' + ') : 'highest priority';
    return {
      title,
      course,
      reason,
      action: `${verb} ${title}`,
      urgency: best.triage.urgency,
      effort: best.triage.effort,
      dueAt: best.ts,
      score: best.score
    };
  }

  function startOfLocalDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function buildWorkloadTimeline(items, nowMs = Date.now(), days = 7) {
    const safeDays = Math.max(1, Math.min(14, Number(days) || 7));
    const todayStart = startOfLocalDay(nowMs);
    const buckets = Array.from({ length: safeDays }, (_, offset) => {
      const start = todayStart + offset * MS_DAY;
      const d = new Date(start);
      return {
        start,
        label: d.toLocaleDateString(undefined, { weekday: 'short' }),
        dateLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        count: 0,
        highEffort: 0,
        quick: 0,
        isToday: offset === 0,
        load: 'empty'
      };
    });

    for (const item of (Array.isArray(items) ? items : [])) {
      if (!item || item.done) continue;
      const ts = Number(item.ts);
      if (!Number.isFinite(ts) || ts < todayStart || ts >= todayStart + safeDays * MS_DAY) continue;
      const bucket = buckets[Math.floor((ts - todayStart) / MS_DAY)];
      if (!bucket) continue;
      const triage = classifyDeadline({ ...item, ts }, nowMs);
      bucket.count += 1;
      if (triage.effort === 'high') bucket.highEffort += 1;
      if (triage.effort === 'quick') bucket.quick += 1;
    }

    return buckets.map(bucket => ({
      ...bucket,
      load: bucket.count === 0 ? 'empty' : bucket.count >= 4 || bucket.highEffort >= 2 ? 'heavy' : bucket.count >= 2 || bucket.highEffort === 1 ? 'medium' : 'light'
    }));
  }

  function renderWorkloadTimeline(items, list, nowMs = Date.now()) {
    const timeline = buildWorkloadTimeline(items, nowMs, 7);
    if (!timeline.some(day => day.count > 0)) return;

    const card = document.createElement('div');
    card.className = 'plan-workload-strip animate-fade-in';
    card.innerHTML = `
      <div class="plan-section-head"><span class="plan-section-title">7-day workload</span><span class="plan-section-meta">deadlines by day</span></div>
      <div class="plan-workload-days">
        ${timeline.map(day => `
          <div class="plan-workload-day is-${escapeHtml(day.load)}${day.isToday ? ' is-today' : ''}" title="${escapeHtml(day.dateLabel)}: ${day.count} deadline${day.count === 1 ? '' : 's'}${day.highEffort ? `, ${day.highEffort} high-effort` : ''}">
            <span class="plan-workload-label">${escapeHtml(day.label)}</span>
            <span class="plan-workload-count">${day.count}</span>
            <span class="plan-workload-date">${escapeHtml(day.dateLabel)}</span>
          </div>
        `).join('')}
      </div>
    `;
    list.appendChild(card);
  }

  function buildPlannerPrompt(deadlines, now = new Date()) {
    const nowMs = now.getTime();
    const lines = deadlines.slice(0, 15).map(d => {
      const triage = classifyDeadline(d, nowMs);
      const dueLabel = new Date(d.ts).toLocaleString();
      const evidence = compactDeadlineText(d);
      const checklist = inferSubmissionChecklist(d);
      const reviewHints = inferConceptReviewHints(d);
      const studyPhases = inferStudyPhases(d);
      const learningHints = inferLearningStrategyHints(d);
      const focusHints = inferFocusSprintHints(d);
      const practiceHints = inferPracticeArtifactHints(d);
      const retrievalHints = inferRetrievalCalibrationHints(d);
      const socraticHints = inferSocraticStudyHints(d);
      const teachBackHints = inferTeachBackHints(d);
      const integrityHints = inferAcademicIntegrityHints(d);
      const codeDebugHints = inferCodeDebugHints(d);
      const officeHoursHints = inferOfficeHoursPrepHints(d);
      const collaborationHints = inferCollaborationHandoffHints(d);
      const lectureHints = inferLectureCaptureHints(d);
      const sourceGroundingHints = inferSourceGroundingHints(d);
      const tutorContextHints = inferTutorContextPackHints(d);
      const wrapUpHints = inferStudyWrapUpHints(d);
      const rubricHints = inferRubricScoringHints(d);
      const preSubmitHints = inferPreSubmitVerificationHints(d);
      const notebookStudyPackHints = inferNotebookStudyPackHints(d);
      const riskFlags = inferPlannerRiskFlags(d, deadlines, nowMs);
      const checklistHint = checklist.length ? `; checklist: ${checklist.join(', ')}` : '';
      const reviewHint = reviewHints.length ? `; review: ${reviewHints.join(', ')}` : '';
      const learningHint = learningHints.length ? `; learning strategy: ${learningHints.join(', ')}` : '';
      const focusHint = focusHints.length ? `; focus sprint: ${focusHints.join(', ')}` : '';
      const practiceHint = practiceHints.length ? `; practice assets: ${practiceHints.join(', ')}` : '';
      const retrievalHint = retrievalHints.length ? `; retrieval calibration: ${retrievalHints.join(', ')}` : '';
      const socraticHint = socraticHints.length ? `; Socratic tutor mode: ${socraticHints.join(', ')}` : '';
      const teachBackHint = teachBackHints.length ? `; teach-back: ${teachBackHints.join(', ')}` : '';
      const integrityHint = integrityHints.length ? `; integrity: ${integrityHints.join(', ')}` : '';
      const codeDebugHint = codeDebugHints.length ? `; code/debug: ${codeDebugHints.join(', ')}` : '';
      const officeHoursHint = officeHoursHints.length ? `; office hours prep: ${officeHoursHints.join(', ')}` : '';
      const collaborationHint = collaborationHints.length ? `; collaboration handoff: ${collaborationHints.join(', ')}` : '';
      const lectureHint = lectureHints.length ? `; lecture capture: ${lectureHints.join(', ')}` : '';
      const sourceGroundingHint = sourceGroundingHints.length ? `; source grounding: ${sourceGroundingHints.join(', ')}` : '';
      const tutorContextHint = tutorContextHints.length ? `; tutor context pack: ${tutorContextHints.join(', ')}` : '';
      const wrapUpHint = wrapUpHints.length ? `; wrap-up: ${wrapUpHints.join(', ')}` : '';
      const rubricHint = rubricHints.length ? `; rubric scoring: ${rubricHints.join(', ')}` : '';
      const preSubmitHint = preSubmitHints.length ? `; pre-submit: ${preSubmitHints.join(', ')}` : '';
      const notebookStudyPackHint = notebookStudyPackHints.length ? `; notebook study pack: ${notebookStudyPackHints.join(', ')}` : '';
      const phaseHint = studyPhases.length ? `; suggested phases: ${studyPhases.join(', ')}` : '';
      const riskHint = riskFlags.length ? `; risk: ${riskFlags.join(', ')}` : '';
      const hint = `urgency=${triage.urgency}, effort=${triage.effort}${checklistHint}${reviewHint}${learningHint}${focusHint}${practiceHint}${retrievalHint}${socraticHint}${teachBackHint}${integrityHint}${codeDebugHint}${officeHoursHint}${collaborationHint}${lectureHint}${sourceGroundingHint}${tutorContextHint}${wrapUpHint}${rubricHint}${preSubmitHint}${notebookStudyPackHint}${phaseHint}${riskHint}`;
      return `- "${d.title}" (${d.courseName || 'General'}) due ${dueLabel}; ${hint}${evidence ? `; notes: ${evidence}` : ''}`;
    }).join('\n');

    return `You are an academic planner. Today is ${now.toLocaleString()}.\n` +
      `Here are the student's upcoming deadlines, including local triage hints and source notes when available:\n${lines}\n\n` +
      `Propose 4-8 study blocks between now and the last deadline. Prioritize overdue/today items first, split high-effort items (essays, projects, exams) into multiple blocks (e.g. outline, draft, practice, review), keep quick items lightweight, and use the notes as source grounding instead of inventing requirements. Schedule blocks before their deadline, between 09:00 and 21:00 local time, 60-120 minutes each, leaving at least 30 minutes before a due time for submission checks and handoff.\n` +
      `Return ONLY a valid JSON array, no prose, each element: {"title": string, "startAt": ISO datetime string, "minutes": number, "course": string}.`;
  }

  function renderDeadlineList(items) {
    const list = $('plan-deadline-list');
    const count = $('plan-deadline-count');
    if (!list) return;
    list.innerHTML = '';
    if (count) count.textContent = items.length ? `${items.length} dated` : '';

    if (!items.length) {
      list.innerHTML = '<div class="plan-empty">No dated work in the next two weeks. Enjoy the calm.</div>';
      return;
    }

    const now = Date.now();
    renderWorkloadTimeline(items, list, now);

    const recommendation = recommendNextStudyAction(items, now);
    if (recommendation) {
      const next = document.createElement('div');
      next.className = 'plan-deadline-row plan-next-action animate-fade-in';
      next.innerHTML = `
        <span class="plan-deadline-date">NEXT</span>
        <span class="plan-deadline-title">${escapeHtml(recommendation.action)}</span>
        <span class="plan-deadline-course">${escapeHtml(recommendation.course)}</span>
        <span class="plan-deadline-triage" title="Recommended because ${escapeHtml(recommendation.reason)}">${escapeHtml(recommendation.reason)}</span>
      `;
      list.appendChild(next);
    }

    items.slice(0, 12).forEach((item, i) => {
      const row = document.createElement(item.url ? 'button' : 'div');
      row.className = 'plan-deadline-row stagger-in';
      row.style.animationDelay = `${Math.min(i * 28, 280)}ms`;
      const overdue = item.ts < now;
      const dateLabel = new Date(item.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const triage = classifyDeadline(item, now);
      const effortLabel = triage.effort === 'high' ? 'deep work' : triage.effort;
      const checklist = inferSubmissionChecklist(item);
      const reviewHints = inferConceptReviewHints(item);
      const learningHints = inferLearningStrategyHints(item);
      const focusHints = inferFocusSprintHints(item);
      const practiceHints = inferPracticeArtifactHints(item);
      const retrievalHints = inferRetrievalCalibrationHints(item);
      const socraticHints = inferSocraticStudyHints(item);
      const teachBackHints = inferTeachBackHints(item);
      const integrityHints = inferAcademicIntegrityHints(item);
      const codeDebugHints = inferCodeDebugHints(item);
      const officeHoursHints = inferOfficeHoursPrepHints(item);
      const collaborationHints = inferCollaborationHandoffHints(item);
      const lectureHints = inferLectureCaptureHints(item);
      const sourceGroundingHints = inferSourceGroundingHints(item);
      const tutorContextHints = inferTutorContextPackHints(item);
      const wrapUpHints = inferStudyWrapUpHints(item);
      const rubricHints = inferRubricScoringHints(item);
      const preSubmitHints = inferPreSubmitVerificationHints(item);
      const notebookStudyPackHints = inferNotebookStudyPackHints(item);
      const riskFlags = inferPlannerRiskFlags(item, items, now);
      const checklistLabel = riskFlags.length ? `Risk: ${riskFlags.join(' · ')}` : (checklist.length ? checklist.join(' · ') : `${triage.urgency} · ${effortLabel}`);
      const reviewLabel = [
        reviewHints.length ? `Review: ${reviewHints.join(' · ')}` : '',
        codeDebugHints.length ? `Debug: ${codeDebugHints.join(' · ')}` : '',
        officeHoursHints.length ? `Office hours: ${officeHoursHints.join(' · ')}` : '',
        collaborationHints.length ? `Handoff: ${collaborationHints.join(' · ')}` : '',
        lectureHints.length ? `Lecture: ${lectureHints.join(' · ')}` : '',
        sourceGroundingHints.length ? `Sources: ${sourceGroundingHints.join(' · ')}` : '',
        tutorContextHints.length ? `Context: ${tutorContextHints.join(' · ')}` : '',
        wrapUpHints.length ? `Wrap-up: ${wrapUpHints.join(' · ')}` : '',
        rubricHints.length ? `Rubric: ${rubricHints.join(' · ')}` : '',
        preSubmitHints.length ? `Pre-submit: ${preSubmitHints.join(' · ')}` : '',
        notebookStudyPackHints.length ? `Notebook pack: ${notebookStudyPackHints.join(' · ')}` : '',
        focusHints.length ? `Focus: ${focusHints.join(' · ')}` : '',
        practiceHints.length ? `Practice: ${practiceHints.join(' · ')}` : '',
        retrievalHints.length ? `Recall: ${retrievalHints.join(' · ')}` : '',
        socraticHints.length ? `Tutor mode: ${socraticHints.join(' · ')}` : '',
        teachBackHints.length ? `Teach-back: ${teachBackHints.join(' · ')}` : '',
        learningHints.length ? `Study: ${learningHints.join(' · ')}` : '',
        integrityHints.length ? `Integrity: ${integrityHints.join(' · ')}` : ''
      ].find(Boolean) || '';
      row.dataset.urgency = triage.urgency;
      row.dataset.effort = triage.effort;
      row.innerHTML = `
        <span class="plan-deadline-date${overdue ? ' is-overdue' : ''}">${overdue ? 'OVERDUE' : dateLabel}</span>
        <span class="plan-deadline-title">${escapeHtml(item.title)}</span>
        <span class="plan-deadline-course">${escapeHtml(item.courseName || '')}</span>
        <span class="plan-deadline-triage" title="Planner triage: ${escapeHtml(triage.urgency)} / ${escapeHtml(effortLabel)}${riskFlags.length ? `; risk flags: ${escapeHtml(riskFlags.join(', '))}` : ''}${checklist.length ? `; suggested checks: ${escapeHtml(checklist.join(', '))}` : ''}${reviewHints.length ? `; concepts to review: ${escapeHtml(reviewHints.join(', '))}` : ''}${codeDebugHints.length ? `; code/debug help: ${escapeHtml(codeDebugHints.join(', '))}` : ''}${officeHoursHints.length ? `; office hours prep: ${escapeHtml(officeHoursHints.join(', '))}` : ''}${collaborationHints.length ? `; collaboration handoff: ${escapeHtml(collaborationHints.join(', '))}` : ''}${lectureHints.length ? `; lecture capture: ${escapeHtml(lectureHints.join(', '))}` : ''}${sourceGroundingHints.length ? `; source grounding: ${escapeHtml(sourceGroundingHints.join(', '))}` : ''}${tutorContextHints.length ? `; tutor context pack: ${escapeHtml(tutorContextHints.join(', '))}` : ''}${wrapUpHints.length ? `; wrap-up: ${escapeHtml(wrapUpHints.join(', '))}` : ''}${rubricHints.length ? `; rubric scoring: ${escapeHtml(rubricHints.join(', '))}` : ''}${preSubmitHints.length ? `; pre-submit verification: ${escapeHtml(preSubmitHints.join(', '))}` : ''}${focusHints.length ? `; focus sprint: ${escapeHtml(focusHints.join(', '))}` : ''}${practiceHints.length ? `; practice assets: ${escapeHtml(practiceHints.join(', '))}` : ''}${retrievalHints.length ? `; retrieval calibration: ${escapeHtml(retrievalHints.join(', '))}` : ''}${socraticHints.length ? `; Socratic tutor mode: ${escapeHtml(socraticHints.join(', '))}` : ''}${teachBackHints.length ? `; teach-back: ${escapeHtml(teachBackHints.join(', '))}` : ''}${learningHints.length ? `; study strategy: ${escapeHtml(learningHints.join(', '))}` : ''}${integrityHints.length ? `; integrity checks: ${escapeHtml(integrityHints.join(', '))}` : ''}">${escapeHtml(reviewLabel || checklistLabel)}</span>
      `;
      if (item.url) row.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
      list.appendChild(row);
    });
  }

  /**
   * Robust JSON-array extraction — same defensive strategy as the syllabus
   * autopilot in academic-tools.js: strip markdown fences, then fall back to
   * string-aware brace counting so truncated tails don't lose earlier items.
   */
  function extractJsonArray(raw) {
    let text = String(raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* fall through to scanning */ }

    const start = text.indexOf('[');
    if (start === -1) return [];
    const objects = [];
    let depth = 0, objStart = -1, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try { objects.push(JSON.parse(text.slice(objStart, i + 1))); } catch (_) { /* skip bad fragment */ }
          objStart = -1;
        }
      }
    }
    return objects;
  }

  function toLocalInputValue(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function nextStudyWindowStart(nowMs) {
    const d = new Date(nowMs);
    d.setSeconds(0, 0);
    const hour = d.getHours();
    if (hour < 9) {
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    if (hour >= 21) {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    return d.getTime() + 30 * 60 * 1000;
  }

  function alignToStudyHours(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return NaN;
    d.setSeconds(0, 0);
    const hour = d.getHours();
    if (hour < 9) {
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    if (hour >= 21) {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    return d.getTime();
  }

  function nextStudyBlockStart(candidateMs, earliestMs) {
    let start = Math.max(Number(candidateMs) || 0, Number(earliestMs) || 0);
    for (let i = 0; i < 3; i++) {
      const aligned = alignToStudyHours(start);
      if (!Number.isFinite(aligned)) return NaN;
      if (aligned >= start) return aligned;
      start = Math.max(aligned, earliestMs);
    }
    return alignToStudyHours(start);
  }

  function normalizeStudyBlocks(rawBlocks, deadlines, nowMs = Date.now()) {
    const deadlineTimes = (Array.isArray(deadlines) ? deadlines : [])
      .map(item => Number(item && item.ts))
      .filter(Number.isFinite);
    const lastDeadline = deadlineTimes.length ? Math.max(...deadlineTimes) : nowMs + 14 * MS_DAY;
    const fallbackStart = nextStudyWindowStart(nowMs);
    let cursor = fallbackStart;
    const normalized = [];

    for (const block of (Array.isArray(rawBlocks) ? rawBlocks : [])) {
      if (!block || !block.title) continue;
      const requestedMinutes = Math.max(30, Math.min(120, Number(block.minutes) || 60));
      const parsedStart = new Date(block.startAt).getTime();
      const requestedStart = Number.isFinite(parsedStart) && parsedStart > nowMs ? parsedStart : cursor;
      const startAt = nextStudyBlockStart(requestedStart, cursor);
      const latestEnd = lastDeadline - DEADLINE_HANDOFF_BUFFER_MINUTES * 60 * 1000;
      if (!Number.isFinite(startAt) || startAt > latestEnd) continue;
      const availableMinutes = Math.floor((latestEnd - startAt) / 60000);
      if (availableMinutes < 30) continue;
      const minutes = Math.min(requestedMinutes, availableMinutes);
      normalized.push({
        title: String(block.title).trim(),
        startAt: new Date(startAt).toISOString(),
        minutes,
        course: String(block.course || '').trim()
      });
      cursor = startAt + (minutes + 15) * 60 * 1000;
      if (normalized.length >= 10) break;
    }

    return normalized;
  }

  function buildFallbackStudyBlocks(deadlines, nowMs = Date.now()) {
    const items = (Array.isArray(deadlines) ? deadlines : [])
      .filter(item => item && Number.isFinite(Number(item.ts)) && Number(item.ts) > nowMs)
      .slice()
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    let cursor = nextStudyWindowStart(nowMs);
    const blocks = [];

    for (const item of items) {
      const triage = classifyDeadline(item, nowMs);
      const latestEnd = Number(item.ts) - DEADLINE_HANDOFF_BUFFER_MINUTES * 60 * 1000;
      const inferredPhases = inferStudyPhases(item);
      const phases = inferredPhases.length
        ? inferredPhases
        : (triage.effort === 'high'
          ? ['Outline and unblock', 'Deep work']
          : [triage.effort === 'quick' ? 'Finish' : 'Work on']);
      const minutes = triage.effort === 'high' ? 90 : triage.effort === 'quick' ? 45 : 60;

      for (const phase of phases) {
        const startAt = nextStudyBlockStart(cursor, cursor);
        if (!Number.isFinite(startAt) || startAt > latestEnd) break;
        const availableMinutes = Math.floor((latestEnd - startAt) / 60000);
        if (availableMinutes < 30) break;
        const blockMinutes = Math.min(minutes, availableMinutes);
        blocks.push({
          title: `${phase}: ${String(item.title || 'upcoming deadline').trim()}`,
          startAt: new Date(startAt).toISOString(),
          minutes: blockMinutes,
          course: String(item.courseName || item.course || '').trim()
        });
        cursor = startAt + (blockMinutes + 15) * 60 * 1000;
        if (blocks.length >= 8) return blocks;
      }
    }

    return blocks;
  }

  async function draftWeek() {
    if (busy) return;
    busy = true;
    const btn = $('btn-draft-week');
    const output = $('plan-output');
    if (btn) btn.disabled = true;
    output.innerHTML = `
      <div class="plan-drafting">
        <div class="stream-loader"><div class="stream-dot"></div><div class="stream-dot"></div><div class="stream-dot"></div></div>
        <span>Reading your deadlines and drafting study blocks…</span>
      </div>
    `;

    try {
      const ready = await AIRouter.ensureReady();
      if (!ready.ok) {
        output.innerHTML = `<div class="plan-empty">AI route unavailable. Sign in from the popup to enable cloud fallback.</div>`;
        return;
      }

      const deadlines = await loadDeadlines();
      if (!deadlines.length) {
        output.innerHTML = `<div class="plan-empty">Nothing to plan — no dated work in the next two weeks.</div>`;
        return;
      }

      const today = new Date();
      const prompt = buildPlannerPrompt(deadlines, today);

      // Profile rides in system only; the prompt stays strict-JSON-focused.
      const profileBlock = (window.StudentProfile && StudentProfile.compileContextBlock()) || '';
      const raw = await AIRouter.complete(prompt, profileBlock
        ? { system: AIRouter.getState().systemInstruction + profileBlock }
        : {});
      let blocks = normalizeStudyBlocks(extractJsonArray(raw), deadlines, Date.now());
      if (!blocks.length) {
        blocks = buildFallbackStudyBlocks(deadlines, Date.now());
      }

      if (!blocks.length) {
        output.innerHTML = `<div class="plan-empty">Couldn't draft a plan from the model output. Try again.</div>`;
        return;
      }

      renderChecklist(blocks);
    } catch (err) {
      console.error('[Canvascope Planner] Draft failed:', err);
      output.innerHTML = `<div class="plan-empty">Planning failed: ${escapeHtml(err.message || String(err))}</div>`;
    } finally {
      if (btn) btn.disabled = false;
      busy = false;
    }
  }

  function renderChecklist(blocks) {
    const output = $('plan-output');
    output.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'plan-checklist animate-fade-in';
    card.innerHTML = `<div class="plan-section-head"><span class="plan-section-title">Proposed study blocks</span><span class="plan-section-meta">edit before saving</span></div>`;

    const rows = [];
    blocks.forEach((block, i) => {
      const row = document.createElement('div');
      row.className = 'plan-check-row stagger-in';
      row.style.animationDelay = `${Math.min(i * 28, 280)}ms`;
      row.innerHTML = `
        <input type="checkbox" class="plan-check" checked>
        <div class="plan-check-fields">
          <input type="text" class="plan-check-title" value="${escapeHtml(block.title)}">
          <div class="plan-check-meta">
            <input type="datetime-local" class="plan-check-when" value="${toLocalInputValue(block.startAt)}">
            <span class="plan-check-course">${escapeHtml(block.course || '')}</span>
            <span class="plan-check-mins">${Number(block.minutes) || 60}m</span>
          </div>
        </div>
      `;
      rows.push({ row, block });
      card.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'plan-save-row';
    actions.innerHTML = `
      <label class="plan-cal-toggle"><input type="checkbox" id="plan-cal-sync"> Sync to Google Calendar</label>
      <label class="plan-cal-toggle"><input type="checkbox" id="plan-remind" checked> Remind me</label>
      <button id="btn-save-plan" class="btn-plan-primary">Save blocks</button>
    `;
    card.appendChild(actions);
    output.appendChild(card);

    actions.querySelector('#btn-save-plan').addEventListener('click', async () => {
      const saveBtn = actions.querySelector('#btn-save-plan');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const calSync = actions.querySelector('#plan-cal-sync').checked;
      const remind = actions.querySelector('#plan-remind').checked;

      let saved = 0, calOk = 0, calFail = 0;
      const { customTodos = [] } = await chrome.storage.local.get(['customTodos']);

      for (const { row, block } of rows) {
        if (!row.querySelector('.plan-check').checked) continue;
        const title = row.querySelector('.plan-check-title').value.trim() || block.title;
        const whenVal = row.querySelector('.plan-check-when').value;
        const startTs = whenVal ? new Date(whenVal).getTime() : new Date(block.startAt).getTime();
        if (!Number.isFinite(startTs)) continue;
        const minutes = Number(block.minutes) || 60;

        // Same shape academic-tools addTodo writes — keeps /todo + sync + RAG happy.
        customTodos.push({
          id: `todo_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`,
          title,
          dueAt: startTs,
          courseId: null,
          color: null,
          done: false,
          createdAt: Date.now()
        });
        saved++;

        if (calSync) {
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'createGoogleCalendarEvent',
              event: {
                summary: title,
                description: `Canvascope study block${block.course ? ` — ${block.course}` : ''}`,
                start: { dateTime: new Date(startTs).toISOString() },
                end: { dateTime: new Date(startTs + minutes * 60 * 1000).toISOString() }
              }
            }, (response) => { void chrome.runtime.lastError; resolve(response || { success: false }); });
          });
          if (res.success) calOk++; else calFail++;
        }

        if (remind) {
          chrome.runtime.sendMessage({
            action: 'csReminders.scheduleOnce',
            title: `Study block: ${title}`,
            body: 'Scheduled by Canvascope Smart Planner',
            at: Math.max(startTs - 15 * 60 * 1000, Date.now() + 60 * 1000)
          }, () => { void chrome.runtime.lastError; });
        }
      }

      await chrome.storage.local.set({ customTodos });
      // Mirror to Supabase (best-effort, same path /todo uses).
      chrome.runtime.sendMessage({ action: 'csTools.push' }, () => { void chrome.runtime.lastError; });

      let summary = `**Saved ${saved} study block${saved === 1 ? '' : 's'}** to your /todo list.`;
      if (calSync) summary += ` Calendar: ${calOk} created${calFail ? `, ${calFail} failed` : ''}.`;
      if (remind && saved) summary += ' Reminders set for 15 minutes before each block.';
      output.insertAdjacentHTML('beforeend', `<div class="plan-save-result animate-fade-in">${deps.markdown(summary)}</div>`);
      saveBtn.textContent = 'Saved ✓';
      refresh();
    });
  }

  async function refresh() {
    const items = await loadDeadlines();
    renderRadar(items);
    renderDeadlineList(items);
  }

  function init(dependencies) {
    deps = dependencies;
    const btn = $('btn-draft-week');
    if (btn) btn.addEventListener('click', draftWeek);
    refresh();
  }

  window.SmartPlanner = {
    init,
    refresh,
    draftWeek,
    __test: { classifyDeadline, compactDeadlineText, inferSubmissionChecklist, inferConceptReviewHints, inferSubmissionStatusFlags, inferPlannerRiskFlags, inferStudyPhases, inferLearningStrategyHints, inferFocusSprintHints, inferPracticeArtifactHints, inferRetrievalCalibrationHints, inferSocraticStudyHints, inferTeachBackHints, inferAcademicIntegrityHints, inferCodeDebugHints, inferOfficeHoursPrepHints, inferCollaborationHandoffHints, inferLectureCaptureHints, inferSourceGroundingHints, inferTutorContextPackHints, inferStudyWrapUpHints, inferRubricScoringHints, inferPreSubmitVerificationHints, inferNotebookStudyPackHints, recommendNextStudyAction, buildWorkloadTimeline, buildPlannerPrompt, extractJsonArray, nextStudyWindowStart, normalizeStudyBlocks, buildFallbackStudyBlocks, toLocalInputValue }
  };
})();
