import test from "node:test";
import assert from "node:assert/strict";

import {
  MULTI_DECK_SET_SCOPE,
  createMultiDeckSetRecord,
  isMultiDeckSet,
  normalizeStoredSet,
  progressTargetsForSet,
  resolveSetQuestion,
  storedQuestionKey,
} from "../public/client/multi-deck-set.js";
import { encodeQuestionRef } from "../public/client/multi-deck-practice.js";

function deck(id, questionIds, extra = {}) {
  const questions = questionIds.map((questionId) => ({ id: questionId, chapterTitle: "Topic" }));
  return {
    id,
    title: id,
    shortTitle: id,
    questions,
    byId: new Map(questions.map((question) => [question.id, question])),
    ...extra,
  };
}

const decks = [deck("ks", ["1", "shared"]), deck("spiegel", ["2", "shared"])];

test("creates a combined set using a reserved scope and deck-bound references", () => {
  const refs = [encodeQuestionRef("ks", "shared"), encodeQuestionRef("spiegel", "shared")];
  const record = createMultiDeckSetRecord({
    id: "set-1",
    references: refs,
    selectedBankIds: ["ks", "spiegel"],
    mode: "test",
    timed: true,
    remainingSeconds: 142,
    startedAt: "2026-07-23T00:00:00.000Z",
  });

  assert.equal(record.bankId, MULTI_DECK_SET_SCOPE);
  assert.equal(isMultiDeckSet(record), true);
  assert.deepEqual(record.questionIds, refs);
  assert.deepEqual(record.selectedBankIds, ["ks", "spiegel"]);
});

test("normalizes legacy single-deck sets without rewriting stored data", () => {
  const stored = { id: "legacy", bankId: "ks", questionIds: ["1", "shared"], index: 0 };
  const normalized = normalizeStoredSet(stored, decks);

  assert.equal(normalized.scope, "single-deck");
  assert.deepEqual(normalized.selectedBankIds, ["ks"]);
  assert.deepEqual(normalized.questionRefs, [encodeQuestionRef("ks", "1"), encodeQuestionRef("ks", "shared")]);
  assert.deepEqual(stored.questionIds, ["1", "shared"]);
});

test("rejects saved sets when any source question is unavailable", () => {
  const stored = createMultiDeckSetRecord({
    id: "missing",
    references: [encodeQuestionRef("ks", "missing")],
    selectedBankIds: ["ks"],
    mode: "test",
    timed: false,
    remainingSeconds: 0,
    startedAt: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(normalizeStoredSet(stored, decks), null);
});

test("resolves each combined question to its original deck", () => {
  const stored = createMultiDeckSetRecord({
    id: "resolve",
    references: [encodeQuestionRef("ks", "shared"), encodeQuestionRef("spiegel", "shared")],
    selectedBankIds: ["ks", "spiegel"],
    mode: "tutor",
    timed: false,
    remainingSeconds: 0,
    startedAt: "2026-07-23T00:00:00.000Z",
  });
  const normalized = normalizeStoredSet(stored, decks);

  assert.equal(resolveSetQuestion(decks, normalized, 0).bankId, "ks");
  assert.equal(resolveSetQuestion(decks, normalized, 1).bankId, "spiegel");
  assert.deepEqual(progressTargetsForSet(decks, normalized).map((target) => target.bankId), ["ks", "spiegel"]);
});

test("uses encoded references as answer keys only for combined sets", () => {
  const reference = encodeQuestionRef("spiegel", "shared");
  assert.equal(storedQuestionKey({ bankId: MULTI_DECK_SET_SCOPE }, reference), reference);
  assert.equal(storedQuestionKey({ bankId: "spiegel" }, reference), "shared");
  assert.equal(storedQuestionKey({ bankId: "spiegel" }, "shared"), "shared");
});
