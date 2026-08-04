import { isStudyDeck } from "./multi-deck-practice.js";

export function isUserSelectableDeck(deck) {
  return isStudyDeck(deck);
}

export function userSelectableDecks(decks) {
  return (Array.isArray(decks) ? decks : []).filter(isUserSelectableDeck);
}

export function deckOptionHiddenAttribute(deck) {
  return isUserSelectableDeck(deck) ? "" : " hidden";
}

export function resolveUserActiveDeck(
  decks,
  selectedBankId,
  preferredBankId = "ks-psychiatry-core",
  allowSystemValidation = false,
) {
  const allDecks = Array.isArray(decks) ? decks : [];
  if (allowSystemValidation) {
    const selected = allDecks.find((deck) => deck.id === selectedBankId);
    if (selected) return selected;
  }

  const selectable = userSelectableDecks(allDecks);
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
