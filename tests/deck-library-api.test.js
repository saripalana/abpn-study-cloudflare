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

function fakeDb({ first = async () => null, all = async () => ({ results: [] }), onBatch = async () => {}, onRun = async () => ({ success: true }) } = {}) {
  return {
    prepare(query) {
      return {
        bind(...values) {
          return {
            query,
            values,
            first: () => first(query, values),
            all: () => all(query, values),
            run: () => onRun(query, values),
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

function putRequest(data = packageData()) {
  return new Request("https://study.example/api/decks/sample-deck", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-abpn-device-id": "device-test" },
    body: JSON.stringify(data),
  });
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
      first: async (query) => query.includes("COUNT(*)") ? { deck_count: 0 } : null,
      onBatch: async (batch) => statements.push(...batch),
    }),
  };
  const response = await handleDeckLibraryRequest(
    putRequest(),
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

test("treats an identical deck upload as idempotent", async () => {
  let batches = 0;
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("version, checksum")
        ? { chunk_count: 4, version: "1.0.0", checksum: "abc123" }
        : null,
      onBatch: async () => { batches += 1; },
    }),
  };
  const response = await handleDeckLibraryRequest(putRequest(), env, helpers());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).unchanged, true);
  assert.equal(batches, 0);
});

test("rejects changed deck content without a new version", async () => {
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("version, checksum")
        ? { chunk_count: 1, version: "1.0.0", checksum: "old-checksum" }
        : null,
    }),
  };
  const response = await handleDeckLibraryRequest(
    putRequest(packageData({ checksum: "new-checksum" })),
    env,
    helpers(),
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /new version/i);
});

test("enforces the maximum number of decks", async () => {
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("COUNT(*)") ? { deck_count: 50 } : null,
    }),
  };
  const response = await handleDeckLibraryRequest(putRequest(), env, helpers());
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /at most 50/i);
});

test("stores K&S through the same ordinary deck endpoint", async () => {
  const statements = [];
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("COUNT(*)") ? { deck_count: 0 } : null,
      onBatch: async (batch) => statements.push(...batch),
    }),
  };
  const data = packageData({
    id: "ks-psychiatry-core",
    title: "K&S Psychiatry Question Bank",
    shortTitle: "K&S Psychiatry",
    version: "4d03f158c6fbfacd698796d94c213a49ac8a377d",
  });
  const response = await handleDeckLibraryRequest(
    new Request("https://study.example/api/decks/ks-psychiatry-core", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-abpn-device-id": "device-test" },
      body: JSON.stringify(data),
    }),
    env,
    helpers(),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deck.id, "ks-psychiatry-core");
  assert.equal(statements.length, 3);
});

test("reads and writes the one-time deck bootstrap marker", async () => {
  const runs = [];
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("deck_library_state")
        ? { bootstrap_version: "unified-deck-library-v1", completed_at: "2026-07-22T00:00:00.000Z", updated_at: "2026-07-22T00:00:00.000Z" }
        : null,
      onRun: async (query, values) => {
        runs.push({ query, values });
        return { success: true };
      },
    }),
  };

  const getResponse = await handleDeckLibraryRequest(
    new Request("https://study.example/api/decks/bootstrap", {
      headers: { "x-abpn-device-id": "device-test" },
    }),
    env,
    helpers(),
  );
  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).version, "unified-deck-library-v1");

  const putResponse = await handleDeckLibraryRequest(
    new Request("https://study.example/api/decks/bootstrap", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-abpn-device-id": "device-test" },
      body: JSON.stringify({ version: "unified-deck-library-v1" }),
    }),
    env,
    helpers(),
  );
  assert.equal(putResponse.status, 200);
  assert.equal((await putResponse.json()).version, "unified-deck-library-v1");
  assert.equal(runs.length, 1);
  assert.match(runs[0].query, /INSERT INTO deck_library_state/);
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

test("explicitly deletes deck chunks and metadata", async () => {
  const statements = [];
  const env = {
    DB: fakeDb({
      first: async () => ({ chunk_count: 3 }),
      onBatch: async (batch) => statements.push(...batch),
    }),
  };
  const response = await handleDeckLibraryRequest(
    new Request("https://study.example/api/decks/sample-deck", {
      method: "DELETE",
      headers: { "x-abpn-device-id": "device-test" },
    }),
    env,
    helpers(),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  assert.equal(statements.length, 2);
  assert.match(statements[0].query, /deck_package_chunks/);
  assert.match(statements[1].query, /deck_packages/);
});

test("deck library limits remain bounded", () => {
  assert.equal(DECK_LIBRARY_LIMITS.maximumPackageBytes, 20 * 1024 * 1024);
  assert.equal(DECK_LIBRARY_LIMITS.maximumDecks, 50);
  assert.equal(DECK_LIBRARY_LIMITS.maximumChunks, 96);
});
