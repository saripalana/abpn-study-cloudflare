import {
  installQuestionBankPackage,
  prepareQuestionBankPackage,
  QUESTION_BANK_PACKAGE_FORMAT,
  QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
} from "./question-bank-import.js";
import {
  getCloudDeckBootstrapState,
  listCloudDecks,
  publishCloudDeckPackage,
  setCloudDeckBootstrapState,
} from "./deck-library.js";
import { parseLegacyQuestionsArray } from "./legacy-spiegel-import.js";
import { STORES, getRecord, putRecord } from "./storage.js";

export const UNIFIED_DECK_BOOTSTRAP_VERSION = "unified-deck-library-v1";
const LOCAL_BOOTSTRAP_KEY = `deckBootstrap:${UNIFIED_DECK_BOOTSTRAP_VERSION}`;

export const KS_STARTER_SOURCE = Object.freeze({
  id: "ks-psychiatry-core",
  repository: "saripalana/ks-study-guide",
  commit: "4d03f158c6fbfacd698796d94c213a49ac8a377d",
  path: "data.js",
  expectedGitBlobSha: "f4180d69a4a6bbd8a7f764bb88e7f2f404f7431f",
  expectedQuestionCount: 602,
});

const KS_SOURCE_URL = `https://raw.githubusercontent.com/${KS_STARTER_SOURCE.repository}/${KS_STARTER_SOURCE.commit}/${KS_STARTER_SOURCE.path}`;

function validationDeckDefinition() {
  return {
    id: "validation-bank",
    title: "System Validation Question Bank",
    shortTitle: "Validation Bank",
    description: "A small non-production deck retained for regression testing of test, tutor, timing, storage, analytics, and synchronization behavior.",
    version: "1.0.0",
    sourceType: "user-imported",
    contentClass: "source-material",
    sourceLabel: "ABPN Study validation fixture",
    questions: [
      { id: "validation-1", chapterTitle: "Application Safety", question: "In test mode, when should the correct answer be revealed?", choices: ["Before selecting an answer", "Immediately after each answer", "After the set is submitted", "Only after deleting the set"], choiceLetters: ["A", "B", "C", "D"], correctLetter: "C", explanation: "Test mode should delay feedback until submission." },
      { id: "validation-2", chapterTitle: "Application Safety", question: "Which storage design best protects progress during a brief loss of internet access?", choices: ["Cloud-only writes", "Local-first storage with a sync outbox", "Refreshing the page repeatedly", "Storing progress only in the URL"], choiceLetters: ["A", "B", "C", "D"], correctLetter: "B", explanation: "Local-first storage saves immediately and synchronizes when connectivity returns." },
      { id: "validation-3", chapterTitle: "Decks", question: "How should progress from two different decks be stored?", choices: ["In one shared question namespace", "Only in memory", "Using deck-bound identifiers", "By question number alone"], choiceLetters: ["A", "B", "C", "D"], correctLetter: "C", explanation: "Every progress record must include the deck identifier and question identifier." },
    ],
  };
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function gitBlobSha1(bytes) {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const value = new Uint8Array(prefix.byteLength + bytes.byteLength);
  value.set(prefix, 0);
  value.set(new Uint8Array(bytes), prefix.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", value));
}

function validateKsQuestions(questions) {
  if (!Array.isArray(questions) || questions.length !== KS_STARTER_SOURCE.expectedQuestionCount) {
    throw new Error(`K&S source count mismatch: expected ${KS_STARTER_SOURCE.expectedQuestionCount}, received ${Array.isArray(questions) ? questions.length : "non-array"}.`);
  }
  const ids = new Set();
  for (const [index, question] of questions.entries()) {
    const id = String(question?.id || "");
    const choices = Array.isArray(question?.choices) ? question.choices : [];
    const letters = Array.isArray(question?.choiceLetters) ? question.choiceLetters : [];
    if (!id || ids.has(id)) throw new Error(`Missing or duplicate K&S question id at index ${index}: ${id}`);
    if (!String(question?.question || "").trim()) throw new Error(`K&S question ${id} has no prompt.`);
    if (choices.length < 2 || choices.length !== letters.length) throw new Error(`K&S question ${id} has invalid choices.`);
    if (!letters.includes(String(question?.correctLetter || ""))) throw new Error(`K&S question ${id} has an invalid correct answer.`);
    ids.add(id);
  }
  return questions;
}

export async function prepareKsStarterDeck(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(KS_SOURCE_URL, {
    headers: { Accept: "text/javascript,text/plain" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Unable to retrieve the pinned K&S deck source: HTTP ${response.status}.`);
  const bytes = await response.arrayBuffer();
  const gitBlobSha = await gitBlobSha1(bytes);
  if (gitBlobSha !== KS_STARTER_SOURCE.expectedGitBlobSha) {
    throw new Error(`K&S source hash mismatch: expected ${KS_STARTER_SOURCE.expectedGitBlobSha}, received ${gitBlobSha}.`);
  }
  const sourceText = new TextDecoder().decode(bytes);
  const questions = validateKsQuestions(parseLegacyQuestionsArray(sourceText, "K&S data.js"));
  return prepareQuestionBankPackage({
    format: QUESTION_BANK_PACKAGE_FORMAT,
    schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
    bank: {
      id: KS_STARTER_SOURCE.id,
      title: "K&S Psychiatry Question Bank",
      shortTitle: "K&S Psychiatry",
      description: "Kaplan & Sadock psychiatry review questions for personal board preparation.",
      version: KS_STARTER_SOURCE.commit,
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: `K&S · ${KS_STARTER_SOURCE.repository}@${KS_STARTER_SOURCE.commit.slice(0, 12)}`,
      questions,
    },
  });
}

export async function prepareValidationStarterDeck() {
  return prepareQuestionBankPackage({
    format: QUESTION_BANK_PACKAGE_FORMAT,
    schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
    bank: validationDeckDefinition(),
  });
}

async function ensureLocalDeck(id, prepare) {
  const current = await getRecord(STORES.BANK_CONTENT, id);
  if (current) return { bank: current, status: "current" };
  const prepared = await prepare();
  const installed = await installQuestionBankPackage(prepared);
  return { prepared, bank: installed.bank, status: installed.status };
}

export async function ensureUnifiedStarterDecks({ fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  let cloudState = null;
  let remoteDecks = [];
  let cloudAvailable = true;
  try {
    [cloudState, remoteDecks] = await Promise.all([
      getCloudDeckBootstrapState(fetchImpl),
      listCloudDecks(fetchImpl),
    ]);
  } catch (error) {
    cloudAvailable = false;
    console.warn("Cloud starter-deck state is unavailable; preparing local decks only.", error);
  }

  if (cloudState?.version === UNIFIED_DECK_BOOTSTRAP_VERSION) {
    return { status: "complete", cloudAvailable, remoteDecks };
  }

  const remoteById = new Map(remoteDecks.map((deck) => [deck.id, deck]));
  const starters = [
    { id: "validation-bank", prepare: () => prepareValidationStarterDeck() },
    { id: KS_STARTER_SOURCE.id, prepare: () => prepareKsStarterDeck(fetchImpl) },
  ];
  const results = [];
  let cloudComplete = cloudAvailable;

  for (const starter of starters) {
    let local;
    try {
      local = await ensureLocalDeck(starter.id, starter.prepare);
      results.push({ id: starter.id, local: local.status });
    } catch (error) {
      results.push({ id: starter.id, local: "error", error });
      cloudComplete = false;
      continue;
    }

    if (!cloudAvailable || remoteById.has(starter.id)) continue;
    const prepared = local.prepared || {
      format: QUESTION_BANK_PACKAGE_FORMAT,
      schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
      checksum: local.bank.checksum,
      bank: local.bank,
    };
    try {
      const publication = await publishCloudDeckPackage(prepared, fetchImpl);
      results.at(-1).cloud = publication.queued ? "queued" : "uploaded";
      if (publication.queued) cloudComplete = false;
    } catch (error) {
      results.at(-1).cloud = "error";
      results.at(-1).error = error;
      cloudComplete = false;
    }
  }

  await putRecord(STORES.META, {
    key: LOCAL_BOOTSTRAP_KEY,
    version: UNIFIED_DECK_BOOTSTRAP_VERSION,
    completedAt: new Date().toISOString(),
    results: results.map(({ id, local, cloud }) => ({ id, local, cloud: cloud || null })),
  });

  if (cloudComplete) {
    await setCloudDeckBootstrapState(UNIFIED_DECK_BOOTSTRAP_VERSION, fetchImpl);
  }

  return {
    status: cloudComplete ? "complete" : "local-complete",
    cloudAvailable,
    results,
  };
}
