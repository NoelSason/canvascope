import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'core', 'grade-target.js'), 'utf8');

// The module wraps in (function(root){...})(typeof self !== 'undefined' ? self : this).
// Provide a `self` so it attaches CanvascopeGradeTarget to our sandbox global.
globalThis.self = globalThis;
new Function(code)();
const GradeTarget = globalThis.CanvascopeGradeTarget;

// --- Fixture: a course with HW + Labs (drop-lowest 1 each), a graded Midterm,
//     and an ungraded Final worth 30%. Weights come from the syllabus. --------

const syllabus = {
  letterCutoffs: null, // fall back to standard scale (A=93, A-=90, B=83, D-=60)
  gradingScheme: [
    { category: 'Homework', weight: 20, dropLowest: 1 },
    { category: 'Labs', weight: 30, dropLowest: 1 },
    { category: 'Midterm', weight: 20 },
    { category: 'Final', weight: 30 }
  ]
};

const groups = [
  { id: 1, name: 'Homework', group_weight: 20 },
  { id: 2, name: 'Labs', group_weight: 30 },
  { id: 3, name: 'Midterm', group_weight: 20 },
  { id: 4, name: 'Final', group_weight: 30 }
];

const assignments = [
  // Homework: drop the 60. Kept 80,100,90 -> 270/300 = 90%
  { id: 11, name: 'HW1', assignment_group_id: 1, points_possible: 100, score: 80 },
  { id: 12, name: 'HW2', assignment_group_id: 1, points_possible: 100, score: 100 },
  { id: 13, name: 'HW3', assignment_group_id: 1, points_possible: 100, score: 60 },
  { id: 14, name: 'HW4', assignment_group_id: 1, points_possible: 100, score: 90 },
  // Labs: drop the 50%. Kept 40,50 -> 90/100 = 90%
  { id: 21, name: 'Lab1', assignment_group_id: 2, points_possible: 50, score: 40 },
  { id: 22, name: 'Lab2', assignment_group_id: 2, points_possible: 50, score: 50 },
  { id: 23, name: 'Lab3', assignment_group_id: 2, points_possible: 50, score: 25 },
  // Midterm: 85%
  { id: 31, name: 'Midterm', assignment_group_id: 3, points_possible: 100, score: 85 },
  // Final: ungraded, 200 pts, worth 30%
  { id: 41, name: 'Final', assignment_group_id: 4, points_possible: 200, score: null }
];

test('weights are sourced from the syllabus, not Canvas group_weight', () => {
  const r = GradeTarget.compute({ assignments, groups, syllabus, targetLetter: 'A-' });
  assert.equal(r.weightSource, 'syllabus');
});

test('drop-lowest applied to HW and Labs; current weighted grade = 88.57%', () => {
  const r = GradeTarget.compute({ assignments, groups, syllabus, targetLetter: 'A-' });
  // graded weights: HW20*.9 + Labs30*.9 + Mid20*.85 = 62 over weight 70 = 88.571%
  assert.equal(r.current, 88.57);
});

test('A- (90%) is reachable: need 93.33% average on the final', () => {
  const r = GradeTarget.compute({ assignments, groups, syllabus, targetLetter: 'A-' });
  // a = 0.62, b = 0.30 -> x = (0.90 - 0.62)/0.30 = 0.9333
  assert.equal(r.status, 'need');
  assert.equal(r.neededAvg, 93.33);
  assert.equal(r.remainingPoints, 200);
  assert.deepEqual(r.target, { letter: 'A-', pct: 90 });
});

test('A (93%) is impossible: max final caps below 93', () => {
  const r = GradeTarget.compute({ assignments, groups, syllabus, targetLetter: 'A' });
  // even 100% on the final: 0.62 + 0.30 = 0.92 < 0.93
  assert.equal(r.status, 'impossible');
});

test('a low target is already secured regardless of the final', () => {
  const r = GradeTarget.compute({ assignments, groups, syllabus, targetLetter: 'D-' });
  // a = 0.62 >= 0.60 even with 0 on the final
  assert.equal(r.status, 'secured');
});

test('fuzzy category match maps a Canvas group to a syllabus category', () => {
  const cat = GradeTarget.matchCategory('Homework Assignments', syllabus.gradingScheme);
  assert.equal(cat.category, 'Homework');
});

test('falls back to Canvas weights when no syllabus scheme is present', () => {
  const r = GradeTarget.compute({ assignments, groups, syllabus: {}, targetLetter: 'A-' });
  assert.equal(r.weightSource, 'canvas');
  // No syllabus drop rules now apply, so the 60 HW and 25 lab are NOT dropped:
  // HW 330/400=82.5, Labs 115/150=76.67, Mid 85 over weights 20/30/20 -> 80.71%
  assert.equal(r.current, 80.71);
});

// --- Points-based grading (Chem 3BL: 165 total, best 9 of 10 labs @15 + 30-pt
//     exam, A = 153-161 points). Letter cutoffs are POINTS, not percentages. ---

const ptsSyllabus = {
  gradeBasis: 'points',
  totalPoints: 165,
  gradingScheme: [
    { category: 'Lab Assignments', weight: 0, points: 135, dropLowest: 1 },
    { category: 'Lab Exam', weight: 0, points: 30 }
  ],
  letterCutoffs: [
    { letter: 'A+', min: 162 }, { letter: 'A', min: 153 }, { letter: 'A-', min: 148 },
    { letter: 'B+', min: 140 }, { letter: 'B', min: 132 }, { letter: 'F', min: 0 }
  ]
};
const ptsGroups = [
  { id: 1, name: 'Lab Assignments', group_weight: 0 },
  { id: 2, name: 'Lab Exam', group_weight: 0 }
];
// 10 labs @15 graded (drop lowest 1), exam ungraded (30 pts remaining).
function lab(id, score) { return { id, name: `Lab ${id}`, assignment_group_id: 1, points_possible: 15, score }; }
const ptsAssignments = [
  lab(1, 15), lab(2, 14), lab(3, 15), lab(4, 13), lab(5, 15),
  lab(6, 12), lab(7, 15), lab(8, 14), lab(9, 15), lab(10, 9), // 9 is lowest -> dropped
  { id: 99, name: 'Final Lab Exam', assignment_group_id: 2, points_possible: 30, score: null }
];

test('points-based: detects points mode and computes points needed on the exam', () => {
  const r = GradeTarget.compute({ assignments: ptsAssignments, groups: ptsGroups, syllabus: ptsSyllabus, targetLetter: 'A' });
  assert.equal(r.basis, 'points');
  // best 9 of 10: drop the 9 -> kept = 15+14+15+13+15+12+15+14+15 = 128 lab pts
  assert.equal(r.currentPoints, 128);
  assert.equal(r.remainingPoints, 30);
  assert.deepEqual(r.target, { letter: 'A', pts: 153 });
  // need 153 - 128 = 25 of the remaining 30 exam points -> 83.33%
  assert.equal(r.status, 'need');
  assert.equal(r.neededPoints, 25);
  assert.equal(r.neededAvg, 83.33);
});

test('points-based: A+ (162) is impossible with only 30 exam points left', () => {
  const r = GradeTarget.compute({ assignments: ptsAssignments, groups: ptsGroups, syllabus: ptsSyllabus, targetLetter: 'A+' });
  // need 162 - 128 = 34 > 30 remaining
  assert.equal(r.status, 'impossible');
});

test('points-based: B (132) already secured before the exam', () => {
  const r = GradeTarget.compute({ assignments: ptsAssignments, groups: ptsGroups, syllabus: ptsSyllabus, targetLetter: 'B' });
  // 128 lab pts already < 132, but only 4 pts needed of 30 remaining -> "need", not secured
  assert.equal(r.status, 'need');
  assert.equal(r.neededPoints, 4);
});
