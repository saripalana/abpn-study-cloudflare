import {
  decodeQuestionRef,
  encodeQuestionRef,
  resolveQuestionRef,
  selectedStudyDecks,
} from "./multi-deck-practice.js";

export const MULTI_DECK_SET_SCOPE = "__multi-deck__";
export const MULTI_DECK_SET_SCHEMA_VERSION = 1;

export function isMultiDeckSet(record) {
  return Boolean(record)
    && (record.bankId === MULTI_DECK_SET_SCOPE || record.scope === "multi-deck");
}

export function createMultiDeckSetRecord({
  id,
  references,
  selectedBankIds,
  mode,
  timed,
  remainingSeconds,
  startedAt,
  updatedAt = startedAt,
  status = "active",
  index = 0,
  submitted = false,
  completedAt = null,
}) {
  const questionRefs = [...new Set((references || []).map(String))];
  if (!String(id || "").trim()) throw new Error("A combined practice set requires an ID.");
  if (!questionRefs.length) throw new Error("A combined practice set requires at least one question.");

  return {
    id: String(id),
    bankId: MULTI_DECK_SET_SCOPE,
    scope: "multi-deck",
    schemaVersion: MULTI_DECK_SET_SCHEMA_VERSION,
    selectedBankIds: [...new Set((selectedBankIds || []).map(String))],
    questionIds: questionRefs,
    index: Math.max(0, Math.min(Math.trunc(Number(index)) || 0, questionRefs.length - 1)),
    status,
    mode,
    timed: Boolean(timed),
    remainingSeconds: Math.max(0, Number(remainingSeconds) || 0),
    submitted: Boolean(submitted),
    startedAt,
    completedAt,
    updatedAt,
  };
}

export function normalizeStoredSet(record, decks) {
  if (!record || !Array.isArray(record.questionIds) || !record.questionIds.length) return null;

  if (!isMultiDeckSet(record)) {
    const deck = (decks || []).find((candidate) => candidate.id === record.bankId);
    if (!deck) return null;
    const references = record.questionIds.map((questionId) => encodeQuestionRef(record.bankId, questionId));
    if (references.some((reference) => !resolveQuestionRef(decks, reference))) return null;
    return {
      ...record,
      scope: "single-deck",
      selectedBankIds: [record.bankId],
      questionRefs: references,
    };
  }

  const references = record.questionIds.map(String);
  if (references.some((reference) => !resolveQuestionRef(decks, reference))) return null;

  const selectedBankIds = record.selectedBankIds?.length
    ? selectedStudyDecks(decks, record.selectedBankIds).map((deck) => deck.id)
    : [...new Set(references.map((reference) => decodeQuestionRef(reference).bankId))];

  return {
    ...record,
    bankId: MULTI_DECK_SET_SCOPE,
    scope: "multi-deck",
    schemaVersion: MULTI_DECK_SET_SCHEMA_VERSION,
    selectedBankIds,
    questionRefs: references,
  };
}

export function storedQuestionKey(set, referenceOrQuestionId) {
  if (isMultiDeckSet(set) || set?.scope === "multi-deck") return String(referenceOrQuestionId);
  const value = String(referenceOrQuestionId);
  try {
    const decoded = decodeQuestionRef(value);
    return decoded.questionId;
  } catch {
    return value;
  }
}

export function resolveSetQuestion(decks, set, index = set?.index || 0) {
  const references = set?.questionRefs
    || (isMultiDeckSet(set) ? set?.questionIds : set?.questionIds?.map((id) => encodeQuestionRef(set.bankId, id)));
  const reference = references?.[index];
  return reference ? resolveQuestionRef(decks, reference) : null;
}

export function progressTargetsForSet(decks, set) {
  const references = set?.questionRefs
    || (isMultiDeckSet(set) ? set?.questionIds : set?.questionIds?.map((id) => encodeQuestionRef(set.bankId, id)))
    || [];
  return references.map((reference) => resolveQuestionRef(decks, reference)).filter(Boolean);
}
