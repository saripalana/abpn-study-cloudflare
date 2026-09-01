import assert from "node:assert/strict";
import test from "node:test";

import { prepareQuestionBankPackage } from "../public/client/question-bank-import.js";
import {
  buildStudyCoachDeckLibraryUpdate,
  STUDY_COACH_BANK_ID,
} from "../public/client/study-coach-deck-library.js";

function question(id, { linkedGroupId = "", linkedOrder = 0, prompt = `Question ${id}?` } = {}) {
  return {
    id,
    chapterTitle: "Original generated section",
    subjectTitle: "Psychiatry",
    question: prompt,
    choices: ["One", "Two"],
    choiceLetters: ["A", "B"],
    correctLetter: "A",
    correctLetters: ["A"],
    isMultiSelect: false,
    explanation: "One is best.",
    ...(linkedGroupId ? { linkedGroupId, linkedOrder } : {}),
  };
}

function generatedDeck(bankId, questions) {
  return {
    bankId,
    package: {
      format: "abpn-question-bank",
      schemaVersion: 1,
      bank: { questions },
    },
  };
}

test("Study Coach outputs append as numbered tests and linked vignettes in one Deck Library bank", async () => {
  const first = buildStudyCoachDeckLibraryUpdate({
    generatedAt: "2026-09-01T14:00:00.000Z",
    generatedDecks: [generatedDeck("cycle-1", [
      question("coach-q1"),
      question("coach-q2", { linkedGroupId: "case-a", linkedOrder: 0 }),
      question("coach-q3", { linkedGroupId: "case-a", linkedOrder: 1 }),
    ])],
  });
  assert.equal(first.changed, true);
  assert.equal(first.testTitle, "Study Coach Test 1");
  assert.equal(first.package.bank.id, STUDY_COACH_BANK_ID);
  assert.equal(first.package.bank.questions[0].chapterTitle, "Study Coach Test 1");
  assert.equal(first.package.bank.questions[1].chapterTitle, "Study Coach Test 1 · Vignette 1");
  assert.equal(first.package.bank.questions[2].linkedGroupId, "study-coach-test-1:vignette-1");

  const installedFirst = (await prepareQuestionBankPackage(first.package)).bank;
  const second = buildStudyCoachDeckLibraryUpdate({
    existingBank: installedFirst,
    generatedAt: "2026-09-02T14:00:00.000Z",
    generatedDecks: [generatedDeck("cycle-2", [question("coach-q4")])],
  });
  assert.equal(second.testTitle, "Study Coach Test 2");
  assert.equal(second.addedQuestions, 1);
  assert.equal(second.package.bank.questions.length, 4);
  assert.equal(second.package.bank.questions[3].chapterTitle, "Study Coach Test 2");
});

test("re-pulling the same output is idempotent and changed question ids are rejected", async () => {
  const deck = generatedDeck("cycle-1", [question("coach-q1")]);
  const first = buildStudyCoachDeckLibraryUpdate({ generatedDecks: [deck] });
  const installed = (await prepareQuestionBankPackage(first.package)).bank;
  const repeated = buildStudyCoachDeckLibraryUpdate({ existingBank: installed, generatedDecks: [deck] });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.addedQuestions, 0);

  assert.throws(() => buildStudyCoachDeckLibraryUpdate({
    existingBank: installed,
    generatedDecks: [generatedDeck("cycle-1", [question("coach-q1", { prompt: "Changed question?" })])],
  }), /changed after it was installed/i);
});
