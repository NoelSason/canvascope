import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const courseMaterialsPath = path.resolve(__dirname, '..', 'src', 'core', 'course-materials.js');
const courseMaterialsCode = fs.readFileSync(courseMaterialsPath, 'utf8');

let mockStorage = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          out[key] = mockStorage[key];
        }
        return out;
      },
      set: async (obj) => {
        mockStorage = { ...mockStorage, ...obj };
      }
    }
  },
  runtime: {
    sendMessage: (_message, cb) => cb?.({ success: false, error: 'disabled' })
  }
};

new Function(courseMaterialsCode)();

test('CourseMaterials parses Canvas week date ranges with the current year', () => {
  const range = CanvascopeCourseMaterials.parseWeekDateRange(
    'Week 2: Jun. 29 - Jul. 1',
    new Date(2026, 5, 30)
  );
  assert.deepEqual(range, { start: '2026-06-29', end: '2026-07-01' });
});

test('CourseMaterials stores parsed PDFs as searchable page chunks', async () => {
  mockStorage = {};
  const doc = CanvascopeCourseMaterials.normalizeDocument({
    courseId: '102',
    courseName: 'MCB 102',
    canvasFileId: '501',
    title: 'Lecture 1.4 - Enzymes - Thermodynamics.pdf',
    sourceUrl: 'https://bcourses.berkeley.edu/courses/102/files/501',
    downloadUrl: 'https://bcourses.berkeley.edu/files/501/download',
    folderPath: 'Survey of the Principles of Biochemistry and Molecular Biology (Summer 2026) > Week 2: Jun. 29 - Jul. 1',
    moduleName: 'Week 2: Jun. 29 - Jul. 1',
    mimeType: 'application/pdf'
  }, new Date(2026, 5, 30));

  await CanvascopeCourseMaterials.upsertDiscoveredDocuments([doc], { today: new Date(2026, 5, 30) });
  await CanvascopeCourseMaterials.storeParsedPdf(doc, [
    'Lecture 1.4 introduces enzymes, Gibbs free energy, equilibrium, and thermodynamics.',
    'Enzyme catalysis connects reaction spontaneity to transition-state stabilization.'
  ]);

  const { courseMaterialDocuments, courseMaterialChunks } = mockStorage;
  assert.equal(courseMaterialDocuments.length, 1);
  assert.equal(courseMaterialDocuments[0].status, 'indexed');
  assert.equal(courseMaterialDocuments[0].weekStart, '2026-06-29');
  assert.equal(courseMaterialChunks.length, 2);
  assert.equal(courseMaterialChunks[0].pageStart, 1);
});

test('CourseMaterials scopes this-week summaries to the active course and filters answer keys', async () => {
  mockStorage = {};
  await CanvascopeCourseMaterials.upsertDiscoveredDocuments([
    {
      courseId: '102',
      courseName: 'MCB 102',
      canvasFileId: '501',
      title: 'Lecture 1.4 - Enzymes - Thermodynamics.pdf',
      sourceUrl: 'https://bcourses.berkeley.edu/courses/102/files/501',
      downloadUrl: 'https://bcourses.berkeley.edu/files/501/download',
      folderPath: 'Survey of the Principles of Biochemistry and Molecular Biology (Summer 2026) > Week 2: Jun. 29 - Jul. 1',
      moduleName: 'Week 2: Jun. 29 - Jul. 1',
      mimeType: 'application/pdf'
    },
    {
      courseId: '102',
      courseName: 'MCB 102',
      canvasFileId: '502',
      title: 'Lecture 1.5 Enzymes - Kinetics & Inhibition.pdf',
      sourceUrl: 'https://bcourses.berkeley.edu/courses/102/files/502',
      downloadUrl: 'https://bcourses.berkeley.edu/files/502/download',
      folderPath: 'Survey of the Principles of Biochemistry and Molecular Biology (Summer 2026) > Week 2: Jun. 29 - Jul. 1',
      moduleName: 'Week 2: Jun. 29 - Jul. 1',
      mimeType: 'application/pdf'
    },
    {
      courseId: '8A',
      courseName: 'Chem 8A',
      canvasFileId: '900',
      title: '8A_W3_Solutions.pdf',
      sourceUrl: 'https://bcourses.berkeley.edu/courses/8/files/900',
      downloadUrl: 'https://bcourses.berkeley.edu/files/900/download',
      folderPath: 'Week 3',
      mimeType: 'application/pdf'
    }
  ], { today: new Date(2026, 5, 30) });

  const docs = mockStorage.courseMaterialDocuments;
  await CanvascopeCourseMaterials.storeParsedPdf(docs.find(doc => doc.canvasFileId === '501'), [
    'Enzyme thermodynamics covers Gibbs free energy, reaction coupling, and equilibrium.'
  ]);
  await CanvascopeCourseMaterials.storeParsedPdf(docs.find(doc => doc.canvasFileId === '502'), [
    'Enzyme kinetics covers Michaelis-Menten behavior, Km, Vmax, competitive inhibition, and allosteric control.'
  ]);
  await CanvascopeCourseMaterials.storeParsedPdf(docs.find(doc => doc.canvasFileId === '900'), [
    'Organic chemistry solutions answer key.'
  ]);

  const result = await CanvascopeCourseMaterials.searchLocal('what am i learning in mcb 102 this week?', {
    courseId: '102',
    today: new Date(2026, 5, 30),
    limit: 6
  });

  assert.ok(result.chunks.some(chunk => chunk.title.includes('Thermodynamics')));
  assert.ok(result.chunks.some(chunk => chunk.title.includes('Kinetics')));
  assert.ok(result.chunks.every(chunk => chunk.courseId === '102'));
  assert.ok(!result.chunks.some(chunk => /Solutions/i.test(chunk.title)));
  assert.deepEqual(result.status.currentWeek.weekStart, '2026-06-29');
  assert.deepEqual(result.status.currentWeek.weekEnd, '2026-07-01');
});
