import test from "node:test";
import assert from "node:assert/strict";
import {
  STUDY_COACH_OUTPUT_FORMAT,
  STUDY_COACH_OUTPUT_SCHEMA_VERSION,
  STUDY_COACH_PACKAGE_FORMAT,
  createStudyCoachPackage,
  prepareStudyCoachOutput,
  validateStudyCoachPackage,
  validateStudyCoachOutput,
} from "../src/client/study-coach-package.js";
import { QUESTION_BANK_PACKAGE_FORMAT, QUESTION_BANK_PACKAGE_SCHEMA_VERSION } from "../src/client/question-bank-import.js";

const bank = {
  id: "ks",
  title: "K&S",
  version: "1",
  questions: [{
    id: "q1",
    subjectTitle: "Mood",
    chapterTitle: "Test 1",
    question: "Prompt one",
    vignetteStem: "Stem",
    choices: ["A one", "B two"],
    choiceLetters: ["A", "B"],
    correctLetters: ["B"],
    answerText: "B",
    explanation: "Why B",
    linkedGroupId: null,
    linkedOrder: null,
    isMultiSelect: false,
  }, {
    id: "q2",
    subjectTitle: "Mood",
    chapterTitle: "Test 1",
    question: "Prompt two",
    vignetteStem: "",
    choices: ["A", "B"],
    choiceLetters: ["A", "B"],
    correctLetters: ["A"],
    answerText: "A",
    explanation: "Why A",
    linkedGroupId: null,
    linkedOrder: null,
    isMultiSelect: false,
  }],
};

test("full Study Coach package includes complete question content plus restored study state", () => {
  const pkg = createStudyCoachPackage({
    banks: [bank],
    progressRows: [{
      bankId: "ks",
      questionId: "q1",
      selectedAnswer: "A",
      isCorrect: false,
      isFlagged: true,
      timesUsed: 2,
      totalTimeMs: 4_000,
      lastUsedAt: "2026-08-18T12:00:00.000Z",
    }],
    practiceSets: [{
      id: "set-1",
      bankId: "ks",
      status: "completed",
      mode: "test",
      timed: true,
      questionIds: ["q1", "q2"],
      startedAt: "2026-08-18T11:00:00.000Z",
      completedAt: "2026-08-18T12:00:00.000Z",
      updatedAt: "2026-08-18T12:00:00.000Z",
    }],
    practiceSetAnswers: [{
      setId: "set-1",
      questionId: "q1",
      selectedAnswer: "A",
      isCorrect: false,
      timeMs: 2_000,
      updatedAt: "2026-08-18T12:00:00.000Z",
    }],
    exportedAt: "2026-08-18T12:30:00.000Z",
  });

  assert.equal(pkg.format, STUDY_COACH_PACKAGE_FORMAT);
  assert.equal(pkg.banks[0].questions[0].prompt, "Prompt one");
  assert.equal(pkg.banks[0].questions[0].progress.timesUsed, 2);
  assert.deepEqual(pkg.banks[0].questionIndexes.incorrect, ["q1"]);
  assert.deepEqual(pkg.studyState.practiceSets[0].questionIds, ["q1", "q2"]);
  assert.equal(pkg.outputContract.format, STUDY_COACH_OUTPUT_FORMAT);
  assert.deepEqual(validateStudyCoachPackage(pkg), {
    exportedAt: "2026-08-18T12:30:00.000Z",
    appVersion: "1.0.0",
    bankCount: 1,
    questionCount: 2,
  });
});

test("Study Coach output validation accepts constrained coaching outputs", () => {
  const output = validateStudyCoachOutput({
    format: STUDY_COACH_OUTPUT_FORMAT,
    schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
    generatedAt: "2026-08-18T13:00:00.000Z",
    sourcePackageGeneratedAt: "2026-08-18T12:30:00.000Z",
    summary: "Focus on Mood errors first.",
    focusAreas: [{
      title: "Mood",
      rationale: "Recent misses cluster here.",
      recommendedQuestionCount: 20,
      questionRefs: [{ bankId: "ks", questionId: "q1" }],
    }],
    recommendedSets: [{
      title: "Mood wrong-question rebuild",
      objective: "Revisit missed concepts with fresh pacing.",
      mode: "test",
      timed: true,
      questionCount: 20,
      questionRefs: [{ bankId: "ks", questionId: "q1" }],
      instructions: "Build in ABPN style and review rationale after submission.",
    }],
    progressMetrics: [{ label: "Primary target", value: "Mood", detail: "2 recent misses" }],
    studyActions: ["Redo 20 timed Mood questions.", "Review rationale after grading."],
    notes: ["Keep sets under 25 questions while rebuilding speed."],
  });

  assert.equal(output.recommendedSets[0].questionCount, 20);
  assert.equal(output.focusAreas[0].questionRefs[0].questionId, "q1");
  assert.deepEqual(output.generatedDecks, []);
});

test("Study Coach output preparation accepts coach-generated supplemental decks", async () => {
  const output = await prepareStudyCoachOutput({
    format: STUDY_COACH_OUTPUT_FORMAT,
    schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
    generatedAt: "2026-08-21T14:38:26.000Z",
    sourcePackageGeneratedAt: "2026-08-21T14:35:15.279Z",
    summary: "Build a Psychopharmacology recovery deck next.",
    focusAreas: [],
    recommendedSets: [],
    progressMetrics: [],
    studyActions: ["Install the generated deck and run it next."],
    notes: [],
    generatedDecks: [{
      title: "Psychopharmacology recovery deck",
      objective: "Fresh coach-authored remediation set.",
      package: {
        format: QUESTION_BANK_PACKAGE_FORMAT,
        schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
        bank: {
          id: "coach-psychopharm-20260821",
          title: "Coach Psychopharmacology Recovery Deck",
          shortTitle: "Coach Psychopharm",
          description: "Fresh targeted remediation deck.",
          version: "1",
          sourceType: "assistant-supplemental",
          contentClass: "assistant-supplemental",
          sourceLabel: "Study Coach",
          questions: [{
            id: "coach-q1",
            subjectTitle: "Psychopharmacology",
            chapterTitle: "Psychopharmacology",
            question: "Which medication requires lithium level monitoring?",
            choices: ["Lithium", "Fluoxetine"],
            correctLetters: ["A"],
            answerText: "Lithium",
            explanation: "Lithium requires serum monitoring.",
          }],
        },
      },
    }],
  }, { protectedBanks: [bank], reservedIds: [bank.id] });

  assert.equal(output.generatedDecks.length, 1);
  assert.equal(output.generatedDecks[0].bankId, "coach-psychopharm-20260821");
  assert.equal(output.generatedDecks[0].questionCount, 1);
  assert.equal(output.generatedDecks[0].package.bank.contentClass, "assistant-supplemental");
});

test("Study Coach output rejects protected question copies even when ids and labels are changed", async () => {
  await assert.rejects(() => prepareStudyCoachOutput({
    format: STUDY_COACH_OUTPUT_FORMAT,
    schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
    generatedAt: "2026-08-21T14:40:00.000Z",
    summary: "A mislabeled copy must fail closed.",
    focusAreas: [],
    recommendedSets: [],
    progressMetrics: [],
    studyActions: [],
    notes: [],
    generatedDecks: [{
      title: "Synthetic collision deck",
      package: {
        format: QUESTION_BANK_PACKAGE_FORMAT,
        schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
        bank: {
          id: "different-bank-id",
          title: "Synthetic collision deck",
          shortTitle: "Collision",
          description: "Synthetic regression fixture.",
          version: "1",
          sourceType: "assistant-supplemental",
          contentClass: "assistant-supplemental",
          sourceLabel: "Synthetic Study Coach fixture",
          questions: [{
            ...bank.questions[0],
            id: "different-question-id",
            question: "  PROMPT   ONE  ",
          }],
        },
      },
    }],
  }, { protectedBanks: [bank], reservedIds: [bank.id] }), /cannot copy protected source question content/);
});

test("Study Coach output preparation never clones protected source questions from recommendations", async () => {
  const output = await prepareStudyCoachOutput({
    format: STUDY_COACH_OUTPUT_FORMAT,
    schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
    generatedAt: "2026-08-21T15:00:00.000Z",
    sourcePackageGeneratedAt: "2026-08-21T14:35:15.279Z",
    summary: "Run the recovery block next.",
    focusAreas: [],
    recommendedSets: [{
      title: "Mood recovery block",
      objective: "Revisit high-yield mood misses.",
      mode: "test",
      timed: true,
      questionCount: 2,
      questionRefs: [
        { bankId: "ks", questionId: "q1" },
        { bankId: "ks", questionId: "q2" },
      ],
      instructions: "Treat this as a timed rebuild set.",
    }],
    progressMetrics: [],
    studyActions: [],
    notes: [],
  });

  assert.deepEqual(output.generatedDecks, []);
  assert.equal(JSON.stringify(output).includes("Prompt one"), false);
  assert.equal(JSON.stringify(output).includes("Prompt two"), false);
});

test("Study Coach output rejects generated decks unless they are explicitly assistant-supplemental", async () => {
  await assert.rejects(() => prepareStudyCoachOutput({
    format: STUDY_COACH_OUTPUT_FORMAT,
    schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
    generatedAt: "2026-08-21T15:05:00.000Z",
    summary: "Unsafe generated deck.",
    focusAreas: [],
    recommendedSets: [],
    progressMetrics: [],
    studyActions: [],
    notes: [],
    generatedDecks: [{
      title: "Unsafe copy",
      package: {
        format: QUESTION_BANK_PACKAGE_FORMAT,
        schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
        bank: { ...bank, sourceType: "source-material", contentClass: "source-material" },
      },
    }],
  }), /assistant-supplemental/);
});

test("Study Coach output preparation rejects package files with a targeted error", async () => {
  await assert.rejects(
    () => prepareStudyCoachOutput({
      format: STUDY_COACH_PACKAGE_FORMAT,
      schemaVersion: 1,
      generatedAt: "2026-08-21T15:00:00.000Z",
      summary: "Wrong file type.",
    }),
    /You selected a Study Coach package\./,
  );
});
