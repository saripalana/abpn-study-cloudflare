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

function revisionRow(overrides = {}) {
  return {
    user_id: "user-test",
    deck_id: "sample-deck",
    checksum: "abc123",
    version: "1.0.0",
    title: "Sample Deck",
    short_title: "Sample",
    description: "Persistent deck fixture",
    source_type: "user-imported",
    content_class: "source-material",
    source_label: "Unit test",
    question_count: 1,
    package_bytes: 400,
    chunk_count: 1,
    imported_at: "2026-07-22T12:00:00.000Z",
    created_at: "2026-07-22T12:00:00.000Z",
    head_updated_at: "2026-07-22T12:00:00.000Z",
    ...overrides,
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
    importedAt: "2026-07-22T12:00:00.000Z",
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

function request(path = "/api/decks/sample-deck", options = {}) {
  return new Request(`https://study.example${path}`, {
    headers: { "content-type": "application/json", "x-abpn-device-id": "device-test", ...(options.headers || {}) },
    ...options,
  });
}

function putRequest(data = packageData()) {
  return request("/api/decks/sample-deck", {
    method: "PUT",
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

test("stores a validated deck as an immutable revision and active head", async () => {
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
  assert.equal(body.revisionCreated, true);
  assert.equal(body.deck.id, "sample-deck");
  assert.equal(body.deck.questionCount, 1);
  assert.equal(body.deck.chunkCount, 1);
  assert.equal(statements.length, 6);
  assert.match(statements[0].query, /deck_package_revisions/);
  assert.match(statements[1].query, /deck_package_revision_chunks/);
  assert.match(statements[2].query, /deck_package_heads/);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].writeActions, 1);
});

test("treats an identical active revision upload as idempotent", async () => {
  let batches = 0;
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("FROM deck_package_heads AS h") ? revisionRow() : null,
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
      first: async (query) => query.includes("FROM deck_package_heads AS h")
        ? revisionRow({ checksum: "old-checksum" })
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

test("enforces the maximum number of user-added decks", async () => {
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("COUNT(*)") ? { deck_count: 50 } : null,
    }),
  };
  const response = await handleDeckLibraryRequest(putRequest(), env, helpers());
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /at most 50/i);
});

test("rejects attempts to replace a protected built-in deck", async () => {
  const env = { DB: fakeDb() };
  await assert.rejects(
    handleDeckLibraryRequest(
      putRequest(packageData({ protected: true })),
      env,
      helpers(),
    ),
    /Protected built-in decks cannot be replaced/,
  );
});

test("reconstructs the active revision in chunk order", async () => {
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("FROM deck_package_heads AS h")
        ? revisionRow({ chunk_count: 2 })
        : null,
      all: async (query) => query.includes("deck_package_revision_chunks")
        ? { results: [{ chunk_text: '{"hello":' }, { chunk_text: '"world"}' }] }
        : { results: [] },
    }),
  };
  const response = await handleDeckLibraryRequest(
    request("/api/decks/sample-deck"),
    env,
    helpers(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hello: "world" });
});

test("fails closed when an immutable revision is missing chunks", async () => {
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("FROM deck_package_heads AS h")
        ? revisionRow({ chunk_count: 2 })
        : null,
      all: async () => ({ results: [{ chunk_text: "{}" }] }),
    }),
  };
  const response = await handleDeckLibraryRequest(request("/api/decks/sample-deck"), env, helpers());
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /incomplete/i);
});

test("lists immutable revisions and identifies the active checksum", async () => {
  const current = revisionRow();
  const older = revisionRow({
    checksum: "older123",
    version: "0.9.0",
    created_at: "2026-07-20T12:00:00.000Z",
  });
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("SELECT checksum FROM deck_package_heads")
        ? { checksum: "abc123" }
        : null,
      all: async (query) => query.includes("FROM deck_package_revisions")
        ? { results: [current, older] }
        : { results: [] },
    }),
  };
  const response = await handleDeckLibraryRequest(
    request("/api/decks/sample-deck/revisions"),
    env,
    helpers(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activeChecksum, "abc123");
  assert.equal(body.revisions.length, 2);
  assert.equal(body.revisions[0].active, true);
  assert.equal(body.revisions[1].active, false);
});

test("downloads a specifically selected immutable revision", async () => {
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("FROM deck_package_revisions")
        ? revisionRow({ checksum: "older123" })
        : null,
      all: async () => ({ results: [{ chunk_text: '{"revision":"older"}' }] }),
    }),
  };
  const response = await handleDeckLibraryRequest(
    request("/api/decks/sample-deck/revisions/older123"),
    env,
    helpers(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: "older" });
});

test("restores a prior revision by moving only the active head", async () => {
  const statements = [];
  const reservations = [];
  const env = {
    DB: fakeDb({
      first: async (query) => query.includes("FROM deck_package_revisions")
        ? revisionRow({ checksum: "older123", version: "0.9.0", chunk_count: 2 })
        : null,
      onBatch: async (batch) => statements.push(...batch),
    }),
  };
  const response = await handleDeckLibraryRequest(
    request("/api/decks/sample-deck/restore", {
      method: "POST",
      body: JSON.stringify({ checksum: "older123" }),
    }),
    env,
    helpers({ reserveUsage: async (_env, delta) => reservations.push(delta) }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.restored, true);
  assert.equal(body.checksum, "older123");
  assert.equal(statements.length, 4);
  assert.match(statements[0].query, /deck_package_heads/);
  assert.match(statements[2].query, /deck_package_revision_chunks/);
  assert.equal(reservations[0].writeActions, 1);
});

test("explicit deck deletion removes the head, all revisions, and compatibility rows", async () => {
  const statements = [];
  const env = {
    DB: fakeDb({
      first: async (query) => {
        if (query.includes("FROM deck_package_heads AS h")) return revisionRow({ chunk_count: 2 });
        if (query.includes("SUM(chunk_count)")) return { revision_count: 3, chunk_count: 7 };
        return null;
      },
      onBatch: async (batch) => statements.push(...batch),
    }),
  };
  const response = await handleDeckLibraryRequest(
    request("/api/decks/sample-deck", { method: "DELETE" }),
    env,
    helpers(),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  assert.equal(statements.length, 4);
  assert.match(statements[0].query, /deck_package_heads/);
  assert.match(statements[1].query, /deck_package_revisions/);
  assert.match(statements[2].query, /deck_package_chunks/);
  assert.match(statements[3].query, /deck_packages/);
});

test("deck library limits remain bounded", () => {
  assert.equal(DECK_LIBRARY_LIMITS.maximumPackageBytes, 20 * 1024 * 1024);
  assert.equal(DECK_LIBRARY_LIMITS.maximumDecks, 50);
  assert.equal(DECK_LIBRARY_LIMITS.maximumChunks, 96);
  assert.equal(DECK_LIBRARY_LIMITS.maximumRevisionsPerDeck, 100);
});
