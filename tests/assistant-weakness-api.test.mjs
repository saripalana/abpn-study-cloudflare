import test from "node:test";
import assert from "node:assert/strict";
import {
  handleAssistantWeaknessRequest,
  materializeGeneratedDecksInCloud,
  sanitizeStudyCoachDataset,
} from "../src/assistant-weakness-api.js";
import { createStudyCoachPackage } from "../src/client/study-coach-package.js";
import { QUESTION_BANK_PACKAGE_FORMAT, QUESTION_BANK_PACKAGE_SCHEMA_VERSION } from "../src/client/question-bank-import.js";

const valid = {
  schemaVersion: 2,
  consentVersion: 2,
  generatedAt: "2026-08-06T12:00:00.000Z",
  selectionPolicy: "attempted-flagged-annotated-priority",
  decks: [{ id: "ks", title: "K&S", version: "1", totalQuestions: 10, usedQuestions: 1, domains: [{
    title: "Mood", totalQuestions: 10, usedQuestions: 1, attempts: 1, accuracy: 0.5,
    averageTimeMs: 40000, evidence: "limited", priorityScore: 62, mastered: false,
  }] }],
  completedTests: [{ setId: "set-1", bankIds: ["ks"], mode: "test", timed: true,
    startedAt: "2026-08-06T11:00:00.000Z", completedAt: "2026-08-06T12:00:00.000Z",
    questionCount: 10, answered: 9, correct: 7, incorrect: 2, omitted: 1, totalTimeMs: 400000 }],
  coachingItems: [{
    bankId: "ks", questionId: "q1", subject: "Mood", testSection: "Test 1",
    prompt: "Example prompt", vignetteStem: "", choices: [{ letter: "A", text: "One" }, { letter: "B", text: "Two" }],
    selectedAnswer: "A", correctAnswer: ["B"], answerText: "B", explanation: "Example explanation", note: "Review",
    isCorrect: false, isFlagged: true, timesUsed: 1, totalTimeMs: 40000, lastUsedAt: "2026-08-06T11:00:00.000Z",
  }],
  totalEligibleCoachingItems: 1,
  truncated: false,
};

test("server rebuilds the Study Coach dataset from a strict allowlist", () => {
  const sanitized = sanitizeStudyCoachDataset({ ...valid, credential: "must disappear", browserHistory: ["must disappear"] });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /credential|browserHistory|must disappear/);
  assert.equal(sanitized.schemaVersion, 2);
  assert.deepEqual(sanitized.coachingItems[0].selectedAnswer, ["A"]);
});

test("server rejects stale consent, oversized arrays, and invalid ratios", () => {
  assert.throws(() => sanitizeStudyCoachDataset({ ...valid, consentVersion: 1 }), /schema/);
  assert.throws(() => sanitizeStudyCoachDataset({ ...valid, coachingItems: Array.from({ length: 201 }, () => valid.coachingItems[0]) }), /schema/);
  const invalid = structuredClone(valid);
  invalid.decks[0].domains[0].accuracy = 2;
  assert.throws(() => sanitizeStudyCoachDataset(invalid), /accuracy/);
});

test("Cloudflare exchange routes require fresh exchange consent and reserve usage first", async () => {
  const reservations = [];
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (/FROM assistant_weakness_permissions/.test(sql)) {
                return { enabled: 1, consent_version: 2, exchange_consent_version: 0 };
              }
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const handlerEnv = { APP_ENV: "staging", ASSISTANT_WEAKNESS_ENABLED: "true", DB: db };
  const response = await handleAssistantWeaknessRequest(
    new Request("https://study.example/api/assistant/study-coach/package", {
      method: "PUT",
      headers: { "x-abpn-device-id": "device-123" },
      body: "{}",
    }),
    handlerEnv,
    {
      json(data, status = 200, extraHeaders = {}) {
        return new Response(JSON.stringify(data), { status, headers: extraHeaders });
      },
      requireSyncReady() {},
      requireContext() { return { userId: "study-user", deviceId: "device-123" }; },
      async ensureUserAndDevice() {},
      async parseBoundedJson(request) { return request.json(); },
      async reserveUsage(reservationEnv, delta) { reservations.push({ reservationEnv, delta }); },
    },
  );
  assert.equal(response.status, 403);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].reservationEnv, handlerEnv);
  assert.equal(reservations[0].delta.writeActions, 1);
  assert.equal(reservations[0].delta.rowsWritten, 245);
});

test("a declared small Study Coach output reserves fewer rows without weakening the unknown-size fallback", async () => {
  const reservations = [];
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (/FROM assistant_weakness_permissions/.test(sql)) {
                return { enabled: 1, consent_version: 2, exchange_consent_version: 0 };
              }
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const response = await handleAssistantWeaknessRequest(
    new Request("https://study.example/api/assistant/study-coach/output", {
      method: "PUT",
      headers: {
        "content-length": "27766",
        "content-type": "application/json",
        "x-abpn-device-id": "device-123",
      },
      body: "{}",
    }),
    { APP_ENV: "staging", ASSISTANT_WEAKNESS_ENABLED: "true", DB: db },
    {
      json(data, status = 200) { return new Response(JSON.stringify(data), { status }); },
      requireSyncReady() {},
      requireContext() { return { userId: "study-user", deviceId: "device-123" }; },
      async ensureUserAndDevice() {},
      async parseBoundedJson(request) { return request.json(); },
      async reserveUsage(_env, delta) { reservations.push(delta); },
    },
  );
  assert.equal(response.status, 403);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].rowsWritten, 126);
});

test("Cloudflare output publishing rejects a generated deck copied from the current protected package", async () => {
  const sourceBank = {
    id: "protected-source",
    title: "Synthetic protected source",
    version: "1",
    sourceType: "application-seed",
    contentClass: "source-material",
    questions: [{
      id: "source-q1",
      subjectTitle: "Synthetic subject",
      chapterTitle: "Synthetic section",
      question: "Synthetic protected prompt",
      vignetteStem: "Synthetic protected stem",
      choices: ["Choice one", "Choice two"],
      choiceLetters: ["A", "B"],
      correctLetters: ["B"],
      answerText: "Choice two",
      explanation: "Synthetic protected explanation",
    }],
  };
  const sourcePackage = createStudyCoachPackage({
    banks: [sourceBank],
    progressRows: [],
    practiceSets: [],
    practiceSetAnswers: [],
    exportedAt: "2026-08-27T12:00:00.000Z",
  });
  const packageText = JSON.stringify(sourcePackage);
  const packageRow = {
    id: "package-1",
    artifact_type: "package",
    created_at: "2026-08-27T12:00:01.000Z",
    byte_count: packageText.length,
    chunk_count: 1,
    primary_timestamp: sourcePackage.exportedAt,
    metadata_json: JSON.stringify({ exportedAt: sourcePackage.exportedAt, bankCount: 1, questionCount: 1 }),
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (/FROM assistant_weakness_permissions/.test(sql)) {
                return { enabled: 1, consent_version: 2, exchange_consent_version: 1 };
              }
              if (/FROM assistant_study_coach_artifacts/.test(sql) && /artifact_type = \?/.test(sql)) return packageRow;
              return null;
            },
            async all() {
              if (/SELECT id, artifact_type/.test(sql)) return { results: [packageRow] };
              if (/FROM assistant_study_coach_artifact_chunks/.test(sql)) return { results: [{ chunk_text: packageText }] };
              return { results: [] };
            },
          };
        },
      };
    },
    async batch() { throw new Error("Unsafe output must be rejected before writes"); },
  };
  const copiedOutput = {
    format: "abpn-study-coach-output",
    schemaVersion: 2,
    generatedAt: "2026-08-27T12:05:00.000Z",
    summary: "Synthetic collision test.",
    focusAreas: [],
    recommendedSets: [],
    progressMetrics: [],
    studyActions: [],
    notes: [],
    generatedDecks: [{
      title: "Relabeled synthetic copy",
      package: {
        format: QUESTION_BANK_PACKAGE_FORMAT,
        schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
        bank: {
          ...sourceBank,
          id: "new-supplemental-id",
          title: "Relabeled synthetic copy",
          sourceType: "assistant-supplemental",
          contentClass: "assistant-supplemental",
          questions: [{ ...sourceBank.questions[0], id: "new-question-id" }],
        },
      },
    }],
  };
  const response = await handleAssistantWeaknessRequest(
    new Request("https://study.example/api/assistant/study-coach/output", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-abpn-device-id": "device-123" },
      body: JSON.stringify(copiedOutput),
    }),
    { APP_ENV: "staging", ASSISTANT_WEAKNESS_ENABLED: "true", DB: db },
    {
      json(data, status = 200) { return new Response(JSON.stringify(data), { status }); },
      requireSyncReady() {},
      requireContext() { return { userId: "study-user", deviceId: "device-123" }; },
      async ensureUserAndDevice() {},
      async parseBoundedJson(request) { return request.json(); },
      async reserveUsage() {},
    },
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot copy protected source question content/);
});

function generatedCoachOutput(generatedAt, bankId, questionId) {
  return {
    generatedAt,
    generatedDecks: [{
      bankId,
      package: {
        format: QUESTION_BANK_PACKAGE_FORMAT,
        schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
        bank: {
          questions: [{
            id: questionId,
            chapterTitle: "Synthetic source section",
            subjectTitle: "Synthetic subject",
            question: `Synthetic prompt for ${questionId}?`,
            choices: ["One", "Two"],
            choiceLetters: ["A", "B"],
            correctLetter: "A",
            explanation: "Synthetic explanation.",
          }],
        },
      },
    }],
  };
}

test("Cloudflare materializes successive coach outputs into one cumulative cloud bank", async () => {
  let cloudPackage = null;
  const expectedHeads = [];
  const expectedEmptyHeads = [];
  const deckHandler = async (request) => {
    if (request.method === "GET") {
      return cloudPackage
        ? new Response(JSON.stringify(cloudPackage), { status: 200 })
        : new Response(JSON.stringify({ error: "Deck not found" }), { status: 404 });
    }
    expectedHeads.push(request.headers.get("x-abpn-expected-head-checksum"));
    expectedEmptyHeads.push(request.headers.get("x-abpn-expect-no-head"));
    cloudPackage = JSON.parse(await request.text());
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const request = new Request("https://study.example/api/assistant/study-coach/output", {
    headers: { "x-abpn-device-id": "device-123" },
  });

  const first = await materializeGeneratedDecksInCloud(
    generatedCoachOutput("2026-09-01T12:00:00.000Z", "cycle-1", "coach-q1"),
    request,
    {},
    {},
    { deckHandler },
  );
  assert.equal(first.status, "published");
  assert.equal(first.bank.questions.length, 1);
  assert.equal(expectedHeads[0], null);
  assert.equal(expectedEmptyHeads[0], "true");

  const firstChecksum = cloudPackage.bank.checksum;
  const second = await materializeGeneratedDecksInCloud(
    generatedCoachOutput("2026-09-01T13:00:00.000Z", "cycle-2", "coach-q2"),
    request,
    {},
    {},
    { deckHandler },
  );
  assert.equal(second.status, "published");
  assert.equal(second.bank.questions.length, 2);
  assert.equal(expectedHeads[1], firstChecksum);
  assert.equal(expectedEmptyHeads[1], null);
  assert.deepEqual(cloudPackage.bank.questions.map((question) => question.id), ["coach-q1", "coach-q2"]);

  const repeated = await materializeGeneratedDecksInCloud(
    generatedCoachOutput("2026-09-01T13:00:00.000Z", "cycle-2", "coach-q2"),
    request,
    {},
    {},
    { deckHandler },
  );
  assert.equal(repeated.status, "unchanged");
  assert.equal(cloudPackage.bank.questions.length, 2);
  assert.equal(expectedHeads.length, 2);
});

test("Cloudflare materialization retries one stale-head conflict and then settles", async () => {
  let cloudPackage = null;
  let putAttempts = 0;
  const deckHandler = async (request) => {
    if (request.method === "GET") {
      return cloudPackage
        ? new Response(JSON.stringify(cloudPackage), { status: 200 })
        : new Response(JSON.stringify({ error: "Deck not found" }), { status: 404 });
    }
    putAttempts += 1;
    if (putAttempts === 1) {
      return new Response(JSON.stringify({ error: "Deck head changed" }), { status: 409 });
    }
    cloudPackage = JSON.parse(await request.text());
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const result = await materializeGeneratedDecksInCloud(
    generatedCoachOutput("2026-09-01T14:00:00.000Z", "cycle-retry", "coach-retry-q1"),
    new Request("https://study.example/api/assistant/study-coach/output", {
      headers: { "x-abpn-device-id": "device-123" },
    }),
    {},
    {},
    { deckHandler },
  );
  assert.equal(result.status, "published");
  assert.equal(putAttempts, 2);
  assert.equal(cloudPackage.bank.questions.length, 1);
});
