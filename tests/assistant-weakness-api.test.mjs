import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeStudyCoachDataset } from "../src/assistant-weakness-api.js";

const valid = {
  schemaVersion: 2,
  consentVersion: 2,
  generatedAt: "2026-08-06T12:00:00.000Z",
  selectionPolicy: "attempted-flagged-annotated-priority",
  decks: [{ id: "ks", title: "K&S", version: "1", totalQuestions: 10, usedQuestions: 1, domains: [{
    title: "Mood", totalQuestions: 10, usedQuestions: 1, attempts: 1, accuracy: 0.5,
    averageTimeMs: 40000, evidence: "limited", priorityScore: 62, mastered: false,
  }] }],
  completedTests: [{ setId: "set-1", bankIds: ["ks"], mode: "test", timed: true,
    startedAt: "2026-08-06T11:00:00.000Z", completedAt: "2026-08-06T12:00:00.000Z",
    questionCount: 10, answered: 9, correct: 7, incorrect: 2, omitted: 1, totalTimeMs: 400000 }],
  coachingItems: [{
    bankId: "ks", questionId: "q1", subject: "Mood", testSection: "Test 1",
    prompt: "Example prompt", vignetteStem: "", choices: [{ letter: "A", text: "One" }, { letter: "B", text: "Two" }],
    selectedAnswer: "A", correctAnswer: ["B"], answerText: "B", explanation: "Example explanation", note: "Review",
    isCorrect: false, isFlagged: true, timesUsed: 1, totalTimeMs: 40000, lastUsedAt: "2026-08-06T11:00:00.000Z",
  }],
  totalEligibleCoachingItems: 1,
  truncated: false,
};

test("server rebuilds the Study Coach dataset from a strict allowlist", () => {
  const sanitized = sanitizeStudyCoachDataset({ ...valid, credential: "must disappear", browserHistory: ["must disappear"] });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /credential|browserHistory|must disappear/);
  assert.equal(sanitized.schemaVersion, 2);
  assert.deepEqual(sanitized.coachingItems[0].selectedAnswer, ["A"]);
});

test("server rejects stale consent, oversized arrays, and invalid ratios", () => {
  assert.throws(() => sanitizeStudyCoachDataset({ ...valid, consentVersion: 1 }), /schema/);
  assert.throws(() => sanitizeStudyCoachDataset({ ...valid, coachingItems: Array.from({ length: 201 }, () => valid.coachingItems[0]) }), /schema/);
  const invalid = structuredClone(valid);
  invalid.decks[0].domains[0].accuracy = 2;
  assert.throws(() => sanitizeStudyCoachDataset(invalid), /accuracy/);
});
