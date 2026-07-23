import test from "node:test";
import assert from "node:assert/strict";

import { buildBankCatalog } from "../public/client/study-engine.js";
import {
  answeredSetQuestionCount,
  answerForSetQuestion,
  currentSetQuestion,
  progressTargetForResolvedQuestion,
  setQuestionItems,
} from "../public/client/multi-deck-runtime.js";
import { createMultiDeckSetRecord } from "../public/client/multi-deck-set.js";
import { encodeQuestionRef } from "../public/client/multi-deck-practice.js";

const decks = buildBankCatalog([
  {
    id: "deck-a",
    title: "Deck A",
    shortTitle: "A",
    version: "1",
    questions: [{ id: "shared", chapterTitle: "A", question: "A?", choices: ["1", "2"], choiceLetters: ["A", "B"], correctLetter: "A", explanation: "A" }],
  },
  {
    id: "deck-b",
    title: "Deck B",
    shortTitle: "B",
    version: "1",
    questions: [{ id: "shared", chapterTitle: "B", question: "B?", choices: ["1", "2"], choiceLetters: ["A", "B"], correctLetter: "B", explanation: "B" }],
  },
]);

const references = [
  encodeQuestionRef("deck-a", "shared"),
  encodeQuestionRef("deck-b", "shared"),
];

const set = createMultiDeckSetRecord({
  id: "set-1",
  references,
  selectedBankIds: ["deck-a", "deck-b"],
  mode: "test",
  timed: false,
  remainingSeconds: 0,
  startedAt: "2026-07-23T00:00:00.000Z",
});
set.questionRefs = references;


test("currentSetQuestion resolves source deck and collision-safe answer key", () => {
  const first = currentSetQuestion(decks, set);
  assert.equal(first.bankId, "deck-a");
  assert.equal(first.questionId, "shared");
  assert.equal(first.answerKey, references[0]);
  assert.equal(first.displayDeckTitle, "A");

  set.index = 1;
  const second = currentSetQuestion(decks, set);
  assert.equal(second.bankId, "deck-b");
  assert.equal(second.answerKey, references[1]);
  set.index = 0;
});


test("answers remain separate when two decks reuse the same question ID", () => {
  const answers = new Map([
    [references[0], { selectedAnswer: "A" }],
    [references[1], { selectedAnswer: "B" }],
  ]);
  const first = currentSetQuestion(decks, set);
  set.index = 1;
  const second = currentSetQuestion(decks, set);
  assert.equal(answerForSetQuestion(answers, set, first).selectedAnswer, "A");
  assert.equal(answerForSetQuestion(answers, set, second).selectedAnswer, "B");
  set.index = 0;
});


test("setQuestionItems preserves source attribution and ordering", () => {
  const items = setQuestionItems(decks, set);
  assert.deepEqual(items.map((item) => item.bankId), ["deck-a", "deck-b"]);
  assert.deepEqual(items.map((item) => item.answerKey), references);
});


test("answered count uses source-bound answer keys", () => {
  const answers = new Map([[references[1], { selectedAnswer: "B" }]]);
  assert.equal(answeredSetQuestionCount(decks, set, answers), 1);
});


test("progress target points to the original deck and question", () => {
  set.index = 1;
  const resolved = currentSetQuestion(decks, set);
  assert.deepEqual(progressTargetForResolvedQuestion(resolved), {
    bankId: "deck-b",
    questionId: "shared",
  });
  set.index = 0;
});
