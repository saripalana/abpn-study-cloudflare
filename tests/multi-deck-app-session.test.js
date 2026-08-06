import test from "node:test";
import assert from "node:assert/strict";
import {
  categoriesByDeckForSession,
  createPracticeSession,
  loadProgressForSelectedDecks,
  persistenceRecordForSession,
  sessionQuestionContext,
} from "../public/client/multi-deck-app-session.js";

function deck(id, title, questionIds) {
  const questions = questionIds.map((questionId) => ({ id: questionId, question: `${title} ${questionId}` }));
  return { id, title, shortTitle: title, questions, byId: new Map(questions.map((question) => [question.id, question])) };
}

const alpha = deck("alpha", "Alpha", ["shared", "a2"]);
const beta = deck("beta", "Beta", ["shared", "b2"]);
const validation = { ...deck("validation", "Validation", ["v1"]), sourceType: "system-validation", contentClass: "system-validation" };
const decks = [alpha, beta, validation];

test("applies selected subjects only to the active deck in a combined set", () => {
  const categories = categoriesByDeckForSession(decks, alpha.id, ["Alpha subject"]);
  assert.deepEqual(categories.get("alpha"), ["Alpha subject"]);
  assert.equal(categories.get("beta"), null);
  assert.equal(categories.get("validation"), null);
});

test("loads progress only for selected study decks", async () => {
  const calls = [];
  const result = await loadProgressForSelectedDecks({
    decks,
    activeBankId: alpha.id,
    settings: { scope: "all" },
    loadProgress: async (bankId) => {
      calls.push(bankId);
      return new Map([["shared", { attempts: 1 }]]);
    },
  });
  assert.deepEqual(calls, ["alpha", "beta"]);
  assert.deepEqual(result.settings.selectedBankIds, ["alpha", "beta"]);
});

test("preserves the current-deck creation path", async () => {
  let called = false;
  const set = await createPracticeSession({
    decks,
    activeBank: alpha,
    settings: { scope: "current" },
    loadProgress: async () => new Map(),
    createSingleDeckSet: ({ activeBank }) => {
      called = true;
      return { id: "single", bankId: activeBank.id, questionIds: ["shared"] };
    },
    pool: "all",
    count: 1,
    mode: "tutor",
    timed: false,
  });
  assert.equal(called, true);
  assert.equal(set.bankId, "alpha");
});

test("preserves a protected validation bank in current-deck mode", async () => {
  const set = await createPracticeSession({
    decks,
    activeBank: validation,
    settings: { scope: "current" },
    loadProgress: async () => new Map(),
    createSingleDeckSet: ({ activeBank }) => ({
      id: "validation-single",
      bankId: activeBank.id,
      questionIds: ["v1"],
    }),
    pool: "all",
    count: 1,
    mode: "test",
    timed: false,
  });
  assert.equal(set.bankId, "validation");
});

test("creates a single-deck session when specific-deck mode selects one deck", async () => {
  const set = await createPracticeSession({
    decks,
    activeBank: alpha,
    settings: { scope: "custom", selectedBankIds: [alpha.id] },
    loadProgress: async () => new Map(),
    createSingleDeckSet: ({ activeBank, categories }) => ({
      id: "specific-single",
      bankId: activeBank.id,
      questionIds: ["a2"],
      categories,
    }),
    categoriesByBank: categoriesByDeckForSession(decks, alpha.id, ["Alpha subject"]),
    pool: "new",
    count: 1,
    mode: "test",
    timed: true,
  });
  assert.equal(set.bankId, "alpha");
  assert.deepEqual(set.categories, ["Alpha subject"]);
});

test("creates collision-safe combined sessions", async () => {
  const set = await createPracticeSession({
    decks,
    activeBank: alpha,
    settings: { scope: "all" },
    loadProgress: async () => new Map(),
    createSingleDeckSet: () => assert.fail("single-deck path should not be used"),
    pool: "all",
    count: 4,
    mode: "test",
    timed: true,
    now: "2026-07-24T12:00:00.000Z",
    id: "combined",
    random: () => 0,
  });
  assert.equal(set.bankId, "__multi-deck__");
  assert.deepEqual(set.selectedBankIds, ["alpha", "beta"]);
  assert.equal(set.questionIds.length, 4);
  assert.equal(new Set(set.questionIds).size, 4);
  assert.ok(set.questionIds.some((value) => value === "alpha::shared"));
  assert.ok(set.questionIds.some((value) => value === "beta::shared"));
});

test("resolves display and progress context from the source deck", () => {
  const set = {
    bankId: "__multi-deck__",
    scope: "multi-deck",
    questionIds: ["beta::shared"],
    index: 0,
  };
  const context = sessionQuestionContext(decks, set);
  assert.equal(context.displayDeckTitle, "Beta");
  assert.equal(context.answerKey, "beta::shared");
  assert.equal(context.progressBankId, "beta");
  assert.equal(context.progressQuestionId, "shared");
});

test("persists multi-deck metadata without changing legacy fields", () => {
  const record = persistenceRecordForSession({
    id: "combined",
    bankId: "__multi-deck__",
    scope: "multi-deck",
    schemaVersion: 1,
    selectedBankIds: ["alpha", "beta"],
    questionIds: ["alpha::shared", "beta::shared"],
    index: 1,
    mode: "test",
    timed: false,
    remainingSeconds: 0,
    submitted: false,
    startedAt: "2026-07-24T12:00:00.000Z",
  }, "2026-07-24T12:05:00.000Z");
  assert.equal(record.bankId, "__multi-deck__");
  assert.deepEqual(record.selectedBankIds, ["alpha", "beta"]);
  assert.deepEqual(record.questionIds, ["alpha::shared", "beta::shared"]);
  assert.equal(record.updatedAt, "2026-07-24T12:05:00.000Z");
});
