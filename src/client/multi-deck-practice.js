import { eligibleQuestionGroups } from "./study-engine.js";

const REF_SEPARATOR = "::";

export function isStudyDeck(deck) {
  return Boolean(deck)
    && deck.contentClass !== "system-validation"
    && deck.sourceType !== "system-validation";
}

export function studyDecks(decks) {
  return (Array.isArray(decks) ? decks : []).filter(isStudyDeck);
}

export function encodeQuestionRef(bankId, questionId) {
  const bank = String(bankId || "").trim();
  const question = String(questionId || "").trim();
  if (!bank || !question) throw new Error("A question reference requires both a deck ID and question ID.");
  return `${encodeURIComponent(bank)}${REF_SEPARATOR}${encodeURIComponent(question)}`;
}

export function decodeQuestionRef(reference) {
  const value = String(reference || "");
  const index = value.indexOf(REF_SEPARATOR);
  if (index <= 0 || index >= value.length - REF_SEPARATOR.length) {
    throw new Error("The saved multi-deck question reference is invalid.");
  }
  return {
    bankId: decodeURIComponent(value.slice(0, index)),
    questionId: decodeURIComponent(value.slice(index + REF_SEPARATOR.length)),
  };
}

export function selectedStudyDecks(decks, selectedBankIds = null) {
  const available = studyDecks(decks);
  if (selectedBankIds == null) return available;
  const selected = new Set((Array.isArray(selectedBankIds) ? selectedBankIds : []).map(String));
  return available.filter((deck) => selected.has(deck.id));
}

export function multiDeckQuestionRefs({
  decks,
  selectedBankIds = null,
  progressByBank = new Map(),
  pool = "all",
  categoriesByBank = new Map(),
  specialCriteria = null,
}) {
  return multiDeckQuestionRefGroups({
    decks, selectedBankIds, progressByBank, pool, categoriesByBank, specialCriteria,
  }).flat();
}

export function multiDeckQuestionRefGroups({
  decks,
  selectedBankIds = null,
  progressByBank = new Map(),
  pool = "all",
  categoriesByBank = new Map(),
  specialCriteria = null,
}) {
  const groups = [];
  for (const deck of selectedStudyDecks(decks, selectedBankIds)) {
    const progress = progressByBank.get(deck.id) || new Map();
    const categories = categoriesByBank.get(deck.id) ?? null;
    for (const questionIds of eligibleQuestionGroups(deck, progress, pool, categories, specialCriteria)) {
      groups.push(questionIds.map((questionId) => encodeQuestionRef(deck.id, questionId)));
    }
  }
  return groups;
}

export function chooseMultiDeckQuestionRefs(options, requestedCount, random = Math.random, randomized = true) {
  const groups = multiDeckQuestionRefGroups(options);
  const count = Math.max(0, Math.trunc(Number(requestedCount)) || 0);
  if (!count) return [];
  const flaggedRefs = new Set();
  if (options.specialCriteria?.includeFlagged) {
    for (const deck of selectedStudyDecks(options.decks, options.selectedBankIds)) {
      const progress = options.progressByBank?.get(deck.id) || new Map();
      for (const [questionId, record] of progress) {
        if (record?.isFlagged) flaggedRefs.add(encodeQuestionRef(deck.id, questionId));
      }
    }
  }
  const requiredGroups = groups.filter((group) => group.some((reference) => flaggedRefs.has(reference)));
  const requiredKeys = new Set(requiredGroups.map((group) => group.join("\u0000")));
  const optionalGroups = groups.filter((group) => !requiredKeys.has(group.join("\u0000")));
  const order = (items) => {
    const ordered = [...items];
    if (randomized) {
      for (let index = ordered.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
      }
    }
    return ordered;
  };
  const selected = [];
  for (const group of order(requiredGroups)) selected.push(...group);
  for (const group of order(optionalGroups)) {
    if (selected.length >= count) break;
    selected.push(...group);
  }
  return selected;
}

export function resolveQuestionRef(decks, reference) {
  const { bankId, questionId } = decodeQuestionRef(reference);
  const deck = (Array.isArray(decks) ? decks : []).find((candidate) => candidate.id === bankId);
  const question = deck?.byId?.get(questionId)
    || deck?.questions?.find((candidate) => candidate.id === questionId);
  if (!deck || !question) return null;
  return { bankId, questionId, deck, question };
}

export function multiDeckSetLabel(decks, references) {
  const deckIds = new Set();
  for (const reference of references || []) {
    try {
      deckIds.add(decodeQuestionRef(reference).bankId);
    } catch {
      // Invalid references are rejected by hydration; omit them from display labels.
    }
  }
  const titles = studyDecks(decks)
    .filter((deck) => deckIds.has(deck.id))
    .map((deck) => deck.shortTitle || deck.title);
  if (!titles.length) return "Selected decks";
  if (titles.length === 1) return titles[0];
  return `${titles.length} decks`;
}
