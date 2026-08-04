import { DECK_SCOPE_CURRENT, normalizeDeckScopeSettings } from "./multi-deck-builder.js";
import { createCombinedPracticeSet } from "./multi-deck-session.js";
import { currentSetQuestion } from "./multi-deck-runtime.js";

export function categoriesByDeckForSession(decks, activeBankId, selectedCategories) {
  const activeCategories = Array.isArray(selectedCategories) ? selectedCategories.map(String) : null;
  return new Map((decks || []).map((deck) => [
    deck.id,
    deck.id === activeBankId ? activeCategories : null,
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
  now,
  id,
  random,
  randomized = true,
}) {
  const normalized = normalizeDeckScopeSettings({ decks, activeBankId: activeBank?.id, saved: settings });
  if (normalized.scope === DECK_SCOPE_CURRENT) {
    return createSingleDeckSet({ activeBank, pool, count, mode, timed, now, id, random, randomized });
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
    now,
    id,
    random,
    randomized,
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
  };
}
