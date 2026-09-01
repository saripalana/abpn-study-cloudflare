import { studyDecks } from "./multi-deck-practice.js";

export const DECK_SCOPE_CURRENT = "current";
export const DECK_SCOPE_ALL = "all";
export const DECK_SCOPE_COACH = "coach";
export const DECK_SCOPE_CUSTOM = "custom";

const VALID_SCOPES = new Set([
  DECK_SCOPE_CURRENT,
  DECK_SCOPE_ALL,
  DECK_SCOPE_COACH,
  DECK_SCOPE_CUSTOM,
]);

export function normalStudyDecks(decks) {
  return studyDecks(decks);
}

export function coachStudyDecks(decks) {
  return normalStudyDecks(decks)
    .filter((deck) => deck?.contentClass === "assistant-supplemental");
}

function currentDeckForScope({ decks, activeBankId } = {}) {
  const allDecks = Array.isArray(decks) ? decks : [];
  const activeDeck = allDecks.find((deck) => deck?.id === String(activeBankId || ""));
  if (activeDeck) return activeDeck;
  return normalStudyDecks(allDecks)[0] || null;
}

export function normalizeDeckScopeSettings({
  decks,
  activeBankId,
  saved = {},
} = {}) {
  const available = normalStudyDecks(decks);
  const availableIds = new Set(available.map((deck) => deck.id));
  const coachAvailable = coachStudyDecks(decks);
  const activeId = currentDeckForScope({ decks, activeBankId })?.id || "";
  const savedScope = VALID_SCOPES.has(saved?.scope) ? saved.scope : DECK_SCOPE_CURRENT;
  const legacyCoachScope = savedScope === DECK_SCOPE_COACH;
  const requestedScope = legacyCoachScope ? DECK_SCOPE_CUSTOM : savedScope;
  const requestedIds = legacyCoachScope
    ? coachAvailable.map((deck) => deck.id)
    : Array.isArray(saved?.selectedBankIds)
    ? saved.selectedBankIds.map(String).filter((id) => availableIds.has(id))
    : [];
  const selectedBankIds = requestedScope === DECK_SCOPE_CURRENT
    ? (activeId ? [activeId] : [])
    : requestedScope === DECK_SCOPE_ALL
      ? available.map((deck) => deck.id)
      : requestedIds.length
        ? [...new Set(requestedIds)]
        : (activeId ? [activeId] : []);

  return {
    scope: requestedScope,
    selectedBankIds,
  };
}

export function selectedDecksForScope({ decks, activeBankId, settings } = {}) {
  const normalized = normalizeDeckScopeSettings({ decks, activeBankId, saved: settings });
  if (normalized.scope === DECK_SCOPE_CURRENT) {
    const activeDeck = currentDeckForScope({ decks, activeBankId });
    return activeDeck ? [activeDeck] : [];
  }
  const selected = new Set(normalized.selectedBankIds);
  return normalStudyDecks(decks).filter((deck) => selected.has(deck.id));
}

export function selectedDeckQuestionCount(options = {}) {
  return selectedDecksForScope(options)
    .reduce((total, deck) => total + Number(deck.questions?.length || 0), 0);
}

export function deckScopeSummary({ decks, activeBankId, settings } = {}) {
  const normalized = normalizeDeckScopeSettings({ decks, activeBankId, saved: settings });
  const selected = selectedDecksForScope({ decks, activeBankId, settings: normalized });
  const count = selectedDeckQuestionCount({ decks, activeBankId, settings: normalized });
  if (normalized.scope === DECK_SCOPE_CURRENT) {
    return `${selected[0]?.shortTitle || selected[0]?.title || "Current deck"} · ${count} questions`;
  }
  if (normalized.scope === DECK_SCOPE_ALL) {
    return `All ${selected.length} study decks · ${count} questions`;
  }
  return `${selected.length} selected deck${selected.length === 1 ? "" : "s"} · ${count} questions`;
}
