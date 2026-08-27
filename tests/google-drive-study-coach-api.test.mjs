import test from "node:test";
import assert from "node:assert/strict";

import { handleGoogleDriveStudyCoachRequest } from "../src/google-drive-study-coach-api.js";
import { createStudyCoachPackage } from "../src/client/study-coach-package.js";
import { QUESTION_BANK_PACKAGE_FORMAT, QUESTION_BANK_PACKAGE_SCHEMA_VERSION } from "../src/client/question-bank-import.js";

function permissionDb() {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (/SELECT enabled, consent_version, exchange_consent_version/.test(sql)) {
                return { enabled: 1, consent_version: 2, exchange_consent_version: 1 };
              }
              return null;
            },
            sql,
            values,
          };
        },
      };
    },
    async batch() {},
  };
}

const env = {
  GOOGLE_DRIVE_CLIENT_ID: "client-id",
  GOOGLE_DRIVE_CLIENT_SECRET: "client-secret",
  GOOGLE_DRIVE_REFRESH_TOKEN: "refresh-token",
  GOOGLE_DRIVE_RECOVERY_FOLDER_ID: "folder-123",
  DB: permissionDb(),
};

const helpers = {
  json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...extraHeaders,
      },
    });
  },
  requireSyncReady() {},
  requireContext() {
    return { userId: "study-user", deviceId: "device-123" };
  },
  async ensureUserAndDevice() {},
  async reserveUsage() {},
};

test("Study Coach Google Drive exchange requires fresh exchange consent before any Drive request", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("Drive must not be called without consent");
  };
  try {
    const response = await handleGoogleDriveStudyCoachRequest(
      new Request("https://study.example/api/study-coach/google-drive"),
      {
        ...env,
        DB: {
          prepare() {
            return { bind: () => ({ first: async () => ({ enabled: 1, consent_version: 2, exchange_consent_version: 0 }) }) };
          },
        },
      },
      helpers,
    );
    assert.equal(response.status, 403);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Study Coach Google Drive output upload writes the output exchange metadata", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")) {
      return new Response(JSON.stringify({
        id: "drive-file-1",
        name: "abpn-study-coach-output-2026-08-21T13-30-00-000Z.json",
        createdTime: "2026-08-21T13:31:00.000Z",
        size: "1024",
        appProperties: {
          abpnStudyCoach: "output",
          generatedAt: "2026-08-21T13:30:00.000Z",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const payload = {
      format: "abpn-study-coach-output",
      schemaVersion: 1,
      generatedAt: "2026-08-21T13:30:00.000Z",
      sourcePackageGeneratedAt: "2026-08-21T13:25:00.000Z",
      summary: "Prioritize anxiety and psychopharmacology first.",
      focusAreas: [{
        title: "Anxiety Disorders",
        rationale: "Low accuracy with meaningful usage.",
        recommendedQuestionCount: 15,
        questionRefs: [{ bankId: "ks-core", questionId: "q-1" }],
      }],
      recommendedSets: [{
        title: "15-question anxiety rebuild",
        objective: "Retest recent misses.",
        mode: "test",
        timed: true,
        questionCount: 15,
        questionRefs: [{ bankId: "ks-core", questionId: "q-1" }],
        instructions: "Keep the style ABPN-like.",
      }],
      progressMetrics: [{ label: "Top priority", value: "Anxiety Disorders", detail: "15-question rebuild" }],
      studyActions: ["Run the anxiety rebuild set next."],
      notes: ["Refresh after the next timed block."],
    };

    const response = await handleGoogleDriveStudyCoachRequest(
      new Request("https://study.example/api/study-coach/google-drive/output", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-abpn-device-id": "device-123" },
        body: JSON.stringify(payload),
      }),
      env,
      helpers,
    );

    assert.ok(response);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.file.generatedAt, payload.generatedAt);
    assert.equal(body.file.sourcePackageGeneratedAt, payload.sourcePackageGeneratedAt);
    assert.equal(body.file.format, payload.format);
    assert.equal(body.file.schemaVersion, 2);

    const uploadCall = calls.find((call) => call.url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"));
    assert.ok(uploadCall);
    const uploadBody = String(uploadCall.init.body);
    assert.match(uploadBody, /"abpnStudyCoach":"output"/);
    assert.match(uploadBody, /"generatedAt":"2026-08-21T13:30:00.000Z"/);
    assert.match(uploadBody, /"sourcePackageGeneratedAt":"2026-08-21T13:25:00.000Z"/);
    assert.match(uploadBody, /"schemaVersion":"2"/);
    assert.match(uploadBody, /"format":"abpn-study-coach-output"/);
    assert.match(uploadBody, /abpn-study-coach-output-2026-08-21T13-30-00-000Z\.json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Study Coach Google Drive output upload rejects invalid output payloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const response = await handleGoogleDriveStudyCoachRequest(
      new Request("https://study.example/api/study-coach/google-drive/output", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-abpn-device-id": "device-123" },
        body: JSON.stringify({ format: "abpn-study-coach-output", schemaVersion: 1 }),
      }),
      env,
      helpers,
    );

    assert.ok(response);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /invalid/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Study Coach Google Drive output rejects copied protected content before upload", async () => {
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
  const originalFetch = globalThis.fetch;
  let uploadAttempted = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 });
    }
    if (url.includes("/drive/v3/files?") && url.includes("abpnStudyCoach")) {
      return new Response(JSON.stringify({ files: [{
        id: "package-file-1",
        name: "synthetic-package.json",
        createdTime: "2026-08-27T12:00:01.000Z",
        size: String(JSON.stringify(sourcePackage).length),
        appProperties: { abpnStudyCoach: "package" },
      }] }), { status: 200 });
    }
    if (url.includes("/drive/v3/files/package-file-1?alt=media")) {
      return new Response(JSON.stringify(sourcePackage), { status: 200 });
    }
    if (url.includes("/upload/drive/v3/files")) {
      uploadAttempted = true;
      throw new Error("Unsafe output must be rejected before upload");
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const response = await handleGoogleDriveStudyCoachRequest(
      new Request("https://study.example/api/study-coach/google-drive/output", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-abpn-device-id": "device-123" },
        body: JSON.stringify(copiedOutput),
      }),
      env,
      helpers,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /cannot copy protected source question content/);
    assert.equal(uploadAttempted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
