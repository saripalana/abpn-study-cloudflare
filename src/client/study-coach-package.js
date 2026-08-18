import { getAllRecords, getRecord, putRecord, STORES } from "./storage.js";
import { buildWeaknessSnapshot } from "./weakness-analytics.js";

export const STUDY_COACH_PACKAGE_FORMAT = "abpn-study-coach-package";
export const STUDY_COACH_PACKAGE_SCHEMA_VERSION = 1;
export const STUDY_COACH_OUTPUT_FORMAT = "abpn-study-coach-output";
export const STUDY_COACH_OUTPUT_SCHEMA_VERSION = 1;
export const STUDY_COACH_OUTPUT_META_KEY = "study-coach-output-v1";
const MAX_OUTPUT_TEXT = 20_000;
const MAX_OUTPUT_LIST = 50;
const MAX_OUTPUT_QUESTION_REFS = 200;
const MAX_PACKAGE_BANKS = 50;
const MAX_PACKAGE_QUESTIONS = 10_000;

function text(value, field, maximum = MAX_OUTPUT_TEXT, required = true) {
  const result = String(value || "").trim();
  if ((required && !result) || result.length > maximum) throw new Error(`${field} is invalid`);
  return result;
}

function optionalText(value, field, maximum = MAX_OUTPUT_TEXT) {
  return value == null || value === "" ? "" : text(value, field, maximum, false);
}

function isoTimestamp(value, field) {
  const result = text(value, field, 40);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${field} is invalid`);
  return result;
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const result = Math.trunc(Number(value));
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${field} is invalid`);
  return result;
}

function ratio(value, field) {
  if (value == null) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error(`${field} is invalid`);
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function questionRefs(rows, field) {
  if (!Array.isArray(rows) || rows.length > MAX_OUTPUT_QUESTION_REFS) throw new Error(`${field} is invalid`);
  return rows.map((row, index) => ({
    bankId: text(row.bankId, `${field}[${index}].bankId`, 100),
    questionId: text(row.questionId, `${field}[${index}].questionId`, 200),
  }));
}

function arrays(value, field) {
  if (!Array.isArray(value) || value.length > MAX_OUTPUT_LIST) throw new Error(`${field} is invalid`);
  return value;
}

function choiceSummary(question) {
  return question.choices.map((choice, index) => ({
    letter: String(question.choiceLetters?.[index] || ""),
    text: String(choice || ""),
  }));
}

function buildQuestionIndexes(bank, progress) {
  const attempted = [];
  const incorrect = [];
  const flagged = [];
  const annotated = [];
  const unused = [];

  for (const question of bank.questions) {
    const record = progress.get(question.id);
    if (Number(record?.timesUsed || 0) > 0) attempted.push(question.id);
    else unused.push(question.id);
    if (record?.isCorrect === false) incorrect.push(question.id);
    if (record?.isFlagged) flagged.push(question.id);
    if (String(record?.note || record?.notes || "").trim()) annotated.push(question.id);
  }

  return { attempted, incorrect, flagged, annotated, unused };
}

export function createStudyCoachPackage({
  banks,
  progressRows,
  practiceSets,
  practiceSetAnswers,
  appVersion = "1.0.0",
  exportedAt = new Date().toISOString(),
} = {}) {
  const progressByBank = new Map();
  for (const row of progressRows || []) {
    const byQuestion = progressByBank.get(row.bankId) || new Map();
    byQuestion.set(row.questionId, clone(row));
    progressByBank.set(row.bankId, byQuestion);
  }

  return {
    format: STUDY_COACH_PACKAGE_FORMAT,
    schemaVersion: STUDY_COACH_PACKAGE_SCHEMA_VERSION,
    exportedAt,
    appVersion,
    purpose: "full-study-coach-analysis-and-output",
    banks: (banks || []).map((bank) => {
      const progress = progressByBank.get(bank.id) || new Map();
      return {
        id: String(bank.id || "unknown"),
        title: String(bank.title || "Study deck"),
        version: String(bank.version || "1"),
        totalQuestions: bank.questions.length,
        weaknessSnapshot: buildWeaknessSnapshot(bank, progress, { now: exportedAt }),
        questionIndexes: buildQuestionIndexes(bank, progress),
        questions: bank.questions.map((question, index) => ({
          id: String(question.id || ""),
          number: index + 1,
          subjectTitle: String(question.subjectTitle || question.chapterTitle || "Uncategorized"),
          testSection: String(question.chapterTitle || question.subjectTitle || "Uncategorized"),
          prompt: String(question.question || ""),
          vignetteStem: String(question.vignetteStem || ""),
          choices: choiceSummary(question),
          correctAnswer: [...(question.correctLetters || (question.correctLetter ? [question.correctLetter] : []))],
          answerText: String(question.answerText || ""),
          explanation: String(question.explanation || ""),
          linkedGroupId: question.linkedGroupId || null,
          linkedOrder: question.linkedOrder ?? null,
          isMultiSelect: Boolean(question.isMultiSelect),
          progress: clone(progress.get(question.id) || null),
        })),
      };
    }),
    studyState: {
      progress: clone(progressRows || []),
      practiceSets: clone(practiceSets || []),
      practiceSetAnswers: clone(practiceSetAnswers || []),
    },
    outputContract: {
      format: STUDY_COACH_OUTPUT_FORMAT,
      schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
      supportedSections: ["summary", "focusAreas", "recommendedSets", "progressMetrics", "studyActions", "notes"],
      questionRefShape: { bankId: "string", questionId: "string" },
    },
  };
}

export function validateStudyCoachPackage(input) {
  if (!input || input.format !== STUDY_COACH_PACKAGE_FORMAT || input.schemaVersion !== STUDY_COACH_PACKAGE_SCHEMA_VERSION) {
    throw new Error("This is not a valid Study Coach package file.");
  }
  const exportedAt = isoTimestamp(input.exportedAt, "exportedAt");
  const appVersion = text(input.appVersion, "appVersion", 100);
  if (!Array.isArray(input.banks) || input.banks.length < 1 || input.banks.length > MAX_PACKAGE_BANKS) {
    throw new Error("banks is invalid");
  }
  let totalQuestions = 0;
  for (const bank of input.banks) {
    if (!bank || !Array.isArray(bank.questions)) throw new Error("bank.questions is invalid");
    totalQuestions += bank.questions.length;
    if (totalQuestions > MAX_PACKAGE_QUESTIONS) throw new Error("Study Coach package is too large");
  }
  const studyState = input.studyState || {};
  if (!Array.isArray(studyState.progress) || !Array.isArray(studyState.practiceSets) || !Array.isArray(studyState.practiceSetAnswers)) {
    throw new Error("studyState is invalid");
  }
  return {
    exportedAt,
    appVersion,
    bankCount: input.banks.length,
    questionCount: totalQuestions,
  };
}

export function studyCoachPackageFilename(exportedAt = new Date().toISOString()) {
  return `abpn-study-coach-package-${exportedAt.replace(/[:.]/g, "-")}.json`;
}

export function downloadStudyCoachPackage(pkg) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), {
    href: url,
    download: studyCoachPackageFilename(pkg.exportedAt),
    rel: "noopener",
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function validateStudyCoachOutput(input) {
  if (!input || input.format !== STUDY_COACH_OUTPUT_FORMAT || input.schemaVersion !== STUDY_COACH_OUTPUT_SCHEMA_VERSION) {
    throw new Error("This is not a valid Study Coach output file.");
  }
  const output = {
    format: STUDY_COACH_OUTPUT_FORMAT,
    schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
    generatedAt: isoTimestamp(input.generatedAt, "generatedAt"),
    sourcePackageGeneratedAt: input.sourcePackageGeneratedAt ? isoTimestamp(input.sourcePackageGeneratedAt, "sourcePackageGeneratedAt") : null,
    summary: text(input.summary, "summary"),
    focusAreas: arrays(input.focusAreas, "focusAreas").map((area, index) => ({
      title: text(area.title, `focusAreas[${index}].title`, 200),
      rationale: text(area.rationale, `focusAreas[${index}].rationale`),
      recommendedQuestionCount: area.recommendedQuestionCount == null
        ? null
        : integer(area.recommendedQuestionCount, `focusAreas[${index}].recommendedQuestionCount`, { minimum: 1, maximum: 500 }),
      questionRefs: area.questionRefs ? questionRefs(area.questionRefs, `focusAreas[${index}].questionRefs`) : [],
    })),
    recommendedSets: arrays(input.recommendedSets, "recommendedSets").map((set, index) => ({
      title: text(set.title, `recommendedSets[${index}].title`, 200),
      objective: text(set.objective, `recommendedSets[${index}].objective`),
      mode: set.mode === "tutor" ? "tutor" : "test",
      timed: Boolean(set.timed),
      questionCount: integer(set.questionCount, `recommendedSets[${index}].questionCount`, { minimum: 1, maximum: 500 }),
      questionRefs: questionRefs(set.questionRefs, `recommendedSets[${index}].questionRefs`),
      instructions: optionalText(set.instructions, `recommendedSets[${index}].instructions`),
    })),
    progressMetrics: arrays(input.progressMetrics, "progressMetrics").map((metric, index) => ({
      label: text(metric.label, `progressMetrics[${index}].label`, 200),
      value: text(metric.value, `progressMetrics[${index}].value`, 200),
      detail: optionalText(metric.detail, `progressMetrics[${index}].detail`, 500),
    })),
    studyActions: arrays(input.studyActions, "studyActions").map((action, index) => text(action, `studyActions[${index}]`, 500)),
    notes: arrays(input.notes || [], "notes").map((note, index) => text(note, `notes[${index}]`, 1_000)),
  };
  return output;
}

export async function parseStudyCoachOutputFile(file) {
  if (!file) throw new Error("Choose a Study Coach output file first.");
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("Study Coach output file is not valid JSON.");
  }
  return validateStudyCoachOutput(parsed);
}

export async function saveStudyCoachOutput(output) {
  await putRecord(STORES.META, {
    key: STUDY_COACH_OUTPUT_META_KEY,
    value: output,
    updatedAt: new Date().toISOString(),
  });
}

export async function loadStudyCoachOutput() {
  const record = await getRecord(STORES.META, STUDY_COACH_OUTPUT_META_KEY);
  return record?.value || null;
}

export async function clearStudyCoachOutput() {
  await putRecord(STORES.META, {
    key: STUDY_COACH_OUTPUT_META_KEY,
    value: null,
    updatedAt: new Date().toISOString(),
  });
}

export async function createCurrentStudyCoachPackage({ banks, appVersion = "1.0.0" } = {}) {
  const [progressRows, practiceSets, practiceSetAnswers] = await Promise.all([
    getAllRecords(STORES.PROGRESS),
    getAllRecords(STORES.SETS),
    getAllRecords(STORES.ANSWERS),
  ]);
  return createStudyCoachPackage({ banks, progressRows, practiceSets, practiceSetAnswers, appVersion });
}
