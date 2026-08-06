import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStudyCoachDataset, buildWeaknessSnapshot } from '../src/client/weakness-analytics.js';

const bank = {
  questions: [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, chapterTitle: 'Mood', subjectTitle: 'Mood', question: `Private mood ${index}`, vignetteStem: '', choices: ['One', 'Two'], choiceLetters: ['A', 'B'], correctLetters: ['B'], answerText: 'B', explanation: 'Mood explanation' })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, chapterTitle: 'Psychosis', subjectTitle: 'Psychosis', question: `Private psychosis ${index}`, vignetteStem: '', choices: ['One', 'Two'], choiceLetters: ['A', 'B'], correctLetters: ['B'], answerText: 'B', explanation: 'Psychosis explanation' })),
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

test('Study Coach dataset includes coaching-relevant content but excludes unrelated data', () => {
  const fullBank = { ...bank, id: 'ks', title: 'K&S', version: '1' };
  const rows = [...progress.entries()].map(([questionId, row]) => ({ ...row, bankId: 'ks', questionId }));
  const dataset = buildStudyCoachDataset([fullBank], rows, { now }, {
    sets: [{ id: 'set-1', bankId: 'ks', selectedBankIds: ['ks'], status: 'completed', mode: 'test', timed: true, questionIds: ['m0', 'p0'], startedAt: now, completedAt: now }],
    answers: [{ setId: 'set-1', questionId: 'm0', selectedAnswer: 'A', isCorrect: false, timeMs: 2_000 }],
  });
  assert.equal(dataset.schemaVersion, 2);
  assert.equal(dataset.consentVersion, 2);
  assert.equal(dataset.coachingItems.length, 10);
  assert.deepEqual(dataset.completedTests[0], {
    setId: 'set-1', bankIds: ['ks'], mode: 'test', timed: true, startedAt: now, completedAt: now,
    questionCount: 2, answered: 1, correct: 0, incorrect: 1, omitted: 1, totalTimeMs: 2_000,
  });
  assert.match(dataset.coachingItems[0].prompt, /Private/);
  assert.doesNotMatch(JSON.stringify(dataset), /credential|browserHistory|password|accessToken/i);
});
