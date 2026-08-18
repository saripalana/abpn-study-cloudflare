import test from "node:test";
import assert from "node:assert/strict";
import {
  STUDY_COACH_OUTPUT_FORMAT,
  STUDY_COACH_OUTPUT_SCHEMA_VERSION,
  STUDY_COACH_PACKAGE_FORMAT,
  createStudyCoachPackage,
  validateStudyCoachPackage,
  validateStudyCoachOutput,
} from "../src/client/study-coach-package.js";

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
});
