import { getAllRecords, getRecord, putRecord, STORES } from "./storage.js";
import { buildWeaknessSnapshot } from "./weakness-analytics.js";
import { prepareQuestionBankPackage } from "./question-bank-import.js";

export const STUDY_COACH_PACKAGE_FORMAT = "abpn-study-coach-package";
export const STUDY_COACH_PACKAGE_SCHEMA_VERSION = 1;
export const STUDY_COACH_OUTPUT_FORMAT = "abpn-study-coach-output";
export const STUDY_COACH_OUTPUT_SCHEMA_VERSION = 2;
export const STUDY_COACH_OUTPUT_META_KEY = "study-coach-output-v1";
export const STUDY_COACH_OUTPUT_HISTORY_META_KEY = "study-coach-output-history-v1";
const MAX_OUTPUT_TEXT = 20_000;
const MAX_OUTPUT_LIST = 50;
const MAX_OUTPUT_QUESTION_REFS = 200;
const MAX_PACKAGE_BANKS = 50;
const MAX_PACKAGE_QUESTIONS = 10_000;
const MAX_PACKAGE_PROGRESS_ROWS = 10_000;
const MAX_PACKAGE_PRACTICE_SETS = 2_000;
const MAX_PACKAGE_ANSWERS = 100_000;
const MAX_OUTPUT_HISTORY = 12;
const MAX_GENERATED_DECKS = 12;
const MAX_GENERATED_QUESTIONS = 10_000;
export const MAX_STUDY_COACH_EXCHANGE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_OUTPUT_SCHEMA_VERSIONS = new Set([1, 2]);
const protectedFingerprintCache = new WeakMap();

function invalidOutputFileMessage(input) {
  const format = String(input?.format || "").trim();
  if (!format) return "This is not a valid Study Coach output file.";
  if (format === STUDY_COACH_PACKAGE_FORMAT) {
    return "You selected a Study Coach package. Import or publish a Study Coach output file instead.";
  }
  if (format.startsWith("abpn-")) {
    return `You selected an unsupported ABPN file (${format}). Import or publish a Study Coach output file instead.`;
  }
  return "This is not a valid Study Coach output file.";
}

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

function optionalFiniteNumber(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${field} is invalid`);
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonByteCount(value, field) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
  const byteCount = new TextEncoder().encode(serialized).byteLength;
  if (byteCount > MAX_STUDY_COACH_EXCHANGE_BYTES) throw new Error(`${field} exceeds the 25 MiB exchange limit`);
  return byteCount;
}

function normalizedFingerprintText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function questionContentParts(question) {
  const choices = Array.isArray(question?.choices)
    ? question.choices.map((choice) => typeof choice === "object"
      ? [normalizedFingerprintText(choice.letter), normalizedFingerprintText(choice.text)]
      : normalizedFingerprintText(choice))
    : [];
  const correctAnswer = question?.correctLetters ?? question?.correctAnswer ?? question?.correctLetter ?? [];
  return {
    stem: [question?.vignetteStem, question?.question ?? question?.prompt]
      .map(normalizedFingerprintText)
      .filter(Boolean)
      .join(" | "),
    full: JSON.stringify({
      prompt: normalizedFingerprintText(question?.question ?? question?.prompt),
      vignetteStem: normalizedFingerprintText(question?.vignetteStem),
      choices,
      correctAnswer: (Array.isArray(correctAnswer) ? correctAnswer : [correctAnswer]).map(normalizedFingerprintText),
      answerText: normalizedFingerprintText(question?.answerText),
      explanation: normalizedFingerprintText(question?.explanation),
    }),
  };
}

async function contentDigest(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Protected-content fingerprint validation is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function questionContentFingerprints(question) {
  const parts = questionContentParts(question);
  const fingerprints = [];
  if (parts.stem) fingerprints.push(await contentDigest(`stem:${parts.stem}`));
  fingerprints.push(await contentDigest(`full:${parts.full}`));
  return fingerprints;
}

async function protectedBankFingerprints(bank) {
  if (protectedFingerprintCache.has(bank)) return protectedFingerprintCache.get(bank);
  const pending = Promise.all((bank.questions || []).map(questionContentFingerprints))
    .then((rows) => rows.flat());
  protectedFingerprintCache.set(bank, pending);
  return pending;
}

export function protectedStudyCoachBanks(banks = []) {
  return (banks || []).filter((bank) => bank && bank.contentClass !== "assistant-supplemental");
}

export async function assertNoProtectedQuestionCopies(generatedDecks = [], protectedBanks = []) {
  if (!generatedDecks.length || !protectedBanks.length) return;
  const protectedFingerprints = new Set();
  const protectedRows = await Promise.all(protectedBanks.map(protectedBankFingerprints));
  for (const fingerprint of protectedRows.flat()) protectedFingerprints.add(fingerprint);
  const generatedQuestions = generatedDecks.flatMap((deck) => deck?.package?.bank?.questions || []);
  const generatedRows = await Promise.all(generatedQuestions.map(questionContentFingerprints));
  if (generatedRows.some((fingerprints) => fingerprints.some((fingerprint) => protectedFingerprints.has(fingerprint)))) {
    throw new Error("Generated Study Coach decks cannot copy protected source question content");
  }
}

function boundedArray(value, field, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} is invalid`);
  return value;
}

function optionalTimestamp(value, field) {
  return value == null || value === "" ? null : isoTimestamp(value, field);
}

function selectedAnswer(value, field) {
  if (value == null || value === "") return null;
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 12) throw new Error(`${field} is invalid`);
  const normalized = entries.map((entry, index) => text(entry, `${field}[${index}]`, 20));
  return Array.isArray(value) ? normalized : normalized[0];
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

function deckPackages(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_GENERATED_DECKS) throw new Error(`${field} is invalid`);
  return value;
}

function choiceSummary(question) {
  return question.choices.map((choice, index) => ({
    letter: String(question.choiceLetters?.[index] || ""),
    text: String(choice || ""),
  }));
}

function generatedDecks(value) {
  let totalQuestions = 0;
  return deckPackages(value, "generatedDecks").map((deck, index) => {
    const rawPackage = clone(deck.package || deck.bankPackage || deck.questionBankPackage || null);
    if (!rawPackage || typeof rawPackage !== "object" || Array.isArray(rawPackage)) {
      throw new Error(`generatedDecks[${index}].package is invalid`);
    }
    const fallbackTitle = rawPackage.bank?.title || rawPackage.bank?.shortTitle || rawPackage.bank?.id || `Coach deck ${index + 1}`;
    const fallbackBankId = rawPackage.bank?.id || deck.bankId || "";
    if (rawPackage.bank?.sourceType !== "assistant-supplemental" || rawPackage.bank?.contentClass !== "assistant-supplemental") {
      throw new Error(`generatedDecks[${index}] must contain only assistant-supplemental content`);
    }
    const fallbackQuestionCount = integer(rawPackage.bank?.questions?.length, `generatedDecks[${index}].package.bank.questions`, { minimum: 1, maximum: 5_000 });
    if (deck.questionCount != null && integer(deck.questionCount, `generatedDecks[${index}].questionCount`, { minimum: 1, maximum: 5_000 }) !== fallbackQuestionCount) {
      throw new Error(`generatedDecks[${index}].questionCount does not match its package`);
    }
    totalQuestions += fallbackQuestionCount;
    if (totalQuestions > MAX_GENERATED_QUESTIONS) throw new Error("generatedDecks contains too many questions");
    return {
      title: text(deck.title || fallbackTitle, `generatedDecks[${index}].title`, 200),
      objective: optionalText(deck.objective, `generatedDecks[${index}].objective`, 2_000),
      bankId: text(deck.bankId || fallbackBankId, `generatedDecks[${index}].bankId`, 100),
      questionCount: fallbackQuestionCount,
      package: rawPackage,
    };
  });
}

function outputHistoryKey(output) {
  return [
    String(output?.generatedAt || ""),
    String(output?.sourcePackageGeneratedAt || ""),
    String(output?.summary || ""),
  ].join("|");
}

function normalizeStudyCoachOutput(input) {
  jsonByteCount(input, "Study Coach output");
  const schemaVersion = Math.trunc(Number(input?.schemaVersion));
  if (!input || input.format !== STUDY_COACH_OUTPUT_FORMAT || !SUPPORTED_OUTPUT_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new Error(invalidOutputFileMessage(input));
  }
  return {
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
    generatedDecks: generatedDecks(input.generatedDecks || []),
  };
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

function questionIdList(value, field) {
  return boundedArray(value, field, MAX_PACKAGE_QUESTIONS)
    .map((entry, index) => text(entry, `${field}[${index}]`, 200));
}

function normalizeWeaknessSnapshot(value, field) {
  if (!value || value.schemaVersion !== 1 || value.evidenceModel !== "limited-current-state") {
    throw new Error(`${field} is invalid`);
  }
  return {
    schemaVersion: 1,
    evidenceModel: "limited-current-state",
    baselineTimeMs: value.baselineTimeMs == null ? null : integer(value.baselineTimeMs, `${field}.baselineTimeMs`),
    domains: boundedArray(value.domains, `${field}.domains`, 100).map((domain, index) => ({
      title: text(domain.title, `${field}.domains[${index}].title`, 200),
      totalQuestions: integer(domain.totalQuestions, `${field}.domains[${index}].totalQuestions`),
      usedQuestions: integer(domain.usedQuestions, `${field}.domains[${index}].usedQuestions`),
      attempts: integer(domain.attempts, `${field}.domains[${index}].attempts`),
      smoothedAccuracy: ratio(domain.smoothedAccuracy, `${field}.domains[${index}].smoothedAccuracy`),
      averageTimeMs: domain.averageTimeMs == null ? null : integer(domain.averageTimeMs, `${field}.domains[${index}].averageTimeMs`),
      speedRatio: optionalFiniteNumber(domain.speedRatio, `${field}.domains[${index}].speedRatio`),
      daysSinceUse: optionalFiniteNumber(domain.daysSinceUse, `${field}.domains[${index}].daysSinceUse`),
      questionShare: ratio(domain.questionShare, `${field}.domains[${index}].questionShare`),
      evidence: ["none", "limited", "adequate"].includes(domain.evidence) ? domain.evidence : "none",
      priorityScore: domain.priorityScore == null ? null : integer(domain.priorityScore, `${field}.domains[${index}].priorityScore`, { maximum: 100 }),
      studyPriorityScore: domain.studyPriorityScore == null ? null : integer(domain.studyPriorityScore, `${field}.domains[${index}].studyPriorityScore`, { maximum: 100 }),
      mastered: Boolean(domain.mastered),
    })),
    evidenceCoverage: ratio(value.evidenceCoverage, `${field}.evidenceCoverage`),
    masteryCoverage: ratio(value.masteryCoverage, `${field}.masteryCoverage`),
  };
}

function normalizeProgressRow(row, index) {
  return {
    bankId: text(row.bankId, `studyState.progress[${index}].bankId`, 100),
    questionId: text(row.questionId, `studyState.progress[${index}].questionId`, 200),
    selectedAnswer: selectedAnswer(row.selectedAnswer, `studyState.progress[${index}].selectedAnswer`),
    isCorrect: row.isCorrect == null ? null : Boolean(row.isCorrect),
    isFlagged: Boolean(row.isFlagged),
    note: optionalText(row.note || row.notes, `studyState.progress[${index}].note`, 20_000),
    timesUsed: integer(row.timesUsed ?? 0, `studyState.progress[${index}].timesUsed`),
    totalTimeMs: integer(row.totalTimeMs ?? 0, `studyState.progress[${index}].totalTimeMs`),
    lastUsedAt: optionalTimestamp(row.lastUsedAt, `studyState.progress[${index}].lastUsedAt`),
    revision: integer(row.revision ?? 0, `studyState.progress[${index}].revision`),
    updatedAt: optionalTimestamp(row.updatedAt, `studyState.progress[${index}].updatedAt`),
  };
}

function normalizePracticeSet(row, index) {
  const prefix = `studyState.practiceSets[${index}]`;
  const specialCriteria = row.specialCriteria && typeof row.specialCriteria === "object"
    ? {
      rangeStart: row.specialCriteria.rangeStart == null ? null : integer(row.specialCriteria.rangeStart, `${prefix}.specialCriteria.rangeStart`),
      rangeEnd: row.specialCriteria.rangeEnd == null ? null : integer(row.specialCriteria.rangeEnd, `${prefix}.specialCriteria.rangeEnd`),
      includeFlagged: Boolean(row.specialCriteria.includeFlagged),
    }
    : null;
  return {
    id: text(row.id, `${prefix}.id`, 200),
    bankId: optionalText(row.bankId, `${prefix}.bankId`, 100),
    selectedBankIds: boundedArray(row.selectedBankIds || [], `${prefix}.selectedBankIds`, MAX_PACKAGE_BANKS)
      .map((entry, entryIndex) => text(entry, `${prefix}.selectedBankIds[${entryIndex}]`, 100)),
    questionIds: questionIdList(row.questionIds || [], `${prefix}.questionIds`),
    status: text(row.status || "active", `${prefix}.status`, 40),
    mode: row.mode === "tutor" ? "tutor" : "test",
    timed: Boolean(row.timed),
    randomized: Boolean(row.randomized),
    pool: optionalText(row.pool, `${prefix}.pool`, 40),
    categories: boundedArray(row.categories || [], `${prefix}.categories`, 200)
      .map((entry, entryIndex) => text(entry, `${prefix}.categories[${entryIndex}]`, 500)),
    specialCriteria,
    priorAttemptQuestionIds: questionIdList(row.priorAttemptQuestionIds || [], `${prefix}.priorAttemptQuestionIds`),
    index: integer(row.index ?? 0, `${prefix}.index`),
    remainingSeconds: row.remainingSeconds == null ? null : integer(row.remainingSeconds, `${prefix}.remainingSeconds`),
    submitted: Boolean(row.submitted),
    startedAt: optionalTimestamp(row.startedAt, `${prefix}.startedAt`),
    completedAt: optionalTimestamp(row.completedAt, `${prefix}.completedAt`),
    updatedAt: optionalTimestamp(row.updatedAt, `${prefix}.updatedAt`),
  };
}

function normalizePracticeSetAnswer(row, index) {
  const prefix = `studyState.practiceSetAnswers[${index}]`;
  return {
    setId: text(row.setId, `${prefix}.setId`, 200),
    questionId: text(row.questionId, `${prefix}.questionId`, 200),
    selectedAnswer: selectedAnswer(row.selectedAnswer, `${prefix}.selectedAnswer`),
    isCorrect: row.isCorrect == null ? null : Boolean(row.isCorrect),
    timeMs: integer(row.timeMs ?? 0, `${prefix}.timeMs`),
    revision: integer(row.revision ?? 0, `${prefix}.revision`),
    updatedAt: optionalTimestamp(row.updatedAt, `${prefix}.updatedAt`),
  };
}

function normalizePackageQuestion(question, bankIndex, questionIndex) {
  const prefix = `banks[${bankIndex}].questions[${questionIndex}]`;
  const choices = boundedArray(question.choices, `${prefix}.choices`, 12).map((choice, choiceIndex) => ({
    letter: text(choice.letter, `${prefix}.choices[${choiceIndex}].letter`, 20),
    text: text(choice.text, `${prefix}.choices[${choiceIndex}].text`, 20_000),
  }));
  if (choices.length < 2) throw new Error(`${prefix}.choices is invalid`);
  const correctAnswer = boundedArray(question.correctAnswer, `${prefix}.correctAnswer`, 12)
    .map((entry, entryIndex) => text(entry, `${prefix}.correctAnswer[${entryIndex}]`, 20));
  if (!correctAnswer.length) throw new Error(`${prefix}.correctAnswer is invalid`);
  return {
    id: text(question.id, `${prefix}.id`, 200),
    number: integer(question.number, `${prefix}.number`, { minimum: 1, maximum: MAX_PACKAGE_QUESTIONS }),
    subjectTitle: text(question.subjectTitle, `${prefix}.subjectTitle`, 500),
    testSection: text(question.testSection, `${prefix}.testSection`, 500),
    prompt: text(question.prompt, `${prefix}.prompt`, 50_000),
    vignetteStem: optionalText(question.vignetteStem, `${prefix}.vignetteStem`, 100_000),
    choices,
    correctAnswer,
    answerText: optionalText(question.answerText, `${prefix}.answerText`, 20_000),
    explanation: text(question.explanation, `${prefix}.explanation`, 100_000),
    linkedGroupId: optionalText(question.linkedGroupId, `${prefix}.linkedGroupId`, 500) || null,
    linkedOrder: question.linkedOrder == null ? null : integer(question.linkedOrder, `${prefix}.linkedOrder`),
    isMultiSelect: Boolean(question.isMultiSelect),
    progress: question.progress == null ? null : normalizeProgressRow({
      ...question.progress,
      bankId: question.progress.bankId || "embedded",
      questionId: question.progress.questionId || question.id,
    }, questionIndex),
  };
}

export function normalizeStudyCoachPackage(input) {
  if (!input || input.format !== STUDY_COACH_PACKAGE_FORMAT || input.schemaVersion !== STUDY_COACH_PACKAGE_SCHEMA_VERSION) {
    throw new Error("This is not a valid Study Coach package file.");
  }
  jsonByteCount(input, "Study Coach package");
  const exportedAt = isoTimestamp(input.exportedAt, "exportedAt");
  const appVersion = text(input.appVersion, "appVersion", 100);
  const banks = boundedArray(input.banks, "banks", MAX_PACKAGE_BANKS);
  if (!banks.length) throw new Error("banks is invalid");
  let totalQuestions = 0;
  const normalizedBanks = banks.map((bank, bankIndex) => {
    const questions = boundedArray(bank?.questions, `banks[${bankIndex}].questions`, MAX_PACKAGE_QUESTIONS)
      .map((question, questionIndex) => normalizePackageQuestion(question, bankIndex, questionIndex));
    if (!questions.length) throw new Error(`banks[${bankIndex}].questions is invalid`);
    const declaredTotal = integer(bank.totalQuestions, `banks[${bankIndex}].totalQuestions`, { maximum: MAX_PACKAGE_QUESTIONS });
    if (declaredTotal !== questions.length) throw new Error(`banks[${bankIndex}].totalQuestions does not match its questions`);
    totalQuestions += questions.length;
    if (totalQuestions > MAX_PACKAGE_QUESTIONS) throw new Error("Study Coach package is too large");
    return {
      id: text(bank.id, `banks[${bankIndex}].id`, 100),
      title: text(bank.title, `banks[${bankIndex}].title`, 200),
      version: text(bank.version, `banks[${bankIndex}].version`, 100),
      sourceType: optionalText(bank.sourceType, `banks[${bankIndex}].sourceType`, 100) || "source-material",
      contentClass: optionalText(bank.contentClass, `banks[${bankIndex}].contentClass`, 100) || "source-material",
      totalQuestions: declaredTotal,
      weaknessSnapshot: normalizeWeaknessSnapshot(bank.weaknessSnapshot, `banks[${bankIndex}].weaknessSnapshot`),
      questionIndexes: {
        attempted: questionIdList(bank.questionIndexes?.attempted, `banks[${bankIndex}].questionIndexes.attempted`),
        incorrect: questionIdList(bank.questionIndexes?.incorrect, `banks[${bankIndex}].questionIndexes.incorrect`),
        flagged: questionIdList(bank.questionIndexes?.flagged, `banks[${bankIndex}].questionIndexes.flagged`),
        annotated: questionIdList(bank.questionIndexes?.annotated, `banks[${bankIndex}].questionIndexes.annotated`),
        unused: questionIdList(bank.questionIndexes?.unused, `banks[${bankIndex}].questionIndexes.unused`),
      },
      questions,
    };
  });
  const studyState = input.studyState || {};
  const normalized = {
    format: STUDY_COACH_PACKAGE_FORMAT,
    schemaVersion: STUDY_COACH_PACKAGE_SCHEMA_VERSION,
    exportedAt,
    appVersion,
    purpose: "full-study-coach-analysis-and-output",
    banks: normalizedBanks,
    studyState: {
      progress: boundedArray(studyState.progress, "studyState.progress", MAX_PACKAGE_PROGRESS_ROWS).map(normalizeProgressRow),
      practiceSets: boundedArray(studyState.practiceSets, "studyState.practiceSets", MAX_PACKAGE_PRACTICE_SETS).map(normalizePracticeSet),
      practiceSetAnswers: boundedArray(studyState.practiceSetAnswers, "studyState.practiceSetAnswers", MAX_PACKAGE_ANSWERS).map(normalizePracticeSetAnswer),
    },
    outputContract: {
      format: STUDY_COACH_OUTPUT_FORMAT,
      schemaVersion: STUDY_COACH_OUTPUT_SCHEMA_VERSION,
      supportedSections: ["summary", "focusAreas", "recommendedSets", "progressMetrics", "studyActions", "notes", "generatedDecks"],
      questionRefShape: { bankId: "string", questionId: "string" },
    },
  };
  jsonByteCount(normalized, "Study Coach package");
  return normalized;
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
        sourceType: String(bank.sourceType || "source-material"),
        contentClass: String(bank.contentClass || "source-material"),
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
      supportedSections: ["summary", "focusAreas", "recommendedSets", "progressMetrics", "studyActions", "notes", "generatedDecks"],
      questionRefShape: { bankId: "string", questionId: "string" },
    },
  };
}

export function validateStudyCoachPackage(input) {
  const normalized = normalizeStudyCoachPackage(input);
  return {
    exportedAt: normalized.exportedAt,
    appVersion: normalized.appVersion,
    bankCount: normalized.banks.length,
    questionCount: normalized.banks.reduce((sum, bank) => sum + bank.questions.length, 0),
  };
}

export function studyCoachPackageFilename(exportedAt = new Date().toISOString()) {
  return `abpn-study-coach-package-${exportedAt.replace(/[:.]/g, "-")}.json`;
}

export function downloadStudyCoachPackage(pkg) {
  validateStudyCoachPackage(pkg);
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
  return normalizeStudyCoachOutput(input);
}

export async function prepareStudyCoachOutput(input, { reservedIds = [], protectedBanks = [] } = {}) {
  const output = validateStudyCoachOutput(input);
  const preparedGeneratedDecks = await Promise.all(output.generatedDecks.map(async (deck, index) => {
    const preparedPackage = await prepareQuestionBankPackage(deck.package, { reservedIds });
    return {
      title: deck.title,
      objective: deck.objective,
      bankId: preparedPackage.bank.id,
      questionCount: preparedPackage.bank.questions.length,
      package: preparedPackage,
      displayOrder: index,
    };
  }));
  const prepared = {
    ...output,
    generatedDecks: preparedGeneratedDecks,
  };
  await assertNoProtectedQuestionCopies(prepared.generatedDecks, protectedBanks);
  jsonByteCount(prepared, "Study Coach output");
  return prepared;
}

export async function parseStudyCoachOutputFile(file, options = {}) {
  if (!file) throw new Error("Choose a Study Coach output file first.");
  if (Number(file.size || 0) > MAX_STUDY_COACH_EXCHANGE_BYTES) throw new Error("Study Coach output file exceeds the 25 MiB limit.");
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("Study Coach output file is not valid JSON.");
  }
  return prepareStudyCoachOutput(parsed, options);
}

export async function saveStudyCoachOutput(output) {
  if (output) jsonByteCount(output, "Study Coach output");
  const updatedAt = new Date().toISOString();
  const historyRecord = await getRecord(STORES.META, STUDY_COACH_OUTPUT_HISTORY_META_KEY);
  const history = Array.isArray(historyRecord?.value) ? historyRecord.value : [];
  const historyCopy = output ? {
    ...clone(output),
    generatedDecks: (output.generatedDecks || []).map(({ package: _package, ...deck }) => deck),
  } : null;
  const nextHistory = historyCopy
    ? [historyCopy, ...history.filter((entry) => outputHistoryKey(entry) !== outputHistoryKey(output))].slice(0, MAX_OUTPUT_HISTORY)
    : [];
  await Promise.all([
    putRecord(STORES.META, {
      key: STUDY_COACH_OUTPUT_META_KEY,
      value: output,
      updatedAt,
    }),
    putRecord(STORES.META, {
      key: STUDY_COACH_OUTPUT_HISTORY_META_KEY,
      value: nextHistory,
      updatedAt,
    }),
  ]);
}

export async function loadStudyCoachOutput() {
  const record = await getRecord(STORES.META, STUDY_COACH_OUTPUT_META_KEY);
  return record?.value || null;
}

export async function loadStudyCoachOutputHistory() {
  const record = await getRecord(STORES.META, STUDY_COACH_OUTPUT_HISTORY_META_KEY);
  return Array.isArray(record?.value) ? record.value : [];
}

export async function clearStudyCoachOutput() {
  const updatedAt = new Date().toISOString();
  await Promise.all([
    putRecord(STORES.META, {
      key: STUDY_COACH_OUTPUT_META_KEY,
      value: null,
      updatedAt,
    }),
    putRecord(STORES.META, {
      key: STUDY_COACH_OUTPUT_HISTORY_META_KEY,
      value: [],
      updatedAt,
    }),
  ]);
}

export async function createCurrentStudyCoachPackage({ banks, appVersion = "1.0.0" } = {}) {
  const [progressRows, practiceSets, practiceSetAnswers] = await Promise.all([
    getAllRecords(STORES.PROGRESS),
    getAllRecords(STORES.SETS),
    getAllRecords(STORES.ANSWERS),
  ]);
  const pkg = createStudyCoachPackage({ banks, progressRows, practiceSets, practiceSetAnswers, appVersion });
  validateStudyCoachPackage(pkg);
  return pkg;
}
