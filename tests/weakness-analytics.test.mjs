import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeaknessSnapshot } from '../src/client/weakness-analytics.js';

const bank = {
  questions: [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, chapterTitle: 'Mood', question: `Private mood ${index}` })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, chapterTitle: 'Psychosis', question: `Private psychosis ${index}` })),
  ],
};

const now = '2026-08-03T12:00:00.000Z';
const progress = new Map([
  ...Array.from({ length: 5 }, (_, index) => [`m${index}`, {
    timesUsed: 1,
    isCorrect: index < 4,
    totalTimeMs: 1_000,
    lastUsedAt: '2026-08-02T12:00:00.000Z',
  }]),
  ...Array.from({ length: 5 }, (_, index) => [`p${index}`, {
    timesUsed: 2,
    isCorrect: false,
    totalTimeMs: 8_000,
    lastUsedAt: '2026-08-03T11:00:00.000Z',
  }]),
]);

test('ranks a supported weak and slow domain above a stronger domain', () => {
  const snapshot = buildWeaknessSnapshot(bank, progress, { now });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.evidenceModel, 'limited-current-state');
  assert.equal(snapshot.domains[0].title, 'Psychosis');
  assert.equal(snapshot.domains[0].evidence, 'adequate');
  assert.ok(snapshot.domains[0].priorityScore > snapshot.domains[1].priorityScore);
  assert.equal(snapshot.evidenceCoverage, 1);
});

test('labels small samples and does not claim mastery without adequate evidence', () => {
  const limited = buildWeaknessSnapshot(bank, new Map([['m0', progress.get('m0')]]), { now });
  const mood = limited.domains.find((domain) => domain.title === 'Mood');
  assert.equal(mood.evidence, 'limited');
  assert.equal(mood.mastered, false);
  assert.equal(limited.masteryCoverage, 0);
});

test('returns only derived aggregates without question or answer content', () => {
  const serialized = JSON.stringify(buildWeaknessSnapshot(bank, progress, { now }));
  assert.doesNotMatch(serialized, /Private mood|Private psychosis|selectedAnswer|correctLetter/);
});

test('is deterministic when the calculation time is supplied', () => {
  assert.deepEqual(
    buildWeaknessSnapshot(bank, progress, { now }),
    buildWeaknessSnapshot(bank, progress, { now }),
  );
});
