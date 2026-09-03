import { chooseMultiDeckQuestionRefs, decodeQuestionRef } from "./multi-deck-practice.js";
import { createMultiDeckSetRecord } from "./multi-deck-set.js";
import { selectedDecksForScope } from "./multi-deck-builder.js";
import { normalizeSecondsPerQuestion } from "./timing-settings.js";

export function selectedProgressByBank(selectedDecks, progressByBank = new Map()) {
  return new Map(selectedDecks.map((deck) => [deck.id, progressByBank.get(deck.id) || new Map()]));
}

export function createCombinedPracticeSet({
  decks,
  activeBankId,
  settings,
  progressByBank = new Map(),
  pool = "all",
  categoriesByBank = new Map(),
  count,
  mode,
  timed,
  secondsPerQuestion,
  now = new Date().toISOString(),
  id = crypto.randomUUID(),
  random = Math.random,
  randomized = true,
  specialCriteria = null,
} = {}) {
  const selectedDecks = selectedDecksForScope({ decks, activeBankId, settings });
  if (selectedDecks.length < 2) return null;

  const selectedBankIds = selectedDecks.map((deck) => deck.id);
  const references = chooseMultiDeckQuestionRefs({
    decks: selectedDecks,
    selectedBankIds,
    progressByBank: selectedProgressByBank(selectedDecks, progressByBank),
    pool,
    categoriesByBank,
    specialCriteria,
  }, count, random, randomized);

  if (!references.length) return null;

  return createMultiDeckSetRecord({
    id,
    references,
    selectedBankIds,
    mode,
    timed,
    remainingSeconds: timed ? Math.ceil(references.length * normalizeSecondsPerQuestion(secondsPerQuestion)) : 0,
    startedAt: now,
    updatedAt: now,
    specialCriteria,
    priorAttemptQuestionIds: references.filter((reference) => {
      const { bankId, questionId } = decodeQuestionRef(reference);
      return Number(progressByBank.get(bankId)?.get(questionId)?.timesUsed || 0) > 0;
    }),
  });
}
