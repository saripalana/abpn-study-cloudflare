import { stableStringify } from "./question-bank-import.js";

export const STUDY_COACH_BANK_ID = "study-coach-question-bank";
export const STUDY_COACH_BANK_TITLE = "Study Coach Question Bank";

function sourceQuestionFingerprint(question) {
  return stableStringify({
    id: question.id,
    subjectTitle: question.subjectTitle,
    question: question.question,
    vignetteStem: question.vignetteStem ?? "",
    image: question.image ?? "",
    choices: question.choices,
    choiceLetters: question.choiceLetters,
    correctLetter: question.correctLetter,
    correctLetters: question.correctLetters ?? [question.correctLetter],
    isMultiSelect: Boolean(question.isMultiSelect),
    answerText: question.answerText ?? "",
    explanation: question.explanation,
  });
}

function nextTestNumber(existingQuestions = []) {
  return existingQuestions.reduce((highest, question) => {
    const match = String(question?.chapterTitle || "").match(/^Study Coach Test (\d+)/i);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;
}

function organizedQuestion(question, { testNumber, groupKey, vignetteNumber }) {
  const testTitle = `Study Coach Test ${testNumber}`;
  if (!groupKey) {
    return {
      ...question,
      chapter: "test",
      chapterTitle: testTitle,
    };
  }
  return {
    ...question,
    chapter: "vignette",
    chapterTitle: `${testTitle} · Vignette ${vignetteNumber}`,
    linkedGroupId: `study-coach-test-${testNumber}:vignette-${vignetteNumber}`,
    linkedOrder: Number(question.linkedOrder || 0),
  };
}

export function buildStudyCoachDeckLibraryUpdate({
  existingBank = null,
  generatedDecks = [],
  generatedAt = null,
} = {}) {
  const existingQuestions = Array.isArray(existingBank?.questions) ? existingBank.questions : [];
  const existingById = new Map(existingQuestions.map((question) => [question.id, question]));
  const candidates = [];

  for (const deck of generatedDecks || []) {
    const questions = deck?.package?.bank?.questions || [];
    for (const question of questions) {
      const existing = existingById.get(question.id);
      if (existing) {
        if (sourceQuestionFingerprint(existing) !== sourceQuestionFingerprint(question)) {
          throw new Error(`Study Coach question ${question.id} changed after it was installed. Use a new question id.`);
        }
        continue;
      }
      if (candidates.some((entry) => entry.question.id === question.id)) {
        throw new Error(`Study Coach output contains duplicate question id ${question.id}.`);
      }
      candidates.push({
        question,
        groupKey: question.linkedGroupId ? `${deck.bankId}:${question.linkedGroupId}` : "",
      });
    }
  }

  if (!candidates.length) {
    return {
      changed: false,
      addedQuestions: 0,
      testNumber: Math.max(0, nextTestNumber(existingQuestions) - 1),
      package: null,
    };
  }

  const testNumber = nextTestNumber(existingQuestions);
  const vignetteNumbers = new Map();
  const newQuestions = candidates.map(({ question, groupKey }) => {
    if (groupKey && !vignetteNumbers.has(groupKey)) vignetteNumbers.set(groupKey, vignetteNumbers.size + 1);
    return organizedQuestion(question, {
      testNumber,
      groupKey,
      vignetteNumber: vignetteNumbers.get(groupKey),
    });
  });
  const questions = [...existingQuestions, ...newQuestions];
  const generatedDate = generatedAt && Number.isFinite(Date.parse(generatedAt))
    ? new Date(generatedAt).toISOString()
    : "date unavailable";

  return {
    changed: true,
    addedQuestions: newQuestions.length,
    testNumber,
    testTitle: `Study Coach Test ${testNumber}`,
    package: {
      format: "abpn-question-bank",
      schemaVersion: 1,
      bank: {
        id: STUDY_COACH_BANK_ID,
        title: STUDY_COACH_BANK_TITLE,
        shortTitle: "Study Coach",
        description: `Original adaptive ABPN-style questions generated from Study Coach learning cycles. ${questions.length} cumulative questions; latest cycle ${generatedDate}.`,
        version: `1.${testNumber}.0`,
        sourceType: "assistant-supplemental",
        contentClass: "assistant-supplemental",
        sourceLabel: "Study Coach",
        questions,
      },
    },
  };
}

export function isCanonicalStudyCoachBank(bank) {
  return bank?.id === STUDY_COACH_BANK_ID;
}
