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

  function inferAssignmentResourceLinks(item) {
    const source = String(item?.description || item?.text || item?.content || item?.url || '');
    const urlPattern = /https?:\/\/[^\s<>)"']+/gi;
    const links = [];
    const seen = new Set();
    const add = (label, url) => {
      const cleanUrl = String(url || '').replace(/[.,;:!?]+$/g, '');
      const key = cleanUrl.toLowerCase();
      if (!cleanUrl || seen.has(key)) return;
      seen.add(key);
      links.push({ label, url: cleanUrl });
    };

    for (const match of source.matchAll(urlPattern)) {
      const url = match[0].replace(/[.,;:!?]+$/g, '');
      const lower = url.toLowerCase();
      if (/github\.com|gitlab\.com|bitbucket\.org/.test(lower)) add('repo', url);
      else if (/classroom\.github\.com/.test(lower)) add('repo', url);
      else if (/gradescope\.com|submitty|codegrade|autograder/.test(lower)) add('autograder', url);
      else if (/notebooklm\.google\.com|quizlet\.com|coconote\.app/.test(lower)) add('ai study guide', url);
      else if (/classroom\.google\.com/.test(lower)) add('classroom', url);
      else if (/\.zip(?:$|[?#])|starter|template|scaffold|dataset|data[-_]?set|drive\.google\.com|docs\.google\.com|colab\.research\.google\.com|jupyter\.org|replit\.com/.test(lower)) add('starter/material', url);
    }

    return links.slice(0, 4);
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

  function getSubmissionSnapshot(item) {
    const submission = item?.submission || item?.submissionStatus || item?.submission_status || {};
    const workflowState = String(submission.workflow_state || submission.workflowState || item?.workflowState || item?.workflow_state || '').toLowerCase();
    const submittedAt = submission.submitted_at || submission.submittedAt || item?.submittedAt || item?.submitted_at;
    const hasSubmission = Boolean(submittedAt || submission.submission_type || submission.submissionType || submission.url || submission.attachments?.length || item?.submitted === true);
    const gradedAt = submission.graded_at || submission.gradedAt || item?.gradedAt || item?.graded_at;
    const score = submission.score ?? item?.score ?? item?.grade;
    const isSubmitted = hasSubmission || workflowState === 'submitted' || workflowState === 'graded' || Boolean(gradedAt || score != null);
    return { submission, workflowState, submittedAt, hasSubmission, gradedAt, score, isSubmitted };
  }

  function classifyActionBucket(item, nowMs = Date.now()) {
    const { workflowState, isSubmitted } = getSubmissionSnapshot(item);
    const ts = Number(item && item.ts);
    if (isSubmitted || item?.done === true || /graded|complete|submitted/.test(workflowState)) return 'submitted';
    if (!Number.isFinite(ts)) return 'no due date';
    if (ts < nowMs || workflowState === 'unsubmitted' || item?.missing === true) return 'overdue';
    if (ts <= nowMs + 7 * MS_DAY) return 'due soon';
    return 'later';
  }

  function inferSubmissionStatusFlags(item, nowMs = Date.now()) {
    const flags = [];
    const add = (label) => { if (!flags.includes(label)) flags.push(label); };
    const { submission, workflowState, hasSubmission, gradedAt, score } = getSubmissionSnapshot(item);
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

  function getAssignmentPointValue(item) {
    const explicitPoints = Number(item?.pointsPossible ?? item?.points ?? item?.points_possible ?? item?.maxPoints);
    if (Number.isFinite(explicitPoints)) return explicitPoints;
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const textPointMatches = Array.from(source.matchAll(/\b(\d{1,4})\s*(?:pts?|points?)\b/g), match => Number(match[1]))
      .filter(Number.isFinite);
    return textPointMatches.length ? Math.max(...textPointMatches) : NaN;
  }

  function inferGradeImpactHints(item) {
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };
    const pointValue = getAssignmentPointValue(item);
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();

    if (Number.isFinite(pointValue)) {
      if (pointValue >= 100) add(`${pointValue} pts: high grade impact`);
      else if (pointValue >= 50) add(`${pointValue} pts: meaningful grade impact`);
      else if (pointValue <= 10) add(`${pointValue} pts: quick points`);
    }
    if (/\b(extra credit|bonus points?)\b/.test(source)) add('bonus opportunity');
    if (/\b(drop lowest|dropped score|replacement score|make[- ]?up|retake|resubmit|revision|revisions)\b/.test(source)) add('grade recovery path');
    if (/\b(missing|late penalty|deduct|penalty|grace period|lock date)\b/.test(source)) add('protect against penalties');

    return hints.slice(0, 3);
  }

  function inferPlannerRiskFlags(item, peers = [], nowMs = Date.now()) {
    const flags = [];
    const add = (label) => { if (!flags.includes(label)) flags.push(label); };
    const ts = Number(item && item.ts);
    const hoursUntilDue = Number.isFinite(ts) ? (ts - nowMs) / (60 * 60 * 1000) : Infinity;
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hasSourceNotes = Boolean(String(item?.description || item?.text || item?.content || '').trim());
    const pointValue = getAssignmentPointValue(item);

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
    const needsSourcePack = /\b(open[- ]?(book|note|notes)|notes? allowed|source packet|course packet|notebooklm|study guide|reference sheet|cheat sheet|formula sheet|crib sheet)\b/.test(source);
    if (/\b(exam|midterm|final|test)\b/.test(source) && !isProjectLike) {
      if (needsSourcePack) add('Build source pack');
      add('Active recall drill');
      add('Practice problems');
      add('Review weak spots');
    } else if (isProjectLike) {
      add('Outline and unblock');
      add('Build or solve');
      add('Test and submit');
    } else if (/\b(problem set|pset|homework|practice problems?|worksheet|coding challenge|leetcode)\b/.test(source)) {
      add('Attempt first pass');
      add('Check examples');
      add('Log mistakes');
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

  function inferExecutionPlanHints(item, nowMs = Date.now()) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const ts = Number(item && item.ts);
    const hoursUntilDue = Number.isFinite(ts) ? (ts - nowMs) / (60 * 60 * 1000) : Infinity;
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(project|portfolio|capstone|milestone|implementation|coding|programming|lab|autograder|gradescope|repo|github)\b/.test(source)) {
      add('read spec and clone starter');
      add('implement core path');
      add('test and submit early');
    } else if (/\b(essay|paper|research|report|write[- ]?up|presentation|slides?)\b/.test(source)) {
      add('outline claim and evidence');
      add('draft rough version');
      add('revise and cite');
    } else if (/\b(exam|midterm|final|test)\b/.test(source)) {
      add('triage weak units');
      add('practice under time');
      add('review misses');
    }

    if (hoursUntilDue <= 36 && hints.length) add('submit safety buffer');

    return hints.slice(0, 4);
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

  function inferPrivacyConsentHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(record(?:ing)?|transcri(?:be|pt|ption)|caption(?:s)?|lecture capture|voice note|audio|video|zoom|meet|teams)\b/.test(source)) {
      add('confirm recording consent');
    }
    if (/\b(classmates?|peers?|group|team|partner|interview|participant|discussion|seminar|meeting)\b/.test(source)) {
      add('avoid private peer details');
    }
    if (/\b(ai note[- ]?tak(?:er|ing)|notebooklm|chatgpt|claude|gemini|llm|assistant|upload(?:ing)? notes?|cloud transcription)\b/.test(source)) {
      add('check AI data sharing');
    }
    if (/\b(privacy|consent|ferpa|confidential|sensitive|personal data|pii|student data|anonymi[sz]e)\b/.test(source)) {
      add('redact sensitive context');
    }

    return hints.slice(0, 3);
  }

  function inferAccessibilityStudyHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(captions?|closed captions?|transcript|transcription|audio|video|recording|lecture capture|screen reader)\b/.test(source)) {
      add('keep transcript accessible');
    }
    if (/\b(accessibility|accessible|accommodation(?:s)?|disability|alt text|keyboard navigation|screen reader|assistive)\b/.test(source)) {
      add('respect accommodations');
    }
    if (/\b(slides?|diagrams?|figures?|charts?|graphs?|images?|screenshots?|visuals?|whiteboard)\b/.test(source)) {
      add('add visual descriptions');
    }
    if (/\b(noisy|hard to hear|inaudible|blurry|low quality|missing transcript|caption errors?|transcript errors?)\b/.test(source)) {
      add('verify capture quality');
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

  function inferMinimalReproHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(debug|bug|failing|failure|regression|wrong answer|not working|error|exception|traceback|stack trace|segfault|compile error|runtime error)\b/.test(source)) {
      add('make minimal repro');
    }
    if (/\b(input|output|expected|actual|sample case|test case|counterexample|edge case|boundary case)\b/.test(source)) {
      add('record expected vs actual');
    }
    if (/\b(autograder|gradescope|hidden tests?|public tests?|unit tests?|pytest|junit|assert(?:ion)?|failing tests?)\b/.test(source)) {
      add('isolate one failing test');
    }
    if (/\b(ai|chatgpt|claude|gemini|copilot|cursor|llm|assistant|tutor|office hours|ta\b)\b/.test(source)) {
      add('share repro before asking');
    }

    return hints.slice(0, 3);
  }

  function inferAutograderFeedbackHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(autograder|gradescope|codegrade|submitty|hidden tests?|public tests?|unit tests?|pytest|junit|assert(?:ion)?|wrong answer|time limit|memory limit)\b/.test(source)) {
      add('summarize failing tests');
    }
    if (/\b(stderr|stdout|stack trace|traceback|exception|segfault|compile error|syntaxerror|typeerror|referenceerror|runtime error)\b/.test(source)) {
      add('capture error evidence');
    }
    if (/\b(rubric|score|points?|partial credit|deduct(?:ed|ion)?|lost points?|feedback|comments?)\b/.test(source)) {
      add('map feedback to fixes');
    }
    if (/\b(resubmit|resubmission|retry|attempts?|deadline|late|penalty|grace period)\b/.test(source)) {
      add('plan resubmit window');
    }

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

  function inferLectureActionChecklistHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };
    const isLectureSource = /\b(lecture|class recording|recorded class|transcript|transcription|caption|captions|slides?|seminar|review session|announcement|announcements?)\b/.test(source);

    if (isLectureSource && /\b(action items?|todo|to[- ]?do|follow[- ]?ups?|next steps?|assigned|homework|reading|problem set|pset)\b/.test(source)) {
      add('extract dated task checklist');
    }
    if (isLectureSource && /\b(due|deadline|by\s+(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|next week|exam|midterm|final|project|quiz)\b/.test(source)) {
      add('capture mentioned deadlines');
    }
    if (isLectureSource && /\b(canvas|assignment|module|rubric|submission|gradescope|reading|chapter|worksheet|lab)\b/.test(source)) {
      add('link tasks to Canvas items');
    }
    if (isLectureSource && /\b(question|questions|confus(?:ed|ing|ion)|unclear|office hours|ta\b|tutor|review session)\b/.test(source)) {
      add('queue follow-up questions');
    }

    return hints.slice(0, 3);
  }

  function inferSourceCoverageAuditHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(ai note[- ]?tak(?:er|ing)|auto[- ]?notes?|summary|summari[sz]e|transcript|transcription|caption(?:s)?|notebooklm|coconote|chatgpt|claude|gemini|llm|assistant)\b/.test(source)) {
      add('audit source coverage');
    }
    if (/\b(slides?|deck|lecture notes?|reading|chapter|paper|article|handout|whiteboard|board work|demo|code walkthrough)\b/.test(source)) {
      add('cross-check against primary materials');
    }
    if (/\b(omitted|missing|skipped|not covered|incomplete|gap|gaps|low confidence|uncertain|hallucination|unsupported)\b/.test(source)) {
      add('flag coverage gaps');
    }
    if (/\b(key terms?|learning objectives?|objectives?|rubric|exam outline|study guide|question bank)\b/.test(source)) {
      add('map notes to objectives');
    }

    return hints.slice(0, 3);
  }

  function inferAiNoteQualityAuditHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(ai note[- ]?tak(?:er|ing)|auto[- ]?notes?|smart notes?|summary|summari[sz]e|transcript|transcription|caption(?:s)?|notebooklm|chatgpt|claude|gemini|llm|assistant)\b/.test(source)) {
      add('verify summary against source');
    }
    if (/\b(lecture|class recording|slides?|reading|chapter|paper|article|notes?|study guide|summary|transcript)\b/.test(source)) {
      add('convert summary to recall prompts');
    }
    if (/\b(confus(?:ed|ing|ion)|unclear|muddiest point|open questions?|question list|don'?t understand|weak spots?|gaps?)\b/.test(source)) {
      add('tag unanswered questions');
    }
    if (/\b(citations?|references?|page numbers?|timestamps?|time stamps?|source links?|evidence|quotes?)\b/.test(source)) {
      add('keep citation anchors');
    }

    return hints.slice(0, 3);
  }

  function inferConfusionCaptureHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(confus(?:ed|ing|ion)|unclear|muddiest point|stuck|lost|don'?t understand|hard topics?|weak spots?)\b/.test(source)) {
      add('capture confusion points');
    }
    if (/\b(lecture|class recording|recorded class|transcript|transcription|caption|captions|video|timestamp|time stamp|rewatch)\b/.test(source)) {
      add('save timestamped questions');
    }
    if (/\b(office hours|ta\b|tutor|study group|discussion section|recitation|review session)\b/.test(source)) {
      add('bring questions to help session');
    }
    if (/\b(ai tutor|assistant|chatgpt|claude|gemini|notebooklm|llm)\b/.test(source)) {
      add('ask tutor from exact notes');
    }

    return hints.slice(0, 3);
  }

  function inferAudioReviewHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(audio overview|audio recap|podcast|voice note|listen(?:ing)?|commute|walk review|recorded summary)\b/.test(source)) {
      add('queue audio recap');
    }
    if (/\b(lecture|slides?|transcript|recording|class capture|video)\b/.test(source)) {
      add('convert lecture to recap');
    }
    if (/\b(exam|midterm|final|quiz|review|study guide|cumulative|comprehensive)\b/.test(source)) {
      add('listen before practice');
    }
    if (/\b(confus(?:ed|ing|ion)|unclear|weak spots?|missed|absent|catch up)\b/.test(source)) {
      add('replay unclear sections');
    }

    return hints.slice(0, 3);
  }

  function inferTranscriptStudyGuideHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(transcript|transcription|captions?|lecture capture|recording|recorded lecture|class recording|video|audio)\b/.test(source)) {
      add('anchor notes to timestamps');
    }
    if (/\b(chapters?|segments?|sections?|timestamps?|time stamps?|outline|table of contents|topic shifts?)\b/.test(source)) {
      add('split into topic chapters');
    }
    if (/\b(notebooklm|coconote|ai note[- ]?tak(?:er|ing)|audio overview|audio recap|study guide|summary|quizlet|chatgpt|claude|gemini|llm)\b/.test(source)) {
      add('verify AI summary against transcript');
    }
    if (/\b(inaudible|caption errors?|transcript errors?|misheard|hard to hear|noisy|low quality|missing transcript|unclear audio)\b/.test(source)) {
      add('flag uncertain transcript spans');
    }

    return hints.slice(0, 3);
  }

  function inferMultimodalStudyAssetHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(diagrams?|figures?|charts?|graphs?|visuals?|whiteboard|board work|sketch(?:es)?|drawings?|maps?)\b/.test(source)) {
      add('capture visual diagram');
    }
    if (/\b(screenshot|screenshots|screen recording|demo video|walkthrough|ui|interface|prototype|figma|slides?)\b/.test(source)) {
      add('attach screenshots');
    }
    if (/\b(audio|recording|voice note|podcast|lecture capture|transcript|captions?)\b/.test(source)) {
      add('pair transcript with notes');
    }
    if (/\b(mind map|concept map|flowchart|timeline|sequence diagram|architecture diagram|system design)\b/.test(source)) {
      add('make concept map');
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

  function inferEvidencePackHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(research|paper|article|literature review|annotated bibliograph(?:y|ies)|case study|primary source|secondary source)\b/.test(source)) {
      add('collect quotable snippets');
    }
    if (/\b(citations?|references?|bibliograph(?:y|ies)|works cited|doi|page numbers?|quote|quoted|evidence|sources?)\b/.test(source)) {
      add('capture citation metadata');
    }
    if (/\b(claim|argument|thesis|support|counterargument|compare|contrast|synthesi[sz]e|conflicting|perspectives?)\b/.test(source)) {
      add('map claims to sources');
    }
    if (/\b(ai|chatgpt|claude|gemini|llm|notebooklm|assistant|ai tutor|source[- ]?grounded|grounded answers?)\b/.test(source)) {
      add('ask source-grounded questions');
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

  function inferFeedbackLoopHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(answer key|solutions?|worked solutions?|sample answers?|exemplar|model answer|official solution)\b/.test(source)) {
      add('compare against exemplar');
    }
    if (/\b(missed|wrong answers?|incorrect|mistakes?|error log|postmortem|reflection|review corrections?)\b/.test(source)) {
      add('log missed pattern');
    }
    if (/\b(retry|redo|second attempt|reattempt|practice again|spaced repetition|anki|flashcards?)\b/.test(source)) {
      add('schedule retry pass');
    }
    if (/\b(quiz|practice exam|mock exam|self[- ]?test|diagnostic)\b/.test(source)) {
      add('test before reviewing notes');
    }

    return hints.slice(0, 3);
  }

  function inferPortabilityBackupHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(export|backup|back up|archive|download|save a copy|portfolio|deliverables?|submission packet)\b/.test(source)) {
      add('export Markdown summary');
    }
    if (/\b(json|csv|spreadsheet|data|dataset|records?|metadata|gradebook|canvas export|import)\b/.test(source)) {
      add('keep structured JSON copy');
    }
    if (/\b(obsidian|notion|google docs?|drive|github|repo|repository|vs code|vscode|readme|markdown|md\b)\b/.test(source)) {
      add('save portable notes');
    }
    if (/\b(final|capstone|project|portfolio|presentation|demo|submission|resubmit|revision)\b/.test(source)) {
      add('snapshot before submit');
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

  function inferAvailabilityWindowHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(available from|available until|availability|opens?|unlocks?|access window|release date|visible after)\b/.test(source)) {
      add('check availability window');
    }
    if (/\b(lock date|locks?|closes?|close date|due until|available until|grace period|late policy|hard deadline)\b/.test(source)) {
      add('submit before lock');
    }
    if (/\b(time limit|timed|minutes? limit|attempts?|attempt limit|one attempt|single attempt|proctor(?:ed|ing)?|lockdown browser)\b/.test(source)) {
      add('budget timed attempt');
    }
    if (/\b(late penalty|deduct|penalty|no late|grace period|extension|late submissions?)\b/.test(source)) {
      add('avoid grace-period risk');
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

  function inferStudyPackArtifactHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(lecture|slides?|transcript|recording|reading|chapter|paper|article|notes?|study guide|review sheet)\b/.test(source)) {
      add('make key-term summary');
    }
    if (/\b(quiz|exam|midterm|final|test|practice|review|self[- ]?test|question bank)\b/.test(source)) {
      add('draft recall questions');
    }
    if (/\b(flashcards?|anki|quizlet|terms?|definitions?|vocab(?:ulary)?|memor(?:ize|ization))\b/.test(source)) {
      add('export flashcards');
    }
    if (/\b(confus(?:ed|ing|ion)|unclear|muddiest point|weak spots?|questions? for (?:ta|prof|professor|office hours)|don'?t understand)\b/.test(source)) {
      add('add confusion log');
    }

    return hints.slice(0, 3);
  }

  function inferReadingTriageHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(long reading|dense reading|textbook|chapter|paper|article|journal|case study|primary source|technical report|whitepaper|reading packet)\b/.test(source)) {
      add('skim structure first');
    }
    if (/\b(abstract|introduction|conclusion|section headings?|figures?|tables?|diagrams?|examples?)\b/.test(source)) {
      add('extract landmarks');
    }
    if (/\b(definitions?|terms?|vocab(?:ulary)?|theorem|lemma|concepts?|key ideas?|glossary)\b/.test(source)) {
      add('make mini glossary');
    }
    if (/\b(quote|evidence|argument|claim|compare|contrast|critique|response|discussion post|seminar)\b/.test(source)) {
      add('flag quotable claims');
    }

    return hints.slice(0, 3);
  }

  function inferLectureQuestionQueueHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(lecture|slides?|recording|transcript|caption(?:s)?|seminar|recitation|discussion section|class notes?)\b/.test(source)) {
      add('queue lecture questions');
    }
    if (/\b(confus(?:ed|ing|ion)|unclear|muddiest point|stuck|weak spots?|questions?|don'?t understand)\b/.test(source)) {
      add('tag unclear moments');
    }
    if (/\b(office hours|ta\b|professor|instructor|edstem|piazza|discussion board|study group)\b/.test(source)) {
      add('route questions to help channel');
    }
    if (/\b(ai note[- ]?tak(?:er|ing)|notebooklm|chatgpt|claude|gemini|llm|assistant|summary|summari[sz]e)\b/.test(source)) {
      add('ask AI for question prompts');
    }

    return hints.slice(0, 3);
  }

  function inferAiHandoffHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(ai|chatgpt|claude|gemini|copilot|cursor|llm|assistant|tutor|notebooklm)\b/.test(source)) {
      add('copy assignment brief');
    }
    if (/\b(rubric|requirements?|spec(?:ification)?|constraints?|instructions?|allowed tools?|ai policy|academic integrity)\b/.test(source)) {
      add('include constraints');
    }
    if (/\b(code|coding|programming|debug|bug|repo|repository|github|starter|autograder|gradescope|tests?)\b/.test(source)) {
      add('include failing context');
    }
    if (/\b(source|sources?|citation|evidence|reading|slides?|lecture|notes?|canvas|prompt|assignment page)\b/.test(source)) {
      add('cite Canvas source');
    }

    return hints.slice(0, 3);
  }

  function inferCsWorkflowHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(programming|coding|implementation|project|lab|assignment|starter code|starter repo|github|git\b|repo(?:sitory)?|autograder|gradescope|pytest|junit|npm test|unit tests?|java|python|c\+\+|javascript|typescript)\b/.test(source)) {
      add('read spec first');
    }
    if (/\b(starter code|starter repo|clone|setup|set up|environment|dependencies?|install|docker|makefile|package\.json|requirements\.txt)\b/.test(source)) {
      add('set up starter code');
    }
    if (/\b(ai pair|ai coding|vibe cod(?:e|ing)|chatgpt|claude|gemini|copilot|cursor|llm|assistant-generated|generated patch|model changes?)\b/.test(source)) {
      add('review AI diff');
    }
    if (/\b(implement|implementation|feature|algorithm|data structure|function|class|api|endpoint|component|logic)\b/.test(source)) {
      add('implement core path');
    }
    if (/\b(edge cases?|corner cases?|boundary cases?|inputs?|outputs?|constraints?|invalid input|empty input|null|overflow|underflow)\b/.test(source)) {
      add('list edge cases');
    }
    if (/\b(test cases?|tests?|unit tests?|pytest|junit|npm test|autograder|auto[- ]?grader|gradescope|submitty|codegrade|hidden tests?)\b/.test(source)) {
      add('run tests before submit');
    }
    if (/\b(submit|submission|upload|gradescope|autograder|canvas|commit|push|pull request|pr\b|repo(?:sitory)?)\b/.test(source)) {
      add('leave autograder buffer');
    }

    return hints.slice(0, 4);
  }

  function inferCommandSnippetHints(item) {
    const raw = `${item?.title || ''}\n${item?.description || item?.text || item?.content || ''}`;
    const source = raw.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/```|`\s*(?:npm|pnpm|yarn|node|python|python3|pip|pytest|java|javac|go|cargo|make|cmake|git|docker|xcodebuild|swift)\b/i.test(raw)) {
      add('extract runnable commands');
    }
    if (/\b(?:npm|pnpm|yarn|node|python3?|pip|pytest|java|javac|go test|cargo test|make|cmake|docker|xcodebuild|swift test)\b/.test(source)) {
      add('verify command sequence');
    }
    if (/\b(sample input|sample output|stdin|stdout|terminal|shell|command line|cli|console output|stack trace|traceback)\b/.test(source)) {
      add('save terminal evidence');
    }
    if (/\b(readme|how to run|run instructions?|setup instructions?|installation|environment variables?|\.env|requirements\.txt|package\.json|makefile)\b/.test(source)) {
      add('document run steps');
    }

    return hints.slice(0, 3);
  }

  function inferAssignmentSpecExtractionHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(spec(?:ification)?|requirements?|instructions?|prompt|deliverables?|acceptance criteria|must include|required)\b/.test(source)) {
      add('extract required deliverables');
    }
    if (/\b(input|output|stdin|stdout|i\/o|file format|csv|json|schema|api contract|expected format)\b/.test(source)) {
      add('capture input/output contract');
    }
    if (/\b(functions?|methods?|classes?|interfaces?|endpoints?|components?|modules?|files? to edit|starter files?)\b/.test(source)) {
      add('list code touchpoints');
    }
    if (/\b(constraints?|limits?|edge cases?|time complexity|space complexity|runtime|memory limit|allowed tools?|collaboration policy|late policy)\b/.test(source)) {
      add('record constraints and policies');
    }

    return hints.slice(0, 3);
  }

  function inferMilestoneDecompositionHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(milestones?|checkpoint|phase|part\s*[1-9]|multi[- ]?part|several steps?|multiple deliverables?|sprint|iteration)\b/.test(source)) {
      add('break into milestones');
    }
    if (/\b(deliverables?|must include|required|requirements?|rubric|acceptance criteria|submission checklist|include a|attach|upload)\b/.test(source)) {
      add('make deliverable checklist');
    }
    if (/\b(before|after|then|first|next|finally|depends on|prereq(?:uisite)?|blocked by|sequence|order)\b/.test(source)) {
      add('order dependent steps');
    }
    if (/\b(draft|proposal|outline|implementation|prototype|test(?:ing)?|debug(?:ging)?|revision|reflection|demo|presentation)\b/.test(source)) {
      add('separate build/test/polish');
    }

    return hints.slice(0, 3);
  }

  function inferRequirementClarificationHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(confus(?:ed|ing|ion)|unclear|ambiguous|vague|not sure|don't understand|hard to parse|complicated instructions?)\b/.test(source)) {
      add('rewrite prompt in plain steps');
    }
    if (/\b(requirements?|instructions?|prompt|spec(?:ification)?|rubric|deliverables?|criteria|must include|required|expected)\b/.test(source)) {
      add('separate asks from context');
    }
    if (/\b(start(?:ing)? point|first step|where to start|stuck|blocked|next step|approach|strategy)\b/.test(source)) {
      add('identify first deliverable');
    }
    if (/\b(example|sample|template|starter|scaffold|provided files?|reference)\b/.test(source)) {
      add('compare against example');
    }

    return hints.slice(0, 3);
  }

  function inferActivePracticeLoopHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(lecture|slides?|notes?|transcript|recording|notebook|study guide|summary|chapter|reading)\b/.test(source)) {
      add('convert notes to quiz');
    }
    if (/\b(flashcards?|anki|quizlet|vocab(?:ulary)?|terms?|definitions?|memor(?:y|ize|ization))\b/.test(source)) {
      add('mix flashcards with problems');
    }
    if (/\b(practice|problem set|pset|worksheet|past exam|mock exam|sample exam|drill|question bank)\b/.test(source)) {
      add('grade practice immediately');
    }
    if (/\b(confidence|weak spots?|mistakes?|wrong answers?|missed questions?|error log|unclear|confus(?:ed|ing|ion))\b/.test(source)) {
      add('redo misses tomorrow');
    }

    return hints.slice(0, 3);
  }

  function inferInterleavedPracticeHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(cumulative|comprehensive|mixed review|spiral review|multiple units?|chapters?|modules?|all topics|final exam)\b/.test(source)) {
      add('mix old and new topics');
    }
    if (/\b(practice problems?|problem set|pset|worksheet|question bank|drill|mock exam|past exam|sample exam)\b/.test(source)) {
      add('shuffle problem types');
    }
    if (/\b(formula|method|algorithm|technique|strategy|pattern|when to use|choose between|classify)\b/.test(source)) {
      add('practice choosing the method');
    }
    if (/\b(mistakes?|wrong answers?|missed questions?|weak spots?|error log|corrections?)\b/.test(source)) {
      add('revisit misses in mixed set');
    }

    return hints.slice(0, 3);
  }

  function inferMetacognitiveCalibrationHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(practice|problem set|pset|worksheet|quiz|exam|midterm|final|test|mock exam|sample exam|past exam|drill)\b/.test(source)) {
      add('predict score before grading');
    }
    if (/\b(confidence|calibrat(?:e|ion)|self[- ]?assess(?:ment)?|metacognit(?:ion|ive)|sure|uncertain|guess(?:ed|ing)?)\b/.test(source)) {
      add('mark confidence per question');
    }
    if (/\b(wrong answers?|mistakes?|missed questions?|error log|corrections?|postmortem|reflection|review|feedback)\b/.test(source)) {
      add('compare confidence to misses');
    }
    if (/\b(rubric|score|grade|points?|autograder|gradescope|feedback)\b/.test(source)) {
      add('update weak-spot map');
    }

    return hints.slice(0, 3);
  }

  function inferSpacedReviewPlan(item, nowMs = Date.now()) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    if (!/\b(exam|midterm|final|test|quiz|practice|review|lecture|slides?|notes?|chapter|reading|flashcards?|spaced repetition|anki|study guide)\b/.test(source)) {
      return [];
    }

    const ts = Number(item && item.ts);
    if (!Number.isFinite(ts)) return ['review +1d', 'review +3d', 'review +7d'];

    const daysUntilDue = Math.floor((ts - nowMs) / MS_DAY);
    const candidateDays = [1, 3, 7].filter(days => days <= daysUntilDue);
    if (!candidateDays.length && ts > nowMs) return ['same-day review'];
    return candidateDays.map(days => `review +${days}d`).slice(0, 3);
  }

  function inferExamCountdownHints(item, nowMs = Date.now()) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    if (!/\b(exam|midterm|final|test|quiz|practicum|assessment|comprehensive|cumulative)\b/.test(source)) return [];

    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };
    const ts = Number(item && item.ts);
    const daysUntilDue = Number.isFinite(ts) ? Math.ceil((ts - nowMs) / MS_DAY) : Infinity;

    if (!Number.isFinite(daysUntilDue) || daysUntilDue >= 5) {
      add('map topics now');
      add('schedule spaced reps');
    } else if (daysUntilDue >= 2) {
      add('interleave weak topics');
      add('simulate exam timing');
    } else if (daysUntilDue >= 0) {
      add('cram weak spots');
      add('sleep-friendly review');
    } else {
      add('post-exam error log');
    }
    if (/\b(cumulative|comprehensive|multiple units?|chapters?|modules?|all topics|full course)\b/.test(source)) add('mix old units');
    if (/\b(practice exam|past exam|mock exam|sample exam|released exam)\b/.test(source)) add('redo past exam');

    return hints.slice(0, 3);
  }

  function inferExamConstraintHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    if (!/\b(exam|midterm|final|test|quiz|practicum|assessment)\b/.test(source)) return [];

    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(open[- ]?(book|note|notes)|notes? allowed|reference sheet|formula sheet|cheat sheet|crib sheet)\b/.test(source)) {
      add('prepare allowed references');
    }
    if (/\b(closed[- ]?(book|note|notes)|no notes?|notes? prohibited|without notes|memorization)\b/.test(source)) {
      add('practice from memory');
    }
    if (/\b(calculator|desmos|spreadsheet|excel|r studio|rstudio|python|jupyter|matlab|software allowed|permitted tools?)\b/.test(source)) {
      add('verify permitted tools');
    }
    if (/\b(time limit|timed|\d+\s*(?:min|mins|minutes|hour|hours)\b|window|available from|available until|starts at|ends at)\b/.test(source)) {
      add('simulate time limit');
    }
    if (/\b(proctor(?:ed|ing)?|lockdown browser|respondus|honorlock|examity|webcam|id check|scratch paper|blank paper|room scan)\b/.test(source)) {
      add('run proctoring setup check');
    }
    if (/\b(in[- ]?person|on campus|classroom|room\s+(?!scan\b)[a-z0-9-]+|lecture hall|testing center|exam room|bring (?:id|student id)|photo id)\b/.test(source)) {
      add('confirm exam logistics');
    }

    return hints.slice(0, 3);
  }

  function inferPeerStudyAccountabilityHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(study group|peer|partner|team|group project|collab(?:oration)?|pair programming|classmate|cohort)\b/.test(source)) {
      add('schedule peer check-in');
    }
    if (/\b(body doubl(?:e|ing)|cowork(?:ing)?|co-work(?:ing)?|focusmate|discord study|study room|silent study|accountability)\b/.test(source)) {
      add('use accountability block');
    }
    if (/\b(standup|check[- ]?in|progress update|milestone|checkpoint|scrum|sync)\b/.test(source)) {
      add('share progress update');
    }
    if (/\b(demo|presentation|oral exam|defense|rehears(?:e|al)|walkthrough|teach[- ]?back)\b/.test(source)) {
      add('practice with listener');
    }

    return hints.slice(0, 3);
  }

  function inferRecurringRoutineHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(weekly|every\s+(mon|tues|wednes|thurs|fri|satur|sun)day|recurring|routine|each week|week \d+|module \d+|unit \d+)\b/.test(source)) {
      add('reuse weekly routine');
    }
    if (/\b(lab|discussion|section|recitation|studio|seminar|workshop)\b/.test(source)) {
      add('prep recurring section');
    }
    if (/\b(quiz|reading|reflection|problem set|pset|homework|worksheet|checkpoint)\b/.test(source)) {
      add('template repeat task');
    }
    if (/\b(pattern|same format|again|next one|previous|last week|cadence)\b/.test(source)) {
      add('compare with last cycle');
    }

    return hints.slice(0, 3);
  }

  function inferTimeEstimateCalibrationHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(estimate|estimated|duration|time budget|timebox|time[- ]?box|how long|hours?|minutes?|workload|effort)\b/.test(source)) {
      add('record time estimate');
    }
    if (/\b(large|multi[- ]?part|multi part|project|lab|paper|essay|research|capstone|portfolio|implementation|debug|debugging)\b/.test(source)) {
      add('add planning buffer');
    }
    if (/\b(previous|last time|last week|again|recurring|same format|similar|retrospective|postmortem|actual time|took)\b/.test(source)) {
      add('compare estimate to actual');
    }
    if (/\b(overrun|ran out of time|underestimated|cram|cramming|late night|all[- ]?nighter|too much|heavy workload)\b/.test(source)) {
      add('shrink scope early');
    }

    return hints.slice(0, 3);
  }

  function inferBlockedDependencyHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(wait(?:ing)? on|blocked by|dependent on|depends on|prereq(?:uisite)?|before you can|need access|access request|permission|invite|account setup)\b/.test(source)) {
      add('resolve blocker first');
    }
    if (/\b(dataset|data set|starter code|starter repo|template|scaffold|provided files?|download|install|setup|set up|environment|dependencies?)\b/.test(source)) {
      add('collect required assets');
    }
    if (/\b(api key|token|credentials?|license|activation|login|sign[- ]?in|two[- ]?factor|2fa|vpn|ssh key|permission)\b/.test(source)) {
      add('verify access early');
    }
    if (/\b(partner|teammate|group|team|peer review|approval|feedback|review comments?|merge approval|code review)\b/.test(source)) {
      add('request collaborator input');
    }

    return hints.slice(0, 3);
  }

  function inferWorkedExampleHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(worked examples?|sample solutions?|example problems?|walkthrough|solution walkthrough|demo solution|model answer)\b/.test(source)) {
      add('study worked example');
    }
    if (/\b(faded examples?|fill[- ]?in|partially completed|scaffold(?:ed|ing)?|template|starter solution)\b/.test(source)) {
      add('fade scaffolding');
    }
    if (/\b(derive|derivation|proof|trace|step[- ]?by[- ]?step|show your work|explain each step)\b/.test(source)) {
      add('reconstruct steps');
    }
    if (/\b(transfer|similar problem|variant|extension|apply to new|new context)\b/.test(source)) {
      add('try transfer problem');
    }

    return hints.slice(0, 3);
  }

  function inferEvidenceConfidenceHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(source[- ]?grounded|grounded|evidence|citations?|references?|quote|quoted|page numbers?|slides?|lecture notes?|reading)\b/.test(source)) {
      add('show source confidence');
    }
    if (/\b(unknown|not covered|not in notes|missing context|unsupported|verify|fact[- ]?check|hallucination|uncertain|confidence)\b/.test(source)) {
      add('flag unsupported answers');
    }
    if (/\b(compare|contrast|synthesi[sz]e|multiple sources?|conflicting|conflicts?|perspectives?|claim|argument)\b/.test(source)) {
      add('separate evidence from inference');
    }
    if (/\b(ai|chatgpt|claude|gemini|llm|assistant|notebooklm|ai tutor)\b/.test(source)) {
      add('say when notes are insufficient');
    }

    return hints.slice(0, 3);
  }

  function inferChangeAwarenessHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(updated?|changed?|revised|revision|edited|modified|new instructions?|clarification|correction|errata|announcement)\b/.test(source)) {
      add('review changed instructions');
    }
    if (/\b(new files?|uploaded|posted|released|published|module added|page added|slides? posted|materials? available)\b/.test(source)) {
      add('check new course materials');
    }
    if (/\b(due date changed|deadline changed|rescheduled|extended|extension|postponed|moved (?:to|from)|available until|lock date)\b/.test(source)) {
      add('re-plan around new date');
    }
    if (/\b(graded|grade posted|score posted|feedback posted|comments? posted|rubric feedback|returned)\b/.test(source)) {
      add('inspect grade feedback');
    }

    return hints.slice(0, 3);
  }

  function inferSpecDeltaHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(spec(?:ification)?|instructions?|requirements?|prompt|rubric|deliverables?|acceptance criteria)\b/.test(source) && /\b(updated?|changed?|revised|revision|edited|modified|clarification|errata|correction|new version|latest)\b/.test(source)) {
      add('diff assignment spec');
    }
    if (/\b(added|new|required now|must now|include now|also submit|additional deliverables?)\b/.test(source)) {
      add('capture new requirements');
    }
    if (/\b(removed|no longer|optional now|dropped|not required|delete|omit)\b/.test(source)) {
      add('remove stale tasks');
    }
    if (/\b(changed due date|deadline changed|extension|extended|moved (?:to|from)|postponed|rescheduled|lock date|available until)\b/.test(source)) {
      add('verify schedule delta');
    }

    return hints.slice(0, 3);
  }

  function inferQuestionBankHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(lecture|slides?|transcript|recording|caption(?:s)?|notes?|notebook|study guide|reading|chapter)\b/.test(source)) {
      add('turn notes into question bank');
    }
    if (/\b(quiz|exam|midterm|final|test|practice|review|active recall|retrieval practice|self[- ]?quiz)\b/.test(source)) {
      add('tag questions by topic');
    }
    if (/\b(timestamp(?:ed)?|time stamp|page\s*\d+|pages?|citations?|sources?|quote|evidence|section|slide\s*\d+|slides?)\b/.test(source)) {
      add('anchor answers to source location');
    }
    if (/\b(wrong answers?|mistakes?|missed questions?|weak spots?|confus(?:ed|ing|ion)|unclear)\b/.test(source)) {
      add('promote misses to review queue');
    }

    return hints.slice(0, 3);
  }

  function inferAiQuizGenerationHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(ai|quizlet|coconote|notebooklm|study mode|chatgpt|claude|gemini|llm|assistant|question bank|practice questions?|flashcards?|self[- ]?quiz)\b/.test(source)) {
      add('generate practice set');
    }
    if (/\b(lecture|slides?|transcript|recording|caption(?:s)?|notes?|notebook|reading|chapter|study guide)\b/.test(source)) {
      add('convert notes to quiz');
    }
    if (/\b(answer key|answer explanations?|solutions?|exemplar|rubric|worked examples?|sample answers?|official answers?)\b/.test(source)) {
      add('include answer explanations');
    }
    if (/\b(wrong answers?|mistakes?|missed questions?|weak spots?|confidence|spaced repetition|retry|review queue)\b/.test(source)) {
      add('schedule weak-question retry');
    }

    return hints.slice(0, 3);
  }

  function inferFreshnessGuardHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(announcement|posted|updated|revised|clarification|errata|correction|changed|edited|new version|latest)\b/.test(source)) {
      add('verify latest Canvas update');
    }
    if (/\b(syllabus|schedule|calendar|old instructions?|previous version|outdated|deprecated|superseded)\b/.test(source)) {
      add('check for stale source');
    }
    if (/\b(conflicting|conflicts?|mismatch|different due date|different deadline|contradict(?:s|ion)|inconsistent)\b/.test(source)) {
      add('resolve instruction conflict');
    }
    if (/\b(email|edstem|ed discussion|piazza|slack|discord|instructor message|ta message)\b/.test(source)) {
      add('include instructor channel');
    }

    return hints.slice(0, 3);
  }

  function inferDueDateAmbiguityHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(tba|tbd|to be announced|to be determined|date pending|tentative|placeholder|approx(?:\.|imate(?:ly)?)?)\b/.test(source)) {
      add('confirm tentative deadline');
    }
    if (/\b(end of day|eod|midnight|11:?59|noon|by class|before class|after lecture|office hours|close of business)\b/.test(source)) {
      add('verify exact due time');
    }
    if (/\b(timezone|time zone|pst|pdt|est|edt|utc|local time|server time)\b/.test(source)) {
      add('check timezone');
    }
    if (/\b(lock date|available until|grace period|late policy|extension|extended|resubmit|resubmission)\b/.test(source)) {
      add('separate due vs lock date');
    }

    return hints.slice(0, 3);
  }

  function inferHiddenDeadlineHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(draft|proposal|outline|peer review|checkpoint|milestone|demo|presentation|office hours|lab section|discussion section)\b/.test(source) && /\b(due|by|before|after|on|opens?|closes?|available|window)\b/.test(source)) {
      add('extract interim dates');
    }
    if (/\b(peer review|peer feedback|team review|partner review|group critique|code review|pr review)\b/.test(source)) {
      add('schedule peer-review window');
    }
    if (/\b(demo slot|presentation slot|defense|oral exam|lab checkoff|check[- ]?off|interview|practical)\b/.test(source)) {
      add('book live checkoff time');
    }
    if (/\b(available from|opens?|unlocks?|release(?:d)?|visible after)\b/.test(source) && /\b(available until|closes?|locks?|lock date|deadline|hard stop)\b/.test(source)) {
      add('separate open and close dates');
    }

    return hints.slice(0, 3);
  }

  function inferAiStudySessionSetupHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(ai tutor|study mode|study session|chatgpt|claude|gemini|notebooklm|llm|assistant|agent(?:ic)? tutor)\b/.test(source)) {
      add('start with learning goal');
    }
    if (/\b(lecture|slides?|notes?|transcript|reading|chapter|paper|article|rubric|prompt|assignment page|source packet)\b/.test(source)) {
      add('attach source packet');
    }
    if (/\b(quiz|self[- ]?quiz|flashcards?|practice questions?|study guide|audio overview|audio recap|podcast|recap)\b/.test(source)) {
      add('choose study artifact');
    }
    if (/\b(weak spots?|confus(?:ed|ing|ion)|mistakes?|missed questions?|wrong answers?|unclear|confidence)\b/.test(source)) {
      add('target weak spots');
    }

    return hints.slice(0, 3);
  }

  function inferPersonalizedMemoryHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(learning profile|personalized|personalised|study history|memory|long[- ]?term memory|learner model|preference(?:s)?|weak spots?|strengths?)\b/.test(source)) {
      add('update learning profile');
    }
    if (/\b(mistake journal|error log|wrong answers?|missed questions?|corrections?|postmortem|reflection|retrospective)\b/.test(source)) {
      add('carry forward mistake patterns');
    }
    if (/\b(goals?|rubric|criteria|target grade|grade target|outcome|objective|learning goal)\b/.test(source)) {
      add('align to stated goals');
    }
    if (/\b(ai tutor|study mode|chatgpt|claude|gemini|notebooklm|copilot|assistant|llm|agent(?:ic)? tutor)\b/.test(source)) {
      add('reuse prior tutor context');
    }

    return hints.slice(0, 3);
  }

  function inferNotebookLmStudyPlanHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(notebooklm|gemini|ai study plan|personalized study plan|study plan|learning guide)\b/.test(source)) {
      add('create source-grounded study plan');
    }
    if (/\b(textbooks?|lecture notes?|slides?|transcripts?|readings?|chapters?|source packet|uploaded sources?|course materials?)\b/.test(source)) {
      add('bundle textbook and lecture notes');
    }
    if (/\b(weak spots?|strengths?|goals?|target grade|personalized|personalised|study history|learning profile)\b/.test(source)) {
      add('adapt plan to learner profile');
    }
    if (/\b(audio overview|audio recap|podcast|flashcards?|quiz|practice set|mind map|timeline)\b/.test(source)) {
      add('pick output format before generating');
    }

    return hints.slice(0, 3);
  }

  function inferFirstStudyStepHints(item, nowMs = Date.now()) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };
    const ts = Number(item && item.ts);
    const hoursUntilDue = Number.isFinite(ts) ? (ts - nowMs) / (60 * 60 * 1000) : Infinity;

    if (/\b(exam|midterm|final|test|quiz|review|study guide|flashcards?|practice)\b/.test(source)) {
      add('blank-page recall first');
    }
    if (/\b(homework|problem set|pset|worksheet|lab|project|programming|coding|implementation|assignment)\b/.test(source)) {
      add('state target skill');
    }
    if (/\b(github|repo(?:sitory)?|starter code|autograder|gradescope|pytest|unit tests?|debug|bug|failing|implementation)\b/.test(source)) {
      add('describe I/O before coding');
    }
    if (/\b(confus(?:ed|ing|ion)|unclear|stuck|blocked|weak spots?|don'?t understand|office hours|ta\b|tutor)\b/.test(source)) {
      add('write one help question');
    }
    if (hoursUntilDue >= 24 && hoursUntilDue <= 7 * 24 && /\b(project|paper|essay|lab|exam|midterm|final|presentation|capstone|portfolio)\b/.test(source)) {
      add('pick 10-minute starter task');
    }

    return hints.slice(0, 3);
  }

  function inferStudyRecoveryHints(item, nowMs = Date.now()) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };
    const ts = Number(item && item.ts);
    const hoursUntilDue = Number.isFinite(ts) ? (ts - nowMs) / (60 * 60 * 1000) : Infinity;

    if (/\b(exam|midterm|final|test|quiz|practicum|assessment|presentation|demo)\b/.test(source) && hoursUntilDue >= 0 && hoursUntilDue <= 36) {
      add('protect sleep window');
    }
    if (/\b(cram|all[- ]?nighter|overnight|late night|burnout|exhaust(?:ed|ion)|tired|fatigue|stress|anxiety|overwhelm(?:ed)?)\b/.test(source)) {
      add('plan recovery break');
    }
    if (/\b(long session|marathon|deep work|project|capstone|paper|essay|lab|implementation|debug(?:ging)?)\b/.test(source)) {
      add('add reset breaks');
    }
    if (/\b(memory|memor(?:y|ize|ization)|flashcards?|active recall|practice problems?|problem set|review|study guide)\b/.test(source)) {
      add('end with light recall');
    }

    return hints.slice(0, 3);
  }

  function inferAssignmentQuestionQueueHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(confus(?:ed|ing|ion)|unclear|ambiguous|not sure|don't understand|stuck|blocked|question|questions)\b/.test(source)) {
      add('write unresolved question');
    }
    if (/\b(spec(?:ification)?|requirements?|instructions?|rubric|prompt|deliverables?|constraints?|allowed tools?)\b/.test(source)) {
      add('quote exact spec line');
    }
    if (/\b(office hours|ta\b|professor|instructor|piazza|edstem|ed discussion|discussion board|slack|discord)\b/.test(source)) {
      add('route to help channel');
    }
    if (/\b(answer(?:ed)?|clarification|announcement|update|revised|resolved|follow[- ]?up)\b/.test(source)) {
      add('record resolved answer');
    }

    return hints.slice(0, 3);
  }

  function inferAiSourceBoundaryHints(item) {
    const source = `${item?.title || ''} ${item?.description || item?.text || item?.content || ''}`.toLowerCase();
    const hints = [];
    const add = (label) => { if (!hints.includes(label)) hints.push(label); };

    if (/\b(ai tutor|study mode|chatgpt|claude|gemini|notebooklm|coconote|quizlet|copilot|llm|assistant|agent(?:ic)? tutor)\b/.test(source)) {
      add('separate source facts from AI hints');
    }
    if (/\b(transcript|summary|summar(?:y|ize|ise)|notes?|lecture capture|record(?:ing)?|slides?|reading|paper|article|source packet)\b/.test(source)) {
      add('keep citation trail');
    }
    if (/\b(hallucinat(?:e|ion)|unsupported|unverified|low confidence|confidence|fact[- ]?check|verify|cross[- ]?check)\b/.test(source)) {
      add('flag unsupported claims');
    }
    if (/\b(prompt injection|ignore previous|system prompt|jailbreak|malicious|untrusted|external content|web page|uploaded file)\b/.test(source)) {
      add('treat content as untrusted');
    }

    return hints.slice(0, 3);
  }

  function scoreStudyActionCandidate(item, nowMs = Date.now()) {
    if (!item || item.done || !Number.isFinite(Number(item.ts))) return null;
    const ts = Number(item.ts);
    const hoursUntilDue = (ts - nowMs) / (60 * 60 * 1000);
    const triage = classifyDeadline({ ...item, ts }, nowMs);
    const actionBucket = classifyActionBucket(item, nowMs);
    if (actionBucket === 'submitted') return null;
    let score = 0;
    const reasons = [];

    if (hoursUntilDue < 0) { score += 100; reasons.push('overdue'); }
    else if (hoursUntilDue <= 24) { score += 80; reasons.push('due today'); }
    else if (hoursUntilDue <= 72) { score += 45; reasons.push('due soon'); }
    else { score += Math.max(0, 20 - hoursUntilDue / 24); }

    if (triage.effort === 'high') { score += 40; reasons.push('high effort'); }
    else if (triage.effort === 'quick') { score += 8; reasons.push('quick win'); }

    if (actionBucket === 'overdue') { score += 20; reasons.push('needs action'); }
    else if (actionBucket === 'due soon') { score += 10; if (!reasons.includes('due soon')) reasons.push('due soon'); }

    const pointValue = getAssignmentPointValue(item);
    if (Number.isFinite(pointValue)) {
      if (pointValue >= 100) { score += 25; reasons.push('high grade impact'); }
      else if (pointValue >= 50) { score += 12; reasons.push('meaningful points'); }
      else if (pointValue <= 10 && hoursUntilDue <= 72) { score += 6; reasons.push('quick points'); }
    }

    const sourceText = `${item.title || ''} ${item.description || item.text || item.content || ''}`.toLowerCase();
    if (/\b(not started|starter|draft|proposal|milestone|checkpoint|practice|review)\b/.test(sourceText)) {
      score += 10;
      reasons.push('needs progress');
    }

    const changeHints = inferChangeAwarenessHints(item);
    if (changeHints.length) {
      score += hoursUntilDue <= 72 ? 14 : 6;
      reasons.push('changed instructions');
    }

    return { item, ts, triage, score, reasons };
  }

  function formatStudyActionRecommendation(candidate) {
    if (!candidate) return null;
    const title = String(candidate.item.title || 'upcoming deadline').trim();
    const course = String(candidate.item.courseName || candidate.item.course || '').trim();
    const verb = candidate.triage.effort === 'quick' ? 'Finish' : candidate.triage.effort === 'high' ? 'Do a 45-minute deep-work sprint on' : 'Spend 45 minutes on';
    const reason = candidate.reasons.length ? candidate.reasons.slice(0, 4).join(' + ') : 'highest priority';
    return {
      title,
      course,
      reason,
      action: `${verb} ${title}`,
      urgency: candidate.triage.urgency,
      effort: candidate.triage.effort,
      dueAt: candidate.ts,
      score: candidate.score
    };
  }

  function recommendTopStudyActions(items, nowMs = Date.now(), limit = 3) {
    const safeLimit = Math.max(1, Math.min(5, Number(limit) || 3));
    return (Array.isArray(items) ? items : [])
      .map(item => scoreStudyActionCandidate(item, nowMs))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.ts - b.ts)
      .slice(0, safeLimit)
      .map(formatStudyActionRecommendation)
      .filter(Boolean);
  }

  function recommendNextStudyAction(items, nowMs = Date.now()) {
    return recommendTopStudyActions(items, nowMs, 1)[0] || null;
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
      const actionBucket = classifyActionBucket(d, nowMs);
      const evidence = compactDeadlineText(d);
      const resourceLinks = inferAssignmentResourceLinks(d);
      const checklist = inferSubmissionChecklist(d);
      const reviewHints = inferConceptReviewHints(d);
      const studyPhases = inferStudyPhases(d);
      const executionPlanHints = inferExecutionPlanHints(d, nowMs);
      const learningHints = inferLearningStrategyHints(d);
      const focusHints = inferFocusSprintHints(d);
      const practiceHints = inferPracticeArtifactHints(d);
      const retrievalHints = inferRetrievalCalibrationHints(d);
      const socraticHints = inferSocraticStudyHints(d);
      const teachBackHints = inferTeachBackHints(d);
      const integrityHints = inferAcademicIntegrityHints(d);
      const privacyConsentHints = inferPrivacyConsentHints(d);
      const accessibilityStudyHints = inferAccessibilityStudyHints(d);
      const codeDebugHints = inferCodeDebugHints(d);
      const minimalReproHints = inferMinimalReproHints(d);
      const autograderFeedbackHints = inferAutograderFeedbackHints(d);
      const officeHoursHints = inferOfficeHoursPrepHints(d);
      const collaborationHints = inferCollaborationHandoffHints(d);
      const lectureHints = inferLectureCaptureHints(d);
      const lectureActionHints = inferLectureActionChecklistHints(d);
      const sourceCoverageHints = inferSourceCoverageAuditHints(d);
      const aiNoteQualityHints = inferAiNoteQualityAuditHints(d);
      const confusionCaptureHints = inferConfusionCaptureHints(d);
      const audioReviewHints = inferAudioReviewHints(d);
      const transcriptStudyGuideHints = inferTranscriptStudyGuideHints(d);
      const multimodalHints = inferMultimodalStudyAssetHints(d);
      const sourceGroundingHints = inferSourceGroundingHints(d);
      const evidencePackHints = inferEvidencePackHints(d);
      const tutorContextHints = inferTutorContextPackHints(d);
      const feedbackLoopHints = inferFeedbackLoopHints(d);
      const portabilityHints = inferPortabilityBackupHints(d);
      const wrapUpHints = inferStudyWrapUpHints(d);
      const rubricHints = inferRubricScoringHints(d);
      const preSubmitHints = inferPreSubmitVerificationHints(d);
      const availabilityWindowHints = inferAvailabilityWindowHints(d);
      const notebookStudyPackHints = inferNotebookStudyPackHints(d);
      const studyPackArtifactHints = inferStudyPackArtifactHints(d);
      const readingTriageHints = inferReadingTriageHints(d);
      const lectureQuestionHints = inferLectureQuestionQueueHints(d);
      const aiHandoffHints = inferAiHandoffHints(d);
      const csWorkflowHints = inferCsWorkflowHints(d);
      const commandSnippetHints = inferCommandSnippetHints(d);
      const assignmentSpecHints = inferAssignmentSpecExtractionHints(d);
      const milestoneDecompositionHints = inferMilestoneDecompositionHints(d);
      const requirementClarificationHints = inferRequirementClarificationHints(d);
      const activePracticeHints = inferActivePracticeLoopHints(d);
      const interleavedPracticeHints = inferInterleavedPracticeHints(d);
      const metacognitiveHints = inferMetacognitiveCalibrationHints(d);
      const spacedReviewPlan = inferSpacedReviewPlan(d, nowMs);
      const examCountdownHints = inferExamCountdownHints(d, nowMs);
      const examConstraintHints = inferExamConstraintHints(d);
      const peerAccountabilityHints = inferPeerStudyAccountabilityHints(d);
      const recurringRoutineHints = inferRecurringRoutineHints(d);
      const timeEstimateHints = inferTimeEstimateCalibrationHints(d);
      const blockedDependencyHints = inferBlockedDependencyHints(d);
      const workedExampleHints = inferWorkedExampleHints(d);
      const evidenceConfidenceHints = inferEvidenceConfidenceHints(d);
      const changeAwarenessHints = inferChangeAwarenessHints(d);
      const specDeltaHints = inferSpecDeltaHints(d);
      const questionBankHints = inferQuestionBankHints(d);
      const aiQuizGenerationHints = inferAiQuizGenerationHints(d);
      const freshnessGuardHints = inferFreshnessGuardHints(d);
      const dueDateAmbiguityHints = inferDueDateAmbiguityHints(d);
      const hiddenDeadlineHints = inferHiddenDeadlineHints(d);
      const aiStudySessionHints = inferAiStudySessionSetupHints(d);
      const personalizedMemoryHints = inferPersonalizedMemoryHints(d);
      const notebookLmStudyPlanHints = inferNotebookLmStudyPlanHints(d);
      const firstStudyStepHints = inferFirstStudyStepHints(d, nowMs);
      const studyRecoveryHints = inferStudyRecoveryHints(d, nowMs);
      const assignmentQuestionHints = inferAssignmentQuestionQueueHints(d);
      const aiSourceBoundaryHints = inferAiSourceBoundaryHints(d);
      const gradeImpactHints = inferGradeImpactHints(d);
      const riskFlags = inferPlannerRiskFlags(d, deadlines, nowMs);
      const resourceLinkHint = resourceLinks.length ? `; resources: ${resourceLinks.map(link => `${link.label} ${link.url}`).join(', ')}` : '';
      const checklistHint = checklist.length ? `; checklist: ${checklist.join(', ')}` : '';
      const reviewHint = reviewHints.length ? `; review: ${reviewHints.join(', ')}` : '';
      const learningHint = learningHints.length ? `; learning strategy: ${learningHints.join(', ')}` : '';
      const focusHint = focusHints.length ? `; focus sprint: ${focusHints.join(', ')}` : '';
      const practiceHint = practiceHints.length ? `; practice assets: ${practiceHints.join(', ')}` : '';
      const retrievalHint = retrievalHints.length ? `; retrieval calibration: ${retrievalHints.join(', ')}` : '';
      const socraticHint = socraticHints.length ? `; Socratic tutor mode: ${socraticHints.join(', ')}` : '';
      const teachBackHint = teachBackHints.length ? `; teach-back: ${teachBackHints.join(', ')}` : '';
      const integrityHint = integrityHints.length ? `; integrity: ${integrityHints.join(', ')}` : '';
      const privacyConsentHint = privacyConsentHints.length ? `; privacy/consent: ${privacyConsentHints.join(', ')}` : '';
      const accessibilityStudyHint = accessibilityStudyHints.length ? `; accessibility: ${accessibilityStudyHints.join(', ')}` : '';
      const codeDebugHint = codeDebugHints.length ? `; code/debug: ${codeDebugHints.join(', ')}` : '';
      const minimalReproHint = minimalReproHints.length ? `; minimal repro: ${minimalReproHints.join(', ')}` : '';
      const autograderFeedbackHint = autograderFeedbackHints.length ? `; autograder feedback: ${autograderFeedbackHints.join(', ')}` : '';
      const officeHoursHint = officeHoursHints.length ? `; office hours prep: ${officeHoursHints.join(', ')}` : '';
      const collaborationHint = collaborationHints.length ? `; collaboration handoff: ${collaborationHints.join(', ')}` : '';
      const lectureHint = lectureHints.length ? `; lecture capture: ${lectureHints.join(', ')}` : '';
      const lectureActionHint = lectureActionHints.length ? `; lecture action checklist: ${lectureActionHints.join(', ')}` : '';
      const sourceCoverageHint = sourceCoverageHints.length ? `; source coverage audit: ${sourceCoverageHints.join(', ')}` : '';
      const aiNoteQualityHint = aiNoteQualityHints.length ? `; AI note audit: ${aiNoteQualityHints.join(', ')}` : '';
      const confusionCaptureHint = confusionCaptureHints.length ? `; confusion capture: ${confusionCaptureHints.join(', ')}` : '';
      const audioReviewHint = audioReviewHints.length ? `; audio review: ${audioReviewHints.join(', ')}` : '';
      const transcriptStudyGuideHint = transcriptStudyGuideHints.length ? `; transcript study guide: ${transcriptStudyGuideHints.join(', ')}` : '';
      const multimodalHint = multimodalHints.length ? `; multimodal study assets: ${multimodalHints.join(', ')}` : '';
      const sourceGroundingHint = sourceGroundingHints.length ? `; source grounding: ${sourceGroundingHints.join(', ')}` : '';
      const evidencePackHint = evidencePackHints.length ? `; evidence pack: ${evidencePackHints.join(', ')}` : '';
      const tutorContextHint = tutorContextHints.length ? `; tutor context pack: ${tutorContextHints.join(', ')}` : '';
      const feedbackLoopHint = feedbackLoopHints.length ? `; feedback loop: ${feedbackLoopHints.join(', ')}` : '';
      const portabilityHint = portabilityHints.length ? `; portability backup: ${portabilityHints.join(', ')}` : '';
      const wrapUpHint = wrapUpHints.length ? `; wrap-up: ${wrapUpHints.join(', ')}` : '';
      const rubricHint = rubricHints.length ? `; rubric scoring: ${rubricHints.join(', ')}` : '';
      const preSubmitHint = preSubmitHints.length ? `; pre-submit: ${preSubmitHints.join(', ')}` : '';
      const availabilityWindowHint = availabilityWindowHints.length ? `; availability window: ${availabilityWindowHints.join(', ')}` : '';
      const notebookStudyPackHint = notebookStudyPackHints.length ? `; notebook study pack: ${notebookStudyPackHints.join(', ')}` : '';
      const studyPackArtifactHint = studyPackArtifactHints.length ? `; study pack artifacts: ${studyPackArtifactHints.join(', ')}` : '';
      const readingTriageHint = readingTriageHints.length ? `; reading triage: ${readingTriageHints.join(', ')}` : '';
      const lectureQuestionHint = lectureQuestionHints.length ? `; lecture question queue: ${lectureQuestionHints.join(', ')}` : '';
      const aiHandoffHint = aiHandoffHints.length ? `; AI handoff: ${aiHandoffHints.join(', ')}` : '';
      const csWorkflowHint = csWorkflowHints.length ? `; CS workflow: ${csWorkflowHints.join(', ')}` : '';
      const commandSnippetHint = commandSnippetHints.length ? `; command snippets: ${commandSnippetHints.join(', ')}` : '';
      const assignmentSpecHint = assignmentSpecHints.length ? `; assignment spec: ${assignmentSpecHints.join(', ')}` : '';
      const milestoneDecompositionHint = milestoneDecompositionHints.length ? `; milestone decomposition: ${milestoneDecompositionHints.join(', ')}` : '';
      const requirementClarificationHint = requirementClarificationHints.length ? `; clarify requirements: ${requirementClarificationHints.join(', ')}` : '';
      const activePracticeHint = activePracticeHints.length ? `; active practice loop: ${activePracticeHints.join(', ')}` : '';
      const interleavedPracticeHint = interleavedPracticeHints.length ? `; interleaved practice: ${interleavedPracticeHints.join(', ')}` : '';
      const metacognitiveHint = metacognitiveHints.length ? `; metacognitive calibration: ${metacognitiveHints.join(', ')}` : '';
      const spacedReviewHint = spacedReviewPlan.length ? `; spaced review plan: ${spacedReviewPlan.join(', ')}` : '';
      const examCountdownHint = examCountdownHints.length ? `; exam countdown: ${examCountdownHints.join(', ')}` : '';
      const examConstraintHint = examConstraintHints.length ? `; exam constraints: ${examConstraintHints.join(', ')}` : '';
      const peerAccountabilityHint = peerAccountabilityHints.length ? `; peer accountability: ${peerAccountabilityHints.join(', ')}` : '';
      const recurringRoutineHint = recurringRoutineHints.length ? `; recurring routine: ${recurringRoutineHints.join(', ')}` : '';
      const timeEstimateHint = timeEstimateHints.length ? `; time estimate: ${timeEstimateHints.join(', ')}` : '';
      const blockedDependencyHint = blockedDependencyHints.length ? `; dependency blockers: ${blockedDependencyHints.join(', ')}` : '';
      const workedExampleHint = workedExampleHints.length ? `; worked example ladder: ${workedExampleHints.join(', ')}` : '';
      const evidenceConfidenceHint = evidenceConfidenceHints.length ? `; evidence confidence: ${evidenceConfidenceHints.join(', ')}` : '';
      const changeAwarenessHint = changeAwarenessHints.length ? `; change awareness: ${changeAwarenessHints.join(', ')}` : '';
      const specDeltaHint = specDeltaHints.length ? `; spec delta: ${specDeltaHints.join(', ')}` : '';
      const questionBankHint = questionBankHints.length ? `; question bank: ${questionBankHints.join(', ')}` : '';
      const aiQuizGenerationHint = aiQuizGenerationHints.length ? `; AI quiz generation: ${aiQuizGenerationHints.join(', ')}` : '';
      const freshnessGuardHint = freshnessGuardHints.length ? `; freshness guard: ${freshnessGuardHints.join(', ')}` : '';
      const dueDateAmbiguityHint = dueDateAmbiguityHints.length ? `; due-date ambiguity: ${dueDateAmbiguityHints.join(', ')}` : '';
      const hiddenDeadlineHint = hiddenDeadlineHints.length ? `; hidden deadlines: ${hiddenDeadlineHints.join(', ')}` : '';
      const aiStudySessionHint = aiStudySessionHints.length ? `; AI study session: ${aiStudySessionHints.join(', ')}` : '';
      const personalizedMemoryHint = personalizedMemoryHints.length ? `; personalized memory: ${personalizedMemoryHints.join(', ')}` : '';
      const notebookLmStudyPlanHint = notebookLmStudyPlanHints.length ? `; NotebookLM study plan: ${notebookLmStudyPlanHints.join(', ')}` : '';
      const firstStudyStepHint = firstStudyStepHints.length ? `; first study step: ${firstStudyStepHints.join(', ')}` : '';
      const studyRecoveryHint = studyRecoveryHints.length ? `; recovery guardrail: ${studyRecoveryHints.join(', ')}` : '';
      const assignmentQuestionHint = assignmentQuestionHints.length ? `; assignment question queue: ${assignmentQuestionHints.join(', ')}` : '';
      const aiSourceBoundaryHint = aiSourceBoundaryHints.length ? `; AI source boundaries: ${aiSourceBoundaryHints.join(', ')}` : '';
      const gradeImpactHint = gradeImpactHints.length ? `; grade impact: ${gradeImpactHints.join(', ')}` : '';
      const phaseHint = studyPhases.length ? `; suggested phases: ${studyPhases.join(', ')}` : '';
      const executionPlanHint = executionPlanHints.length ? `; execution plan: ${executionPlanHints.join(', ')}` : '';
      const riskHint = riskFlags.length ? `; risk: ${riskFlags.join(', ')}` : '';
      const actionBucketHint = `; action bucket: ${actionBucket}`;
      const hint = `urgency=${triage.urgency}, effort=${triage.effort}${actionBucketHint}${resourceLinkHint}${checklistHint}${reviewHint}${learningHint}${focusHint}${practiceHint}${retrievalHint}${socraticHint}${teachBackHint}${integrityHint}${privacyConsentHint}${accessibilityStudyHint}${codeDebugHint}${minimalReproHint}${autograderFeedbackHint}${officeHoursHint}${collaborationHint}${lectureHint}${lectureActionHint}${sourceCoverageHint}${aiNoteQualityHint}${confusionCaptureHint}${audioReviewHint}${transcriptStudyGuideHint}${multimodalHint}${sourceGroundingHint}${evidencePackHint}${tutorContextHint}${feedbackLoopHint}${portabilityHint}${wrapUpHint}${rubricHint}${preSubmitHint}${availabilityWindowHint}${notebookStudyPackHint}${studyPackArtifactHint}${readingTriageHint}${lectureQuestionHint}${aiHandoffHint}${csWorkflowHint}${commandSnippetHint}${assignmentSpecHint}${milestoneDecompositionHint}${requirementClarificationHint}${activePracticeHint}${interleavedPracticeHint}${metacognitiveHint}${spacedReviewHint}${examCountdownHint}${examConstraintHint}${peerAccountabilityHint}${recurringRoutineHint}${timeEstimateHint}${blockedDependencyHint}${workedExampleHint}${evidenceConfidenceHint}${changeAwarenessHint}${specDeltaHint}${questionBankHint}${aiQuizGenerationHint}${freshnessGuardHint}${dueDateAmbiguityHint}${hiddenDeadlineHint}${aiStudySessionHint}${personalizedMemoryHint}${notebookLmStudyPlanHint}${firstStudyStepHint}${studyRecoveryHint}${assignmentQuestionHint}${aiSourceBoundaryHint}${gradeImpactHint}${phaseHint}${executionPlanHint}${riskHint}`;
      return `- "${d.title}" (${d.courseName || 'General'}) due ${dueLabel}; ${hint}${evidence ? `; notes: ${evidence}` : ''}`;
    }).join('\n');

    return `You are an academic planner. Today is ${now.toLocaleString()}.\n` +
      `Here are the student's upcoming deadlines, including local triage hints and source notes when available:\n${lines}\n\n` +
      `Propose 4-8 study blocks between now and the last deadline. Prioritize overdue/today items first. Prioritize action buckets in this order: overdue, due soon, no due date, later; skip or de-prioritize submitted work unless it needs review. Split high-effort items (essays, projects, exams) into multiple blocks (e.g. outline, draft, practice, review), keep quick items lightweight, and use the notes as source grounding instead of inventing requirements. Schedule blocks before their deadline, between 09:00 and 21:00 local time, 60-120 minutes each, leaving at least 30 minutes before a due time for submission checks and handoff.\n` +
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

    const recommendations = recommendTopStudyActions(items, now, 3);
    recommendations.forEach((recommendation, index) => {
      const next = document.createElement('div');
      next.className = 'plan-deadline-row plan-next-action animate-fade-in';
      next.innerHTML = `
        <span class="plan-deadline-date">NEXT ${index + 1}</span>
        <span class="plan-deadline-title">${escapeHtml(recommendation.action)}</span>
        <span class="plan-deadline-course">${escapeHtml(recommendation.course)}</span>
        <span class="plan-deadline-triage" title="Recommended because ${escapeHtml(recommendation.reason)}">${escapeHtml(recommendation.reason)}</span>
      `;
      list.appendChild(next);
    });

    items.slice(0, 12).forEach((item, i) => {
      const row = document.createElement(item.url ? 'button' : 'div');
      row.className = 'plan-deadline-row stagger-in';
      row.style.animationDelay = `${Math.min(i * 28, 280)}ms`;
      const overdue = item.ts < now;
      const dateLabel = new Date(item.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const triage = classifyDeadline(item, now);
      const actionBucket = classifyActionBucket(item, now);
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
      const privacyConsentHints = inferPrivacyConsentHints(item);
      const codeDebugHints = inferCodeDebugHints(item);
      const minimalReproHints = inferMinimalReproHints(item);
      const officeHoursHints = inferOfficeHoursPrepHints(item);
      const collaborationHints = inferCollaborationHandoffHints(item);
      const lectureHints = inferLectureCaptureHints(item);
      const lectureActionHints = inferLectureActionChecklistHints(item);
      const aiNoteQualityHints = inferAiNoteQualityAuditHints(item);
      const confusionCaptureHints = inferConfusionCaptureHints(item);
      const multimodalHints = inferMultimodalStudyAssetHints(item);
      const sourceGroundingHints = inferSourceGroundingHints(item);
      const evidencePackHints = inferEvidencePackHints(item);
      const tutorContextHints = inferTutorContextPackHints(item);
      const feedbackLoopHints = inferFeedbackLoopHints(item);
      const portabilityHints = inferPortabilityBackupHints(item);
      const wrapUpHints = inferStudyWrapUpHints(item);
      const rubricHints = inferRubricScoringHints(item);
      const preSubmitHints = inferPreSubmitVerificationHints(item);
      const availabilityWindowHints = inferAvailabilityWindowHints(item);
      const notebookStudyPackHints = inferNotebookStudyPackHints(item);
      const readingTriageHints = inferReadingTriageHints(item);
      const lectureQuestionHints = inferLectureQuestionQueueHints(item);
      const aiHandoffHints = inferAiHandoffHints(item);
      const csWorkflowHints = inferCsWorkflowHints(item);
      const commandSnippetHints = inferCommandSnippetHints(item);
      const assignmentSpecHints = inferAssignmentSpecExtractionHints(item);
      const requirementClarificationHints = inferRequirementClarificationHints(item);
      const activePracticeHints = inferActivePracticeLoopHints(item);
      const interleavedPracticeHints = inferInterleavedPracticeHints(item);
      const metacognitiveHints = inferMetacognitiveCalibrationHints(item);
      const spacedReviewPlan = inferSpacedReviewPlan(item, now);
      const examCountdownHints = inferExamCountdownHints(item, now);
      const examConstraintHints = inferExamConstraintHints(item);
      const peerAccountabilityHints = inferPeerStudyAccountabilityHints(item);
      const recurringRoutineHints = inferRecurringRoutineHints(item);
      const blockedDependencyHints = inferBlockedDependencyHints(item);
      const changeAwarenessHints = inferChangeAwarenessHints(item);
      const evidenceConfidenceHints = inferEvidenceConfidenceHints(item);
      const personalizedMemoryHints = inferPersonalizedMemoryHints(item);
      const studyRecoveryHints = inferStudyRecoveryHints(item, now);
      const gradeImpactHints = inferGradeImpactHints(item);
      const riskFlags = inferPlannerRiskFlags(item, items, now);
      const checklistLabel = riskFlags.length ? `Risk: ${riskFlags.join(' · ')}` : (changeAwarenessHints.length ? `Changed: ${changeAwarenessHints.join(' · ')}` : (checklist.length ? checklist.join(' · ') : `${triage.urgency} · ${effortLabel}`));
      const reviewLabel = [
        changeAwarenessHints.length ? `Changes: ${changeAwarenessHints.join(' · ')}` : '',
        reviewHints.length ? `Review: ${reviewHints.join(' · ')}` : '',
        codeDebugHints.length ? `Debug: ${codeDebugHints.join(' · ')}` : '',
        minimalReproHints.length ? `Repro: ${minimalReproHints.join(' · ')}` : '',
        officeHoursHints.length ? `Office hours: ${officeHoursHints.join(' · ')}` : '',
        collaborationHints.length ? `Handoff: ${collaborationHints.join(' · ')}` : '',
        lectureHints.length ? `Lecture: ${lectureHints.join(' · ')}` : '',
        lectureActionHints.length ? `Lecture tasks: ${lectureActionHints.join(' · ')}` : '',
        aiNoteQualityHints.length ? `AI notes: ${aiNoteQualityHints.join(' · ')}` : '',
        confusionCaptureHints.length ? `Confusion: ${confusionCaptureHints.join(' · ')}` : '',
        multimodalHints.length ? `Assets: ${multimodalHints.join(' · ')}` : '',
        sourceGroundingHints.length ? `Sources: ${sourceGroundingHints.join(' · ')}` : '',
        evidencePackHints.length ? `Evidence: ${evidencePackHints.join(' · ')}` : '',
        tutorContextHints.length ? `Context: ${tutorContextHints.join(' · ')}` : '',
        feedbackLoopHints.length ? `Feedback loop: ${feedbackLoopHints.join(' · ')}` : '',
        portabilityHints.length ? `Backup: ${portabilityHints.join(' · ')}` : '',
        wrapUpHints.length ? `Wrap-up: ${wrapUpHints.join(' · ')}` : '',
        metacognitiveHints.length ? `Calibration: ${metacognitiveHints.join(' · ')}` : '',
        rubricHints.length ? `Rubric: ${rubricHints.join(' · ')}` : '',
        preSubmitHints.length ? `Pre-submit: ${preSubmitHints.join(' · ')}` : '',
        availabilityWindowHints.length ? `Availability: ${availabilityWindowHints.join(' · ')}` : '',
        notebookStudyPackHints.length ? `Notebook pack: ${notebookStudyPackHints.join(' · ')}` : '',
        readingTriageHints.length ? `Reading triage: ${readingTriageHints.join(' · ')}` : '',
        lectureQuestionHints.length ? `Lecture questions: ${lectureQuestionHints.join(' · ')}` : '',
        aiHandoffHints.length ? `AI handoff: ${aiHandoffHints.join(' · ')}` : '',
        csWorkflowHints.length ? `CS workflow: ${csWorkflowHints.join(' · ')}` : '',
        commandSnippetHints.length ? `Commands: ${commandSnippetHints.join(' · ')}` : '',
        assignmentSpecHints.length ? `Spec: ${assignmentSpecHints.join(' · ')}` : '',
        requirementClarificationHints.length ? `Clarify: ${requirementClarificationHints.join(' · ')}` : '',
        activePracticeHints.length ? `Practice loop: ${activePracticeHints.join(' · ')}` : '',
        interleavedPracticeHints.length ? `Interleaving: ${interleavedPracticeHints.join(' · ')}` : '',
        examCountdownHints.length ? `Exam plan: ${examCountdownHints.join(' · ')}` : '',
        examConstraintHints.length ? `Exam setup: ${examConstraintHints.join(' · ')}` : '',
        peerAccountabilityHints.length ? `Accountability: ${peerAccountabilityHints.join(' · ')}` : '',
        recurringRoutineHints.length ? `Routine: ${recurringRoutineHints.join(' · ')}` : '',
        blockedDependencyHints.length ? `Blockers: ${blockedDependencyHints.join(' · ')}` : '',
        evidenceConfidenceHints.length ? `Evidence confidence: ${evidenceConfidenceHints.join(' · ')}` : '',
        personalizedMemoryHints.length ? `Memory: ${personalizedMemoryHints.join(' · ')}` : '',
        studyRecoveryHints.length ? `Recovery: ${studyRecoveryHints.join(' · ')}` : '',
        gradeImpactHints.length ? `Grade impact: ${gradeImpactHints.join(' · ')}` : '',
        spacedReviewPlan.length ? `Spaced review: ${spacedReviewPlan.join(' · ')}` : '',
        focusHints.length ? `Focus: ${focusHints.join(' · ')}` : '',
        practiceHints.length ? `Practice: ${practiceHints.join(' · ')}` : '',
        retrievalHints.length ? `Recall: ${retrievalHints.join(' · ')}` : '',
        socraticHints.length ? `Tutor mode: ${socraticHints.join(' · ')}` : '',
        teachBackHints.length ? `Teach-back: ${teachBackHints.join(' · ')}` : '',
        learningHints.length ? `Study: ${learningHints.join(' · ')}` : '',
        privacyConsentHints.length ? `Privacy: ${privacyConsentHints.join(' · ')}` : '',
        integrityHints.length ? `Integrity: ${integrityHints.join(' · ')}` : ''
      ].find(Boolean) || '';
      row.dataset.urgency = triage.urgency;
      row.dataset.effort = triage.effort;
      row.dataset.actionBucket = actionBucket;
      row.innerHTML = `
        <span class="plan-deadline-date${overdue ? ' is-overdue' : ''}">${overdue ? 'OVERDUE' : dateLabel}</span>
        <span class="plan-deadline-title">${escapeHtml(item.title)}</span>
        <span class="plan-deadline-course">${escapeHtml(item.courseName || '')}</span>
        <span class="plan-deadline-triage" title="Planner triage: ${escapeHtml(actionBucket)}; ${escapeHtml(triage.urgency)} / ${escapeHtml(effortLabel)}${riskFlags.length ? `; risk flags: ${escapeHtml(riskFlags.join(', '))}` : ''}${checklist.length ? `; suggested checks: ${escapeHtml(checklist.join(', '))}` : ''}${reviewHints.length ? `; concepts to review: ${escapeHtml(reviewHints.join(', '))}` : ''}${codeDebugHints.length ? `; code/debug help: ${escapeHtml(codeDebugHints.join(', '))}` : ''}${officeHoursHints.length ? `; office hours prep: ${escapeHtml(officeHoursHints.join(', '))}` : ''}${collaborationHints.length ? `; collaboration handoff: ${escapeHtml(collaborationHints.join(', '))}` : ''}${lectureHints.length ? `; lecture capture: ${escapeHtml(lectureHints.join(', '))}` : ''}${confusionCaptureHints.length ? `; confusion capture: ${escapeHtml(confusionCaptureHints.join(', '))}` : ''}${sourceGroundingHints.length ? `; source grounding: ${escapeHtml(sourceGroundingHints.join(', '))}` : ''}${evidencePackHints.length ? `; evidence pack: ${escapeHtml(evidencePackHints.join(', '))}` : ''}${evidenceConfidenceHints.length ? `; evidence confidence: ${escapeHtml(evidenceConfidenceHints.join(', '))}` : ''}${tutorContextHints.length ? `; tutor context pack: ${escapeHtml(tutorContextHints.join(', '))}` : ''}${wrapUpHints.length ? `; wrap-up: ${escapeHtml(wrapUpHints.join(', '))}` : ''}${rubricHints.length ? `; rubric scoring: ${escapeHtml(rubricHints.join(', '))}` : ''}${preSubmitHints.length ? `; pre-submit verification: ${escapeHtml(preSubmitHints.join(', '))}` : ''}${availabilityWindowHints.length ? `; availability window: ${escapeHtml(availabilityWindowHints.join(', '))}` : ''}${csWorkflowHints.length ? `; CS workflow: ${escapeHtml(csWorkflowHints.join(', '))}` : ''}${commandSnippetHints.length ? `; command snippets: ${escapeHtml(commandSnippetHints.join(', '))}` : ''}${focusHints.length ? `; focus sprint: ${escapeHtml(focusHints.join(', '))}` : ''}${practiceHints.length ? `; practice assets: ${escapeHtml(practiceHints.join(', '))}` : ''}${retrievalHints.length ? `; retrieval calibration: ${escapeHtml(retrievalHints.join(', '))}` : ''}${metacognitiveHints.length ? `; metacognitive calibration: ${escapeHtml(metacognitiveHints.join(', '))}` : ''}${socraticHints.length ? `; Socratic tutor mode: ${escapeHtml(socraticHints.join(', '))}` : ''}${teachBackHints.length ? `; teach-back: ${escapeHtml(teachBackHints.join(', '))}` : ''}${privacyConsentHints.length ? `; privacy/consent: ${escapeHtml(privacyConsentHints.join(', '))}` : ''}${integrityHints.length ? `; integrity: ${escapeHtml(integrityHints.join(', '))}` : ''}">${escapeHtml(actionBucket === 'submitted' ? 'Submitted · review optional' : reviewLabel || checklistLabel)}</span>
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

  function normalizePlannerTokens(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9#+]+/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 3 && !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'due', 'study', 'block', 'work', 'review'].includes(token));
  }

  function findRelevantDeadlineForBlock(block, deadlines) {
    const deadlineItems = (Array.isArray(deadlines) ? deadlines : [])
      .map(item => ({ item, ts: Number(item && item.ts) }))
      .filter(entry => Number.isFinite(entry.ts));
    if (!deadlineItems.length) return null;

    const blockTitleTokens = new Set(normalizePlannerTokens(block?.title));
    const blockCourse = String(block?.course || '').trim().toLowerCase();
    let best = null;

    for (const entry of deadlineItems) {
      const item = entry.item || {};
      const titleTokens = normalizePlannerTokens(item.title || item.name || item.description || item.text || item.content);
      const course = String(item.courseName || item.course || '').trim().toLowerCase();
      let score = 0;
      for (const token of titleTokens) if (blockTitleTokens.has(token)) score += 2;
      if (blockCourse && course && (blockCourse === course || blockCourse.includes(course) || course.includes(blockCourse))) score += 3;
      if (score <= 0) continue;
      if (!best || score > best.score || (score === best.score && entry.ts < best.ts)) best = { ...entry, score };
    }

    return best ? best.item : null;
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
      const relevantDeadline = findRelevantDeadlineForBlock(block, deadlines);
      const relevantDeadlineTs = relevantDeadline ? Number(relevantDeadline.ts) : NaN;
      const deadlineLimit = Number.isFinite(relevantDeadlineTs) ? relevantDeadlineTs : lastDeadline;
      const latestEnd = deadlineLimit - DEADLINE_HANDOFF_BUFFER_MINUTES * 60 * 1000;
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
    __test: { classifyDeadline, compactDeadlineText, inferAssignmentResourceLinks, getSubmissionSnapshot, classifyActionBucket, getAssignmentPointValue, inferSubmissionChecklist, inferConceptReviewHints, inferGradeImpactHints, inferSubmissionStatusFlags, inferPlannerRiskFlags, inferStudyPhases, inferExecutionPlanHints, inferLearningStrategyHints, inferFocusSprintHints, inferPracticeArtifactHints, inferRetrievalCalibrationHints, inferSocraticStudyHints, inferTeachBackHints, inferAcademicIntegrityHints, inferPrivacyConsentHints, inferAccessibilityStudyHints, inferCodeDebugHints, inferMinimalReproHints, inferAutograderFeedbackHints, inferOfficeHoursPrepHints, inferCollaborationHandoffHints, inferLectureCaptureHints, inferLectureActionChecklistHints, inferSourceCoverageAuditHints, inferAiNoteQualityAuditHints, inferConfusionCaptureHints, inferAudioReviewHints, inferTranscriptStudyGuideHints, inferMultimodalStudyAssetHints, inferSourceGroundingHints, inferEvidencePackHints, inferTutorContextPackHints, inferFeedbackLoopHints, inferPortabilityBackupHints, inferStudyWrapUpHints, inferRubricScoringHints, inferPreSubmitVerificationHints, inferAvailabilityWindowHints, inferNotebookStudyPackHints, inferStudyPackArtifactHints, inferReadingTriageHints, inferLectureQuestionQueueHints, inferAiHandoffHints, inferCsWorkflowHints, inferCommandSnippetHints, inferAssignmentSpecExtractionHints, inferMilestoneDecompositionHints, inferRequirementClarificationHints, inferActivePracticeLoopHints, inferInterleavedPracticeHints, inferMetacognitiveCalibrationHints, inferSpacedReviewPlan, inferExamCountdownHints, inferExamConstraintHints, inferPeerStudyAccountabilityHints, inferRecurringRoutineHints, inferTimeEstimateCalibrationHints, inferBlockedDependencyHints, inferWorkedExampleHints, inferEvidenceConfidenceHints, inferChangeAwarenessHints, inferSpecDeltaHints, inferQuestionBankHints, inferAiQuizGenerationHints, inferFreshnessGuardHints, inferDueDateAmbiguityHints, inferHiddenDeadlineHints, inferAiStudySessionSetupHints, inferPersonalizedMemoryHints, inferNotebookLmStudyPlanHints, inferFirstStudyStepHints, inferStudyRecoveryHints, inferAssignmentQuestionQueueHints, inferAiSourceBoundaryHints, recommendTopStudyActions, recommendNextStudyAction, buildWorkloadTimeline, renderDeadlineList, buildPlannerPrompt, extractJsonArray, nextStudyWindowStart, findRelevantDeadlineForBlock, normalizeStudyBlocks, buildFallbackStudyBlocks, toLocalInputValue }
  };
})();
