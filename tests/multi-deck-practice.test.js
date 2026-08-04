import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseMultiDeckQuestionRefs,
  decodeQuestionRef,
  encodeQuestionRef,
  isStudyDeck,
  multiDeckQuestionRefs,
  resolveQuestionRef,
  selectedStudyDecks,
  studyDecks,
} from "../public/client/multi-deck-practice.js";

function deck(id, title, questionIds, extra = {}) {
  const questions = questionIds.map((questionId, index) => ({
    id: questionId,
    chapterTitle: index % 2 ? "Mood" : "Psychosis",
    question: `${title} ${questionId}`,
    choices: ["A", "B"],
    choiceLetters: ["A", "B"],
    correctLetter: "A",
    explanation: "Test explanation",
  }));
  return {
    id,
    title,
    shortTitle: title,
    contentClass: "source-material",
    sourceType: "user-imported",
    questions,
    byId: new Map(questions.map((question) => [question.id, question])),
    ...extra,
  };
}

const ks = deck("ks", "K&S", ["k1", "k2"]);
const spiegel = deck("spiegel", "Spiegel", ["s1", "s2", "s3"]);
const validation = deck("validation-bank", "Validation", ["v1"], {
  contentClass: "system-validation",
  sourceType: "system-validation",
});

test("excludes system validation content from normal multi-deck study", () => {
  assert.equal(isStudyDeck(validation), false);
  assert.deepEqual(studyDecks([ks, validation, spiegel]).map((item) => item.id), ["ks", "spiegel"]);
});

test("supports all study decks or an explicit subset", () => {
  assert.deepEqual(selectedStudyDecks([ks, validation, spiegel]).map((item) => item.id), ["ks", "spiegel"]);
  assert.deepEqual(selectedStudyDecks([ks, validation, spiegel], ["spiegel"]).map((item) => item.id), ["spiegel"]);
});

test("question references preserve both source deck and source question IDs", () => {
  const encoded = encodeQuestionRef("spiegel/test", "question:1");
  assert.deepEqual(decodeQuestionRef(encoded), { bankId: "spiegel/test", questionId: "question:1" });
  const resolved = resolveQuestionRef([ks, spiegel], encodeQuestionRef("spiegel", "s2"));
  assert.equal(resolved.deck.id, "spiegel");
  assert.equal(resolved.question.id, "s2");
});

test("builds one eligible pool across selected decks without validation questions", () => {
  const refs = multiDeckQuestionRefs({
    decks: [ks, validation, spiegel],
    progressByBank: new Map(),
    pool: "all",
  });
  assert.equal(refs.length, 5);
  assert.equal(refs.some((reference) => decodeQuestionRef(reference).bankId === "validation-bank"), false);
});

test("applies question-status filtering inside each source deck", () => {
  const progressByBank = new Map([
    ["ks", new Map([["k1", { timesUsed: 1, isCorrect: false }]])],
    ["spiegel", new Map([["s2", { timesUsed: 1, isCorrect: false }]])],
  ]);
  const refs = multiDeckQuestionRefs({
    decks: [ks, spiegel],
    progressByBank,
    pool: "incorrect",
  });
  assert.deepEqual(refs.map(decodeQuestionRef), [
    { bankId: "ks", questionId: "k1" },
    { bankId: "spiegel", questionId: "s2" },
  ]);
});

test("randomized selection draws from the combined pool without losing attribution", () => {
  const refs = chooseMultiDeckQuestionRefs({ decks: [ks, spiegel], pool: "all" }, 4, () => 0);
  assert.equal(refs.length, 4);
  assert.equal(new Set(refs).size, 4);
  assert.equal(refs.every((reference) => ["ks", "spiegel"].includes(decodeQuestionRef(reference).bankId)), true);
});

test("multi-deck randomization keeps linked questions together and ordered", () => {
  spiegel.questions[0].linkedGroupId = "vignette-a";
  spiegel.questions[0].linkedOrder = 0;
  spiegel.questions[0].chapterTitle = "Linked case";
  spiegel.questions[1].linkedGroupId = "vignette-a";
  spiegel.questions[1].linkedOrder = 1;
  spiegel.questions[1].chapterTitle = "Linked case";
  const refs = chooseMultiDeckQuestionRefs({
    decks: [spiegel],
    categoriesByBank: new Map([["spiegel", ["Linked case"]]]),
  }, 1, () => 0);
  assert.deepEqual(refs.map(decodeQuestionRef), [
    { bankId: "spiegel", questionId: "s1" },
    { bankId: "spiegel", questionId: "s2" },
  ]);
});

test("multi-deck sequential selection preserves deck and source order", () => {
  const refs = chooseMultiDeckQuestionRefs({ decks: [ks, spiegel], pool: "all" }, 4, () => 0, false);
  assert.deepEqual(refs.map(decodeQuestionRef), [
    { bankId: "ks", questionId: "k1" },
    { bankId: "ks", questionId: "k2" },
    { bankId: "spiegel", questionId: "s1" },
    { bankId: "spiegel", questionId: "s2" },
  ]);
});
