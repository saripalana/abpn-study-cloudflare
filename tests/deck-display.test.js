import test from "node:test";
import assert from "node:assert/strict";

import {
  practiceSetDeckLabel,
  resolveUserActiveDeck,
  userSelectableDecks,
} from "../public/client/deck-display.js";

const decks = [
  { id: "ks-psychiatry-core", title: "K&S Psychiatry Question Bank", shortTitle: "K&S Psychiatry", questions: [{}] },
  { id: "validation-bank", title: "System Validation Question Bank", sourceType: "system-validation", contentClass: "system-validation", questions: [{}, {}, {}] },
  { id: "spiegel-test-prep", title: "Spiegel Test Prep Question Bank", shortTitle: "Spiegel Test Prep", questions: [{}] },
];

test("normal deck selector excludes system-validation content", () => {
  assert.deepEqual(userSelectableDecks(decks).map((deck) => deck.id), [
    "ks-psychiatry-core",
    "spiegel-test-prep",
  ]);
});

test("a previously selected validation deck falls back to a normal study deck", () => {
  assert.equal(resolveUserActiveDeck(decks, "validation-bank")?.id, "ks-psychiatry-core");
});

test("combined history labels preserve all source deck names", () => {
  assert.equal(practiceSetDeckLabel(decks, {
    bankId: "ks-psychiatry-core",
    selectedBankIds: ["ks-psychiatry-core", "spiegel-test-prep"],
  }), "K&S Psychiatry + Spiegel Test Prep");
});

test("single-deck history remains clearly labeled", () => {
  assert.equal(practiceSetDeckLabel(decks, { bankId: "spiegel-test-prep" }), "Spiegel Test Prep");
});
