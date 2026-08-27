import test from "node:test";
import assert from "node:assert/strict";

import {
  multiDeckSelectorMarkup,
  readMultiDeckSelector,
} from "../public/client/multi-deck-builder-ui.js";

const decks = [
  { id: "ks", title: "K&S Psychiatry Question Bank", shortTitle: "K&S", sourceType: "repository-protected", contentClass: "source-material", questions: Array.from({ length: 602 }) },
  { id: "spiegel", title: "Spiegel Test Prep Question Bank", shortTitle: "Spiegel", sourceType: "github-import", contentClass: "source-material", questions: Array.from({ length: 1060 }) },
  { id: "coach-psych", title: "Coach Deck: Psychopharmacology Recovery", shortTitle: "Coach Psych", sourceType: "assistant-supplemental", contentClass: "assistant-supplemental", questions: Array.from({ length: 20 }) },
  { id: "validation", title: "System Validation Question Bank", sourceType: "system-validation", contentClass: "system-validation", questions: Array.from({ length: 3 }) },
];

test("selector offers current, all, and specific-deck modes", () => {
  const markup = multiDeckSelectorMarkup({ decks, activeBankId: "ks", settings: { scope: "all" } });
  assert.match(markup, />Current deck</);
  assert.match(markup, />All study decks</);
  assert.match(markup, />Coach decks</);
  assert.match(markup, />Choose specific decks</);
  assert.match(markup, /All 3 study decks · 1682 questions/);
});

test("selector lists normal study decks but hides validation content", () => {
  const markup = multiDeckSelectorMarkup({ decks, activeBankId: "ks", settings: { scope: "custom", selectedBankIds: ["ks"] } });
  assert.match(markup, /K&amp;S Psychiatry Question Bank/);
  assert.match(markup, /Spiegel Test Prep Question Bank/);
  assert.match(markup, /Coach Deck: Psychopharmacology Recovery/);
  assert.doesNotMatch(markup, /System Validation Question Bank/);
  assert.doesNotMatch(markup, /value="validation"/);
});

test("custom selection is normalized from checked deck controls", () => {
  const root = {
    querySelector(selector) {
      if (selector === "#deckScopeSelect") return { value: "custom" };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[name="practiceDeckFilter"]:checked') {
        return [{ value: "spiegel" }];
      }
      return [];
    },
  };
  assert.deepEqual(readMultiDeckSelector(root, { decks, activeBankId: "ks" }), {
    scope: "custom",
    selectedBankIds: ["spiegel"],
  });
});

test("empty custom selection safely falls back to the active study deck", () => {
  const root = {
    querySelector() { return { value: "custom" }; },
    querySelectorAll() { return []; },
  };
  assert.deepEqual(readMultiDeckSelector(root, { decks, activeBankId: "ks" }), {
    scope: "custom",
    selectedBankIds: ["ks"],
  });
});
