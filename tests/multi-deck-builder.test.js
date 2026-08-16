import assert from "node:assert/strict";
import test from "node:test";

import {
  DECK_SCOPE_ALL,
  DECK_SCOPE_CURRENT,
  DECK_SCOPE_CUSTOM,
  deckScopeSummary,
  normalizeDeckScopeSettings,
  selectedDeckQuestionCount,
  selectedDecksForScope,
} from "../public/client/multi-deck-builder.js";

const decks = [
  { id: "ks", title: "K&S", shortTitle: "K&S", sourceType: "repository-protected", contentClass: "source-material", questions: [{ id: "1" }, { id: "2" }] },
  { id: "spiegel", title: "Spiegel", shortTitle: "Spiegel", sourceType: "github", contentClass: "source-material", questions: [{ id: "1" }, { id: "2" }, { id: "3" }] },
  { id: "validation", title: "Validation", sourceType: "system-validation", contentClass: "system-validation", questions: [{ id: "v1" }] },
];

test("current scope resolves the active study deck", () => {
  const settings = normalizeDeckScopeSettings({ decks, activeBankId: "spiegel", saved: { scope: DECK_SCOPE_CURRENT } });
  assert.deepEqual(settings, { scope: DECK_SCOPE_CURRENT, selectedBankIds: ["spiegel"] });
});

test("current scope preserves a protected validation deck", () => {
  const settings = normalizeDeckScopeSettings({ decks, activeBankId: "validation", saved: { scope: DECK_SCOPE_CURRENT } });
  assert.deepEqual(settings, { scope: DECK_SCOPE_CURRENT, selectedBankIds: ["validation"] });
  assert.deepEqual(selectedDecksForScope({ decks, activeBankId: "validation", settings }).map((deck) => deck.id), ["validation"]);
  assert.equal(selectedDeckQuestionCount({ decks, activeBankId: "validation", settings }), 1);
  assert.equal(
    deckScopeSummary({ decks, activeBankId: "validation", settings }),
    "Validation · 1 questions",
  );
});

test("all scope includes every normal study deck and excludes validation", () => {
  const settings = normalizeDeckScopeSettings({ decks, activeBankId: "ks", saved: { scope: DECK_SCOPE_ALL } });
  assert.deepEqual(settings.selectedBankIds, ["ks", "spiegel"]);
  assert.equal(selectedDeckQuestionCount({ decks, activeBankId: "ks", settings }), 5);
});

test("custom scope keeps valid unique selections only", () => {
  const settings = normalizeDeckScopeSettings({
    decks,
    activeBankId: "ks",
    saved: { scope: DECK_SCOPE_CUSTOM, selectedBankIds: ["spiegel", "validation", "spiegel"] },
  });
  assert.deepEqual(settings.selectedBankIds, ["spiegel"]);
  assert.deepEqual(selectedDecksForScope({ decks, activeBankId: "ks", settings }).map((deck) => deck.id), ["spiegel"]);
});

test("empty custom selection safely falls back to the active deck", () => {
  const settings = normalizeDeckScopeSettings({ decks, activeBankId: "ks", saved: { scope: DECK_SCOPE_CUSTOM, selectedBankIds: [] } });
  assert.deepEqual(settings.selectedBankIds, ["ks"]);
});

test("scope summaries disclose selected deck and question totals", () => {
  assert.equal(
    deckScopeSummary({ decks, activeBankId: "ks", settings: { scope: DECK_SCOPE_ALL } }),
    "All 2 study decks · 5 questions",
  );
  assert.equal(
    deckScopeSummary({ decks, activeBankId: "ks", settings: { scope: DECK_SCOPE_CUSTOM, selectedBankIds: ["spiegel"] } }),
    "1 selected deck · 3 questions",
  );
});
