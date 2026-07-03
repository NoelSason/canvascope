/**
 * Canvascope — Grade Target Calculator (deterministic, no LLM)
 *
 * Answers "what do I need to get an A?" by combining:
 *   - LIVE per-assignment scores from the Canvas gradebook
 *     (csTools.fetchGradebook → { assignments, groups }), and
 *   - the grading WEIGHTS + drop-lowest rules from the parsed syllabus memory
 *     (gradingScheme, letterCutoffs). Per the product decision: trust Canvas for
 *     actual scores, trust the syllabus for how they're weighted.
 *
 * The math is plain arithmetic on purpose — LLMs are unreliable at it. The model
 * only ever phrases the result string; the numbers come from here.
 *
 * Exposes both a browser global (self.CanvascopeGradeTarget) and a CommonJS
 * export so the logic can be unit-tested under Node (tests/grade-target.test.mjs).
 */
(function (root) {
  'use strict';

  // Standard US letter scale — fallback when neither the syllabus nor the
  // shared SyllabusMemory default is available (e.g. unit tests).
  const FALLBACK_CUTOFFS = [
    { letter: 'A', min: 93 }, { letter: 'A-', min: 90 },
    { letter: 'B+', min: 87 }, { letter: 'B', min: 83 }, { letter: 'B-', min: 80 },
    { letter: 'C+', min: 77 }, { letter: 'C', min: 73 }, { letter: 'C-', min: 70 },
    { letter: 'D+', min: 67 }, { letter: 'D', min: 63 }, { letter: 'D-', min: 60 },
    { letter: 'F', min: 0 }
  ];

  // ---- name normalization / fuzzy category matching -----------------------

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(s)\b/g, '')      // stray plural tokens
      .replace(/s\b/g, '')          // homeworks -> homework, labs -> lab
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) {
    return new Set(norm(s).split(' ').filter(Boolean));
  }

  /** Best-matching syllabus category for a Canvas group name, or null. */
  function matchCategory(groupName, categories) {
    const g = norm(groupName);
    if (!g) return null;
    let best = null;
    let bestScore = 0;
    for (const cat of categories) {
      const c = norm(cat.category);
      if (!c) continue;
      let score = 0;
      if (c === g) score = 1;
      else if (c.includes(g) || g.includes(c)) score = 0.85;
      else {
        const tg = tokens(groupName);
        const tc = tokens(cat.category);
        let inter = 0;
        tg.forEach((t) => { if (tc.has(t)) inter++; });
        const union = new Set([...tg, ...tc]).size || 1;
        score = inter / union;
      }
      if (score > bestScore) { bestScore = score; best = cat; }
    }
    return bestScore >= 0.5 ? best : null;
  }

  // ---- core --------------------------------------------------------------

  function asPct(score, points) {
    return points > 0 ? (Number(score) / Number(points)) : 0;
  }

  /**
   * Group assignments into weighted categories.
   *
   * @param {Array} assignments - { id, name, assignment_group_id, points_possible,
   *                                score, omit_from_final_grade }
   * @param {Array} groups - Canvas assignment_groups: { id, name, group_weight, rules }
   * @param {Object} syllabus - { gradingScheme:[{category,weight,dropLowest}], letterCutoffs }
   * @returns {{ categories: Array, weightSource: 'syllabus'|'canvas' }}
   */
  function buildCategories(assignments, groups, syllabus) {
    const scheme = Array.isArray(syllabus && syllabus.gradingScheme) ? syllabus.gradingScheme : [];
    const useSyllabus = scheme.length > 0;
    const groupById = {};
    (groups || []).forEach((g) => { groupById[String(g.id)] = g; });

    // Map each Canvas group -> a category key + weight + dropLowest.
    const catByKey = {};
    function ensureCat(key, weight, dropLowest, label) {
      if (!catByKey[key]) {
        catByKey[key] = { category: label || key, weight: Number(weight) || 0, dropLowest: dropLowest || 0, items: [] };
      } else {
        // keep the larger declared drop rule if groups collide into one category
        catByKey[key].dropLowest = Math.max(catByKey[key].dropLowest, dropLowest || 0);
      }
      return catByKey[key];
    }

    function categoryForGroup(group) {
      if (useSyllabus) {
        const match = group ? matchCategory(group.name, scheme) : null;
        if (match) {
          return ensureCat(norm(match.category), match.weight, match.dropLowest || 0, match.category);
        }
        // Unmatched group: fall back to its own Canvas weight so it still counts.
        const cw = group ? Number(group.group_weight) || 0 : 0;
        const dl = group && group.rules ? Number(group.rules.drop_lowest) || 0 : 0;
        return ensureCat('canvas:' + (group ? group.id : 'none'), cw, dl, group ? group.name : 'Other');
      }
      const cw = group ? Number(group.group_weight) || 0 : 0;
      const dl = group && group.rules ? Number(group.rules.drop_lowest) || 0 : 0;
      return ensureCat('canvas:' + (group ? group.id : 'none'), cw, dl, group ? group.name : 'Other');
    }

    (assignments || []).forEach((a) => {
      if (a.omit_from_final_grade) return;
      const pts = Number(a.points_possible);
      if (!(pts > 0)) return; // ungraded/practice with no weight
      const group = groupById[String(a.assignment_group_id)] || null;
      const cat = categoryForGroup(group);
      const scoreRaw = a.score != null ? a.score : (a.submission && a.submission.score);
      cat.items.push({
        name: a.name,
        points: pts,
        score: scoreRaw == null ? null : Number(scoreRaw),
        graded: scoreRaw != null
      });
    });

    return { categories: Object.values(catByKey), weightSource: useSyllabus ? 'syllabus' : 'canvas' };
  }

  /**
   * Apply drop-lowest to the GRADED items of a category and split into kept
   * graded vs remaining (ungraded) sets. Drop-lowest is applied conservatively
   * to graded work only — we can't know which future scores would be dropped.
   */
  function partitionCategory(cat) {
    const graded = cat.items.filter((i) => i.graded);
    const remaining = cat.items.filter((i) => !i.graded);
    let keptGraded = graded;
    if (cat.dropLowest > 0 && graded.length > cat.dropLowest) {
      keptGraded = graded
        .slice()
        .sort((a, b) => asPct(b.score, b.points) - asPct(a.score, a.points))
        .slice(0, graded.length - cat.dropLowest);
    }
    const G = keptGraded.reduce((s, i) => s + i.score, 0);          // earned points (graded)
    const GP = keptGraded.reduce((s, i) => s + i.points, 0);        // possible points (graded)
    const RP = remaining.reduce((s, i) => s + i.points, 0);         // possible points (remaining)
    return { keptGraded, remaining, G, GP, RP };
  }

  /** Resolve a target letter (e.g. 'A') to its minimum percentage. */
  function cutoffFor(letter, letterCutoffs) {
    const list = (Array.isArray(letterCutoffs) && letterCutoffs.length)
      ? letterCutoffs
      : ((root.CanvascopeSyllabusMemory && root.CanvascopeSyllabusMemory.DEFAULT_LETTER_CUTOFFS) || FALLBACK_CUTOFFS);
    const want = String(letter || '').trim().toUpperCase();
    const hit = list.find((c) => String(c.letter).toUpperCase() === want);
    return hit ? Number(hit.min) : null;
  }

  /**
   * Main entry. Returns current weighted grade and what's needed on remaining
   * work to reach the target letter.
   *
   * @returns {{
   *   current: number|null,            // current weighted % (graded categories), or null if nothing graded
   *   weightSource: string,
   *   target: { letter, pct }|null,
   *   neededAvg: number|null,          // % needed on each remaining point
   *   remainingPoints: number,
   *   status: 'secured'|'need'|'impossible'|'no-target'|'no-remaining'|'no-data',
   *   breakdown: Array                 // per-category {category, weight, earnedPct, gradedPts, remainingPts}
   * }}
   */
  // Points-based courses (e.g. "165 total: best 9 of 10 labs @15 + 30-pt exam,
  // A = 153-161 pts") assign letters by absolute point totals, not weighted
  // percentages. Detect that so we run the right math.
  function detectBasis(syllabus) {
    if (!syllabus) return 'percent';
    if (syllabus.gradeBasis === 'points') return 'points';
    const cutoffs = Array.isArray(syllabus.letterCutoffs) ? syllabus.letterCutoffs : [];
    if (cutoffs.some((c) => Number(c.min) > 100)) return 'points';
    return 'percent';
  }

  function buildBreakdown(parts) {
    return parts
      .filter((p) => p.GP + p.RP > 0)
      .map((p) => ({
        category: p.cat.category,
        weight: p.cat.weight,
        dropLowest: p.cat.dropLowest,
        earnedPct: p.GP > 0 ? +(100 * p.G / p.GP).toFixed(2) : null,
        gradedPts: p.GP,
        remainingPts: p.RP
      }));
  }

  // Absolute-points model: sum earned/remaining points across categories (after
  // drop-lowest), compare against the target letter's POINT cutoff.
  function computePoints(parts, syllabus, targetLetter, weightSource) {
    const breakdown = buildBreakdown(parts);
    const earned = parts.reduce((s, p) => s + p.G, 0);
    const gradedPossible = parts.reduce((s, p) => s + p.GP, 0);
    const remaining = parts.reduce((s, p) => s + p.RP, 0);
    const current = gradedPossible > 0 ? +(100 * earned / gradedPossible).toFixed(2) : null;
    const totalPoints = Number(syllabus && syllabus.totalPoints) || (gradedPossible + remaining);

    const cutoffs = Array.isArray(syllabus && syllabus.letterCutoffs) ? syllabus.letterCutoffs : [];
    const hit = cutoffs.find((c) => String(c.letter).toUpperCase() === String(targetLetter || '').toUpperCase());
    const targetPts = hit ? Number(hit.min) : null;

    const base = {
      basis: 'points', current, currentPoints: +earned.toFixed(2), totalPoints,
      weightSource, remainingPoints: +remaining.toFixed(2), breakdown
    };
    if (targetPts == null) return { ...base, target: null, neededPoints: null, neededAvg: null, status: 'no-target' };

    base.target = { letter: targetLetter, pts: targetPts };
    if (remaining <= 0) {
      return { ...base, neededPoints: Math.max(0, +(targetPts - earned).toFixed(2)), neededAvg: null,
        status: earned >= targetPts ? 'secured' : 'impossible', finalIfNothingChanges: +earned.toFixed(2) };
    }
    const pointsNeeded = targetPts - earned;
    if (pointsNeeded <= 0) return { ...base, neededPoints: 0, neededAvg: 0, status: 'secured' };
    const neededAvg = +(100 * pointsNeeded / remaining).toFixed(2);
    return {
      ...base,
      neededPoints: +pointsNeeded.toFixed(2),
      neededAvg,
      status: pointsNeeded > remaining + 1e-9 ? 'impossible' : 'need'
    };
  }

  function compute(opts) {
    const { assignments, groups, syllabus, targetLetter } = opts || {};
    const { categories, weightSource } = buildCategories(assignments, groups, syllabus);

    const parts = categories.map((cat) => {
      const p = partitionCategory(cat);
      return { cat, ...p };
    });

    if (detectBasis(syllabus) === 'points') {
      return computePoints(parts, syllabus, targetLetter, weightSource);
    }

    const breakdown = buildBreakdown(parts);

    // Current grade: weighted over categories that HAVE graded work (Canvas-style
    // renormalization across graded groups).
    let curW = 0, curSum = 0;
    parts.forEach((p) => {
      if (p.GP > 0 && p.cat.weight > 0) {
        curW += p.cat.weight;
        curSum += p.cat.weight * (p.G / p.GP);
      }
    });
    const current = curW > 0 ? +(100 * curSum / curW).toFixed(2) : null;

    const targetPct = cutoffFor(targetLetter, syllabus && syllabus.letterCutoffs);
    if (targetPct == null) {
      return { current, weightSource, target: null, neededAvg: null, remainingPoints: 0, status: 'no-target', breakdown };
    }

    // Final projection: renormalize weights across categories that will have any
    // assignments (graded or remaining). overall(x) = A + B*x, x = uniform
    // fraction earned on remaining work.
    let W = 0, A = 0, B = 0, remainingPoints = 0;
    parts.forEach((p) => {
      const denom = p.GP + p.RP;
      if (denom <= 0 || p.cat.weight <= 0) return;
      W += p.cat.weight;
      A += p.cat.weight * (p.G / denom);
      B += p.cat.weight * (p.RP / denom);
      remainingPoints += p.RP;
    });

    if (W <= 0) {
      return { current, weightSource, target: { letter: targetLetter, pct: targetPct }, neededAvg: null, remainingPoints: 0, status: 'no-data', breakdown };
    }

    const targetFrac = targetPct / 100;
    const a = A / W;          // guaranteed-so-far fraction
    const b = B / W;          // sensitivity to remaining work

    if (b <= 0) {
      // No remaining gradable work — the grade is locked in.
      const finalPct = +(100 * a).toFixed(2);
      return {
        current, weightSource,
        target: { letter: targetLetter, pct: targetPct },
        neededAvg: null, remainingPoints: 0,
        status: a >= targetFrac ? 'secured' : 'impossible',
        finalIfNothingChanges: finalPct,
        breakdown
      };
    }

    const x = (targetFrac - a) / b;          // fraction needed on each remaining point
    const neededAvg = +(100 * x).toFixed(2);
    let status;
    if (x <= 0) status = 'secured';
    else if (x > 1.0000001) status = 'impossible';
    else status = 'need';

    return {
      current, weightSource,
      target: { letter: targetLetter, pct: targetPct },
      neededAvg, remainingPoints,
      status, breakdown
    };
  }

  function formatPoints(r, where) {
    const tgt = r.target ? `${r.target.letter}` : 'that grade';
    const cur = r.currentPoints != null ? `${r.currentPoints} pts` : 'n/a';
    if (r.status === 'no-target') return `I couldn't find that letter grade in the syllabus's grading scale.`;
    if (r.status === 'no-data') return `I don't have enough graded work yet${where} to project your grade. Once some assignments are graded, ask again.`;
    if (r.status === 'secured') return `You've locked in **${tgt}**${where} — you're at **${cur}**, at or above the **${r.target.pts} pts** it needs. 🎉`;
    if (r.status === 'impossible') return `Reaching **${tgt}**${where} (needs **${r.target.pts} pts**) isn't possible anymore — you have **${cur}** with only **${r.remainingPoints} pts** left to earn.`;
    if (r.status === 'need') return `To get **${tgt}**${where}, you need **${r.neededPoints} more points** from the **${r.remainingPoints} pts** still up for grabs — about **${r.neededAvg}%** on what's left. You're at **${cur}** so far (target: ${r.target.pts} pts).`;
    return `You're at **${cur}**${where}.`;
  }

  /** Render a deterministic markdown answer from a compute() result. */
  function formatAnswer(result, courseName) {
    const where = courseName ? ` in **${courseName}**` : '';
    if (!result) return 'I could not compute that.';
    if (result.basis === 'points') return formatPoints(result, where);
    const cur = result.current != null ? `${result.current}%` : 'n/a';
    const tgt = result.target ? `${result.target.letter} (${result.target.pct}%)` : 'that grade';

    if (result.status === 'no-data') {
      return `I don't have enough graded work yet to project your${where} grade. Once a few assignments are graded, ask again.`;
    }
    if (result.status === 'no-target') {
      return `I couldn't find that letter grade in the syllabus's grading scale.`;
    }
    if (result.status === 'secured') {
      return `You've already locked in **${tgt}**${where} — your current weighted grade is **${cur}** and remaining work can't drop you below it. 🎉`;
    }
    if (result.status === 'impossible') {
      const fin = result.finalIfNothingChanges != null ? ` Even with 100% on everything left, you'd finish around **${result.finalIfNothingChanges}%**.` : '';
      return `Reaching **${tgt}**${where} isn't mathematically possible anymore — your current weighted grade is **${cur}**.${fin}`;
    }
    if (result.status === 'need') {
      return `To get **${tgt}**${where}, you need to average **${result.neededAvg}%** on your remaining work (worth ${result.remainingPoints} points). Your current weighted grade is **${cur}**.`;
    }
    return `Current weighted grade${where}: **${cur}**.`;
  }

  const api = { compute, formatAnswer, buildCategories, partitionCategory, matchCategory, cutoffFor, norm };

  root.CanvascopeGradeTarget = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
