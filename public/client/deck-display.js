import { isStudyDeck } from "./multi-deck-practice.js";

export function userSelectableDecks(decks) {
  return (Array.isArray(decks) ? decks : []).filter(isStudyDeck);
}

export function resolveUserActiveDeck(decks, selectedBankId, preferredBankId = "ks-psychiatry-core") {
  const selectable = userSelectableDecks(decks);
  return selectable.find((deck) => deck.id === selectedBankId)
    || selectable.find((deck) => deck.id === preferredBankId)
    || selectable[0]
    || null;
}

export function practiceSetDeckTitles(decks, record) {
  const deckById = new Map(userSelectableDecks(decks).map((deck) => [deck.id, deck]));
  const requestedIds = Array.isArray(record?.selectedBankIds) && record.selectedBankIds.length
    ? record.selectedBankIds
    : record?.bankId
      ? [record.bankId]
      : [];

  return [...new Set(requestedIds.map(String))]
    .map((id) => deckById.get(id))
    .filter(Boolean)
    .map((deck) => deck.shortTitle || deck.title || deck.id);
}

export function practiceSetDeckLabel(decks, record) {
  const titles = practiceSetDeckTitles(decks, record);
  if (!titles.length) return "Deck unavailable";
  if (titles.length === 1) return titles[0];
  return titles.join(" + ");
}
