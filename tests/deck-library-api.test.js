import test from "node:test";
import assert from "node:assert/strict";
import { DECK_LIBRARY_LIMITS, handleDeckLibraryRequest } from "../src/deck-library-api.js";

const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json", ...extraHeaders },
});

function helpers(overrides = {}) {
  return {
    json,
    requireSyncReady: () => {},
    requireContext: (request) => {
      assert.equal(request.headers.get("x-abpn-device-id"), "device-test");
      return { userId: "user-test", deviceId: "device-test" };
    },
    reserveUsage: async () => {},
    ensureUserAndDevice: async () => {},
    ...overrides,
  };
}

function fakeDb({ first = async () => null, all = async () => ({ results: [] }), onBatch = async () => {} } = {}) {
  return {
    prepare(query) {
      return {
        bind(...values) {
          return {
            query,
            values,
            first: () => first(query, values),
            all: () => all(query, values),
            run: async () => ({ success: true }),
          };
        },
      };
    },
    batch: onBatch,
  };
}

function packageData(overrides = {}) {
  const bank = {
    id: "sample-deck",
    title: "Sample Deck",
    shortTitle: "Sample",
    description: "Persistent deck fixture",
    version: "1.0.0",
    sourceType: "user-imported",
    contentClass: "source-material",
    sourceLabel: "Unit test",
    protected: false,
    checksum: "abc123",
    questions: [{
      id: "sample-1",
      chapterTitle: "Deck Library",
      question: "Which answer is correct?",
      choices: ["No", "Yes"],
      choiceLetters: ["A", "B"],
      correctLetter: "B",
      explanation: "B is correct.",
    }],
    ...overrides,
  };
  return { format: "abpn-question-bank", schemaVersion: 1, checksum: bank.checksum, bank };
}

test("ignores non-deck API routes", async () => {
  const response = await handleDeckLibraryRequest(
    new Request("https://study.example/api/health"),
    {},
    {},
  );
  assert.equal(response, null);
});

test("stores a validated deck as bounded package chunks", async () => {
  const statements = [];
  const reservations = [];
  const env = {
    DB: fakeDb({
      onBatch: async (batch) => statements.push(...batch),
    }),
  };
  const response = await handleDeckLibraryRequest(
    new Request("https://study.example/api/decks/sample-deck", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-abpn-device-id": "device-test" },
      body: JSON.stringify(packageData()),
    }),
    env,
    helpers({ reserveUsage: async (_env, delta) => reservations.push(delta) }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.deck.id, "sample-deck");
  assert.equal(body.deck.questionCount, 1);
  assert.equal(body.deck.chunkCount, 1);
  assert.equal(statements.length, 3);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].writeActions, 1);
  assert.ok(reservations[0].rowsWritten >= 3);
});

test("rejects attempts to replace a protected built-in deck", async () => {
  const env = { DB: fakeDb() };
  await assert.rejects(
    handleDeckLibraryRequest(
      new Request("https://study.example/api/decks/sample-deck", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-abpn-device-id": "device-test" },
        body: JSON.stringify(packageData({ protected: true })),
      }),
      env,
      helpers(),
    ),
    /Protected built-in decks cannot be replaced/,
  );
});

test("reconstructs a stored deck package in chunk order", async () => {
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("SELECT chunk_count") ? { chunk_count: 2 } : null,
      all: async (query) => query.includes("deck_package_chunks")
        ? { results: [{ chunk_text: '{"hello":' }, { chunk_text: '"world"}' }] }
        : { results: [] },
    }),
  };
  const response = await handleDeckLibraryRequest(
    new Request("https://study.example/api/decks/sample-deck", {
      headers: { "x-abpn-device-id": "device-test" },
    }),
    env,
    helpers(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hello: "world" });
});

test("deck library limits remain bounded", () => {
  assert.equal(DECK_LIBRARY_LIMITS.maximumPackageBytes, 20 * 1024 * 1024);
  assert.equal(DECK_LIBRARY_LIMITS.maximumDecks, 50);
  assert.equal(DECK_LIBRARY_LIMITS.maximumChunks, 96);
});
