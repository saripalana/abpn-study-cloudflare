import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateSessionResult,
  calculateSessionSectionResults,
  isSessionAnswerCorrect,
  progressEntriesForSession,
  totalAnswerTimeMs,
} from "../public/client/multi-deck-results.js";
import { createMultiDeckSetRecord } from "../public/client/multi-deck-set.js";
import { encodeQuestionRef } from "../public/client/multi-deck-practice.js";

const decks = [
  {
    id: "ks",
    title: "K&S",
    shortTitle: "K&S",
    questions: [{ id: "1", correctLetter: "A" }],
    byId: new Map([["1", { id: "1", correctLetter: "A" }]]),
  },
  {
    id: "spiegel",
    title: "Spiegel",
    shortTitle: "Spiegel",
    questions: [{ id: "1", correctLetter: "B" }],
    byId: new Map([["1", { id: "1", correctLetter: "B" }]]),
  },
];

const set = createMultiDeckSetRecord({
  id: "set-1",
  references: [encodeQuestionRef("ks", "1"), encodeQuestionRef("spiegel", "1")],
  selectedBankIds: ["ks", "spiegel"],
  mode: "test",
  timed: false,
  remainingSeconds: 0,
  startedAt: "2026-07-23T00:00:00.000Z",
});

test("scores duplicate raw question IDs independently by source deck", () => {
  const answers = new Map([
    [encodeQuestionRef("ks", "1"), { selectedAnswer: "A", isCorrect: true, timeMs: 1000 }],
    [encodeQuestionRef("spiegel", "1"), { selectedAnswer: "A", isCorrect: false, timeMs: 2000 }],
  ]);
  const result = calculateSessionResult(decks, set, answers);
  assert.deepEqual(
    { total: result.total, answered: result.answered, correct: result.correct, incorrect: result.incorrect, omitted: result.omitted },
    { total: 2, answered: 2, correct: 1, incorrect: 1, omitted: 0 },
  );
  assert.deepEqual(result.byBank.map(({ title, correct, incorrect }) => ({ title, correct, incorrect })), [
    { title: "K&S", correct: 1, incorrect: 0 },
    { title: "Spiegel", correct: 0, incorrect: 1 },
  ]);
});

test("recalculates multi-select correctness from selected and correct letters", () => {
  const question = { correctLetters: ["A", "C"], isMultiSelect: true };
  assert.equal(isSessionAnswerCorrect(question, {
    selectedAnswers: ["C", "A"],
    isCorrect: false,
  }), true);
  assert.equal(isSessionAnswerCorrect(question, {
    selectedAnswers: ["A"],
    isCorrect: true,
  }), false);
});

test("recalculates single-select correctness from the question answer", () => {
  assert.equal(isSessionAnswerCorrect({ correctLetter: "B" }, { selectedAnswer: "B", isCorrect: false }), true);
  assert.equal(isSessionAnswerCorrect({ correctLetter: "B" }, { selectedAnswer: "A", isCorrect: true }), false);
});

test("omitted answers remain attributed to their original deck", () => {
  const answers = new Map([[encodeQuestionRef("ks", "1"), { selectedAnswer: "A" }]]);
  const result = calculateSessionResult(decks, set, answers);
  assert.equal(result.omitted, 1);
  assert.equal(result.byBank.find((bank) => bank.bankId === "spiegel").omitted, 1);
});

test("section results preserve per-test grades for the requested bank only", () => {
  const sectionDecks = [
    {
      id: "ks",
      title: "K&S",
      shortTitle: "K&S",
      questions: [
        { id: "1", correctLetter: "A", chapterTitle: "Test 1" },
        { id: "2", correctLetter: "B", chapterTitle: "Test 1" },
        { id: "3", correctLetter: "C", chapterTitle: "Test 2" },
      ],
      byId: new Map([
        ["1", { id: "1", correctLetter: "A", chapterTitle: "Test 1" }],
        ["2", { id: "2", correctLetter: "B", chapterTitle: "Test 1" }],
        ["3", { id: "3", correctLetter: "C", chapterTitle: "Test 2" }],
      ]),
    },
    {
      id: "spiegel",
      title: "Spiegel",
      shortTitle: "Spiegel",
      questions: [{ id: "1", correctLetter: "D", chapterTitle: "Test 9" }],
      byId: new Map([["1", { id: "1", correctLetter: "D", chapterTitle: "Test 9" }]]),
    },
  ];
  const sectionSet = createMultiDeckSetRecord({
    id: "set-2",
    references: [
      encodeQuestionRef("ks", "1"),
      encodeQuestionRef("ks", "2"),
      encodeQuestionRef("ks", "3"),
      encodeQuestionRef("spiegel", "1"),
    ],
    selectedBankIds: ["ks", "spiegel"],
    mode: "test",
    timed: false,
    remainingSeconds: 0,
    startedAt: "2026-07-23T00:00:00.000Z",
  });
  const answers = new Map([
    [encodeQuestionRef("ks", "1"), { selectedAnswer: "A" }],
    [encodeQuestionRef("ks", "2"), { selectedAnswer: "A" }],
    [encodeQuestionRef("ks", "3"), { selectedAnswer: "C" }],
    [encodeQuestionRef("spiegel", "1"), { selectedAnswer: "D" }],
  ]);
  assert.deepEqual(
    calculateSessionSectionResults(sectionDecks, sectionSet, answers, { bankId: "ks" }).map((row) => ({
      title: row.title,
      total: row.total,
      correct: row.correct,
      incorrect: row.incorrect,
      omitted: row.omitted,
      accuracy: row.accuracy,
    })),
    [
      { title: "Test 1", total: 2, correct: 1, incorrect: 1, omitted: 0, accuracy: 0.5 },
      { title: "Test 2", total: 1, correct: 1, incorrect: 0, omitted: 0, accuracy: 1 },
    ],
  );
});

test("progress entries carry original bank and question identifiers", () => {
  const answers = new Map([
    [encodeQuestionRef("ks", "1"), { isCorrect: true }],
    [encodeQuestionRef("spiegel", "1"), { isCorrect: false }],
  ]);
  assert.deepEqual(
    progressEntriesForSession(decks, set, answers).map(({ bankId, questionId, answerKey }) => ({ bankId, questionId, answerKey })),
    [
      { bankId: "ks", questionId: "1", answerKey: encodeQuestionRef("ks", "1") },
      { bankId: "spiegel", questionId: "1", answerKey: encodeQuestionRef("spiegel", "1") },
    ],
  );
});

test("total answer time safely ignores invalid and negative values", () => {
  assert.equal(totalAnswerTimeMs(new Map([
    ["a", { timeMs: 1000 }],
    ["b", { timeMs: -50 }],
    ["c", { timeMs: "2000" }],
  ])), 3000);
});
