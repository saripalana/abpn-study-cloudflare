import { DECK_SCOPE_CURRENT, normalizeDeckScopeSettings, selectedDecksForScope } from "./multi-deck-builder.js";
import { createCombinedPracticeSet } from "./multi-deck-session.js";
import { currentSetQuestion } from "./multi-deck-runtime.js";

export function categoriesByDeckForSession(decks, activeBankId, selectedCategories, selectedSections = null) {
  const activeCategories = Array.isArray(selectedCategories) ? selectedCategories.map(String) : null;
  const activeSections = Array.isArray(selectedSections) ? selectedSections.map(String) : null;
  const activeFilters = activeSections == null
    ? activeCategories
    : { subjects: activeCategories, sections: activeSections };
  return new Map((decks || []).map((deck) => [
    deck.id,
    deck.id === activeBankId ? activeFilters : null,
  ]));
}

export async function loadProgressForSelectedDecks({ decks, activeBankId, settings, loadProgress }) {
  const normalized = normalizeDeckScopeSettings({ decks, activeBankId, saved: settings });
  const progressByBank = new Map();
  for (const bankId of normalized.selectedBankIds) {
    progressByBank.set(bankId, await loadProgress(bankId));
  }
  return { settings: normalized, progressByBank };
}

export async function createPracticeSession({
  decks,
  activeBank,
  settings,
  loadProgress,
  createSingleDeckSet,
  pool,
  categoriesByBank = new Map(),
  count,
  mode,
  timed,
  secondsPerQuestion,
  now,
  id,
  random,
  randomized = true,
  specialCriteria = null,
}) {
  const normalized = normalizeDeckScopeSettings({ decks, activeBankId: activeBank?.id, saved: settings });
  const selectedDecks = selectedDecksForScope({ decks, activeBankId: activeBank?.id, settings: normalized });
  if (normalized.scope === DECK_SCOPE_CURRENT || selectedDecks.length === 1) {
    // Current scope must preserve the actual active bank, including protected
    // validation banks that are intentionally excluded from the normal library.
    const selectedBank = normalized.scope === DECK_SCOPE_CURRENT
      ? activeBank
      : selectedDecks[0];
    return createSingleDeckSet({
      activeBank: selectedBank,
      pool,
      count,
      mode,
      timed,
      secondsPerQuestion,
      now,
      id,
      random,
      randomized,
      categories: categoriesByBank.get(selectedBank?.id) ?? null,
      specialCriteria,
    });
  }

  const { progressByBank } = await loadProgressForSelectedDecks({
    decks,
    activeBankId: activeBank?.id,
    settings: normalized,
    loadProgress,
  });

  return createCombinedPracticeSet({
    decks,
    activeBankId: activeBank?.id,
    settings: normalized,
    progressByBank,
    pool,
    categoriesByBank,
    count,
    mode,
    timed,
    secondsPerQuestion,
    now,
    id,
    random,
    randomized,
    specialCriteria,
  });
}

export function sessionQuestionContext(decks, set) {
  return currentSetQuestion(decks, set);
}

export function persistenceRecordForSession(set, updatedAt = new Date().toISOString()) {
  if (!set) return null;
  return {
    id: set.id,
    bankId: set.bankId,
    scope: set.scope,
    schemaVersion: set.schemaVersion,
    selectedBankIds: set.selectedBankIds,
    status: set.status || (set.submitted ? "completed" : "active"),
    mode: set.mode,
    timed: Boolean(set.timed),
    questionIds: [...(set.questionIds || [])],
    index: set.index || 0,
    remainingSeconds: Math.max(0, Number(set.remainingSeconds) || 0),
    submitted: Boolean(set.submitted),
    startedAt: set.startedAt,
    completedAt: set.completedAt ?? null,
    updatedAt,
    specialCriteria: set.specialCriteria ?? null,
    priorAttemptQuestionIds: [...(set.priorAttemptQuestionIds || [])],
  };
}
