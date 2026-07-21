import { normalizeBank } from "./study-engine.js";
import {
  STORES,
  getAllRecords,
  getRecord,
  openStudyDatabase,
  recordsByIndex,
} from "./storage.js";

export const QUESTION_BANK_PACKAGE_FORMAT = "abpn-question-bank";
export const QUESTION_BANK_PACKAGE_SCHEMA_VERSION = 1;
export const MAX_QUESTION_BANK_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_QUESTIONS_PER_BANK = 5_000;

const ALLOWED_SOURCE_TYPES = new Set(["user-imported", "assistant-supplemental"]);
const ALLOWED_CONTENT_CLASSES = new Set(["source-material", "assistant-supplemental"]);

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
});

const text = (value, field, maxLength, { required = true } = {}) => {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${field} is required.`);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength.toLocaleString()} characters.`);
  return normalized;
};

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateQuestionShape(question, index, bankId) {
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    throw new Error(`Question ${index + 1} in ${bankId} must be an object.`);
  }
  const id = text(question.id || `${bankId}-${index + 1}`, `Question ${index + 1} id`, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error(`Question id ${id} contains unsupported characters.`);
  }
  text(question.question, `Question ${id} text`, 50_000);
  text(question.chapterTitle || question.category || "Uncategorized", `Question ${id} category`, 500);
  text(question.explanation || "No explanation provided.", `Question ${id} explanation`, 100_000);
  if (!Array.isArray(question.choices) || question.choices.length < 2 || question.choices.length > 10) {
    throw new Error(`Question ${id} must contain between 2 and 10 choices.`);
  }
  question.choices.forEach((choice, choiceIndex) => text(choice, `Question ${id} choice ${choiceIndex + 1}`, 20_000));
  if (question.choiceLetters != null) {
    if (!Array.isArray(question.choiceLetters) || question.choiceLetters.length !== question.choices.length) {
      throw new Error(`Question ${id} choiceLetters must match the choices array.`);
    }
    const letters = question.choiceLetters.map((letter, letterIndex) => text(letter, `Question ${id} choice letter ${letterIndex + 1}`, 10));
    if (new Set(letters).size !== letters.length) throw new Error(`Question ${id} contains duplicate choice letters.`);
  }
}

function normalizedPackageBank(bank) {
  const id = text(bank?.id, "Bank id", 100).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) throw new Error(`Invalid bank id: ${id}`);
  const sourceType = text(bank.sourceType, "Bank sourceType", 50);
  const contentClass = text(bank.contentClass, "Bank contentClass", 50);
  if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
    throw new Error("sourceType must be user-imported or assistant-supplemental.");
  }
  if (!ALLOWED_CONTENT_CLASSES.has(contentClass)) {
    throw new Error("contentClass must be source-material or assistant-supplemental.");
  }
  if (sourceType === "assistant-supplemental" && contentClass !== "assistant-supplemental") {
    throw new Error("Assistant-created material must remain in the assistant-supplemental content class.");
  }
  if (contentClass === "assistant-supplemental" && sourceType !== "assistant-supplemental") {
    throw new Error("Assistant supplemental content must use sourceType assistant-supplemental.");
  }
  const questions = bank.questions;
  if (!Array.isArray(questions) || questions.length < 1) throw new Error("The question bank contains no questions.");
  if (questions.length > MAX_QUESTIONS_PER_BANK) {
    throw new Error(`A question bank may contain at most ${MAX_QUESTIONS_PER_BANK.toLocaleString()} questions.`);
  }
  questions.forEach((question, index) => validateQuestionShape(question, index, id));

  const normalized = normalizeBank({
    id,
    title: text(bank.title, "Bank title", 200),
    shortTitle: text(bank.shortTitle || bank.title, "Bank shortTitle", 100),
    description: text(bank.description || "", "Bank description", 2_000, { required: false }),
    version: text(bank.version, "Bank version", 50),
    sourceType,
    contentClass,
    sourceLabel: text(bank.sourceLabel || "", "Bank sourceLabel", 300, { required: false }),
    protected: false,
    questions,
  });

  return {
    id: normalized.id,
    title: normalized.title,
    shortTitle: normalized.shortTitle,
    description: normalized.description,
    version: normalized.version,
    sourceType,
    contentClass,
    sourceLabel: normalized.sourceLabel,
    protected: false,
    questions: normalized.questions.map((question) => ({
      id: question.id,
      chapter: question.chapter,
      chapterTitle: question.chapterTitle,
      question: question.question,
      choices: [...question.choices],
      choiceLetters: [...question.choiceLetters],
      correctLetter: question.correctLetter,
      explanation: question.explanation,
    })),
  };
}

export async function prepareQuestionBankPackage(input, { reservedIds = [] } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Question-bank package must contain a JSON object.");
  if (input.format !== QUESTION_BANK_PACKAGE_FORMAT) throw new Error("This is not an ABPN Study question-bank package.");
  if (input.schemaVersion !== QUESTION_BANK_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported question-bank schema version: ${input.schemaVersion ?? "missing"}.`);
  }
  const bank = normalizedPackageBank(input.bank);
  if (new Set(reservedIds).has(bank.id)) {
    throw new Error(`The bank id ${bank.id} is reserved by a protected built-in question bank.`);
  }
  const checksum = await sha256Hex(bank);
  const importedAt = new Date().toISOString();
  return {
    format: QUESTION_BANK_PACKAGE_FORMAT,
    schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
    bank: { ...bank, checksum, importedAt },
    checksum,
  };
}

export async function parseQuestionBankPackageFile(file, options = {}) {
  if (!file) throw new Error("Choose a question-bank JSON file first.");
  if (file.size > MAX_QUESTION_BANK_FILE_BYTES) throw new Error("Question-bank file exceeds the 25 MiB safety limit.");
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("Question-bank file is not valid JSON.");
  }
  return prepareQuestionBankPackage(parsed, options);
}

export function questionFingerprint(question) {
  return stableStringify({
    id: question.id,
    chapter: question.chapter ?? "",
    chapterTitle: question.chapterTitle,
    question: question.question,
    choices: question.choices,
    choiceLetters: question.choiceLetters,
    correctLetter: question.correctLetter,
    explanation: question.explanation,
  });
}

export function analyzeQuestionBankUpdate(existing, incoming, { hasStudyData = false } = {}) {
  if (!existing) return { status: "new", additive: true, addedQuestions: incoming.questions.length };
  if (existing.checksum === incoming.checksum) return { status: "unchanged", additive: true, addedQuestions: 0 };
  if (existing.version === incoming.version) {
    throw new Error("The package content changed without a new bank version. Increase the version before importing it.");
  }
  if (existing.contentClass !== incoming.contentClass || existing.sourceType !== incoming.sourceType) {
    throw new Error("An existing bank cannot change between source material and assistant supplemental content. Use a new bank id.");
  }

  const incomingById = new Map(incoming.questions.map((question) => [question.id, question]));
  const changedOrRemoved = existing.questions.filter((question) => {
    const next = incomingById.get(question.id);
    return !next || questionFingerprint(question) !== questionFingerprint(next);
  });
  if (hasStudyData && changedOrRemoved.length) {
    throw new Error(
      `This update changes or removes ${changedOrRemoved.length} existing question(s) while progress or test history exists. Import it under a new bank id to protect prior results.`
    );
  }
  return {
    status: "update",
    additive: changedOrRemoved.length === 0,
    changedOrRemovedQuestions: changedOrRemoved.map((question) => question.id),
    addedQuestions: incoming.questions.filter((question) => !existing.questions.some((old) => old.id === question.id)).length,
  };
}

export async function installQuestionBankPackage(prepared, { reservedIds = [] } = {}) {
  const packageRecord = prepared?.bank?.checksum
    ? prepared
    : await prepareQuestionBankPackage(prepared, { reservedIds });
  const incoming = packageRecord.bank;
  if (new Set(reservedIds).has(incoming.id)) throw new Error(`The bank id ${incoming.id} is reserved.`);

  const [existing, progress, sets] = await Promise.all([
    getRecord(STORES.BANK_CONTENT, incoming.id),
    recordsByIndex(STORES.PROGRESS, "byBank", incoming.id),
    recordsByIndex(STORES.SETS, "byBank", incoming.id),
  ]);
  const analysis = analyzeQuestionBankUpdate(existing, incoming, { hasStudyData: progress.length > 0 || sets.length > 0 });
  if (analysis.status === "unchanged") return { ...analysis, bank: existing };

  const now = new Date().toISOString();
  const installed = { ...incoming, importedAt: existing?.importedAt || incoming.importedAt || now, updatedAt: now };
  const metadata = {
    id: installed.id,
    title: installed.title,
    shortTitle: installed.shortTitle,
    description: installed.description,
    version: installed.version,
    questionCount: installed.questions.length,
    sourceType: installed.sourceType,
    contentClass: installed.contentClass,
    sourceLabel: installed.sourceLabel,
    protected: false,
    checksum: installed.checksum,
    importedAt: installed.importedAt,
    updatedAt: now,
  };
  const revision = {
    bankId: installed.id,
    checksum: installed.checksum,
    version: installed.version,
    archivedAt: now,
    package: {
      format: QUESTION_BANK_PACKAGE_FORMAT,
      schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
      bank: installed,
    },
  };

  const db = await openStudyDatabase();
  try {
    const transaction = db.transaction([STORES.BANK_CONTENT, STORES.BANK_REVISIONS, STORES.BANKS], "readwrite");
    if (existing) {
      transaction.objectStore(STORES.BANK_REVISIONS).put({
        bankId: existing.id,
        checksum: existing.checksum,
        version: existing.version,
        archivedAt: now,
        package: {
          format: QUESTION_BANK_PACKAGE_FORMAT,
          schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
          bank: existing,
        },
      });
    }
    transaction.objectStore(STORES.BANK_REVISIONS).put(revision);
    transaction.objectStore(STORES.BANK_CONTENT).put(installed);
    transaction.objectStore(STORES.BANKS).put(metadata);
    await transactionDone(transaction);
  } finally {
    db.close();
  }

  return { ...analysis, bank: installed };
}

export async function loadInstalledQuestionBanks(builtInDefinitions = []) {
  const imported = await getAllRecords(STORES.BANK_CONTENT);
  return [
    ...builtInDefinitions,
    ...imported.sort((left, right) => left.title.localeCompare(right.title)),
  ];
}

export async function exportInstalledQuestionBankPackage(bankId) {
  const bank = await getRecord(STORES.BANK_CONTENT, bankId);
  if (!bank) throw new Error("Only locally imported question banks can be downloaded as packages.");
  return {
    format: QUESTION_BANK_PACKAGE_FORMAT,
    schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bank,
  };
}

export function questionBankPackageFilename(bank) {
  const safeId = String(bank.id).replace(/[^a-z0-9._-]+/gi, "-");
  const safeVersion = String(bank.version).replace(/[^a-z0-9._-]+/gi, "-");
  return `${safeId}-v${safeVersion}.abpn-question-bank.json`;
}

export function downloadQuestionBankPackage(questionBankPackage) {
  const blob = new Blob([JSON.stringify(questionBankPackage, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = questionBankPackageFilename(questionBankPackage.bank);
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
