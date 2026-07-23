import test from "node:test";
import assert from "node:assert/strict";
import { buildBankCatalog } from "../public/client/study-engine.js";
import { createCombinedPracticeSet } from "../public/client/multi-deck-session.js";

const decks = buildBankCatalog([
  {
    id: "deck-a",
    title: "Deck A",
    shortTitle: "A",
    version: "1",
    questions: [
      { id: "shared", chapterTitle: "One", question: "A shared", choices: ["x", "y"], choiceLetters: ["A", "B"], correctLetter: "A", explanation: "" },
      { id: "a-2", chapterTitle: "One", question: "A2", choices: ["x", "y"], choiceLetters: ["A", "B"], correctLetter: "B", explanation: "" },
    ],
  },
  {
    id: "deck-b",
    title: "Deck B",
    shortTitle: "B",
    version: "1",
    questions: [
      { id: "shared", chapterTitle: "Two", question: "B shared", choices: ["x", "y"], choiceLetters: ["A", "B"], correctLetter: "B", explanation: "" },
      { id: "b-2", chapterTitle: "Two", question: "B2", choices: ["x", "y"], choiceLetters: ["A", "B"], correctLetter: "A", explanation: "" },
    ],
  },
  {
    id: "validation-bank",
    title: "Validation",
    version: "1",
    sourceType: "system-validation",
    contentClass: "system-validation",
    questions: [
      { id: "v-1", chapterTitle: "Test", question: "Validation", choices: ["x", "y"], choiceLetters: ["A", "B"], correctLetter: "A", explanation: "" },
    ],
  },
]);

test("creates a collision-safe combined set from all study decks", () => {
  const set = createCombinedPracticeSet({
    decks,
    activeBankId: "deck-a",
    settings: { scope: "all" },
    count: 4,
    mode: "test",
    timed: true,
    id: "set-1",
    now: "2026-07-23T00:00:00.000Z",
    random: () => 0,
  });

  assert.equal(set.bankId, "__multi-deck__");
  assert.deepEqual(set.selectedBankIds, ["deck-a", "deck-b"]);
  assert.equal(set.questionIds.length, 4);
  assert.equal(new Set(set.questionIds).size, 4);
  assert.ok(set.questionIds.some((ref) => ref.includes("deck-a::shared")));
  assert.ok(set.questionIds.some((ref) => ref.includes("deck-b::shared")));
  assert.equal(set.remainingSeconds, Math.ceil(4 * 70.6));
});

test("does not create a combined record for current-deck scope", () => {
  const set = createCombinedPracticeSet({
    decks,
    activeBankId: "deck-a",
    settings: { scope: "current" },
    count: 2,
    mode: "tutor",
    timed: false,
  });
  assert.equal(set, null);
});

test("returns null when no questions match the requested pool", () => {
  const set = createCombinedPracticeSet({
    decks,
    activeBankId: "deck-a",
    settings: { scope: "all" },
    progressByBank: new Map(),
    pool: "flagged",
    count: 10,
    mode: "test",
    timed: false,
  });
  assert.equal(set, null);
});

test("respects explicit deck selection and requested count", () => {
  const set = createCombinedPracticeSet({
    decks,
    activeBankId: "deck-a",
    settings: { scope: "custom", selectedBankIds: ["deck-a", "deck-b"] },
    count: 2,
    mode: "test",
    timed: false,
    id: "set-2",
    random: () => 0.5,
  });
  assert.equal(set.questionIds.length, 2);
  assert.deepEqual(set.selectedBankIds, ["deck-a", "deck-b"]);
});
