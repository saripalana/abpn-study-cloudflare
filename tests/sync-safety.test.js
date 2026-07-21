import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { SYNC_LIMITS } from "../src/worker.js";
import { SYNC_CLIENT_LIMITS, SyncClient, SyncRequestError } from "../src/client/sync.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("server quotas remain far below Cloudflare free-plan allowances", () => {
  assert.deepEqual(SYNC_LIMITS, {
    maxAuthorizedUsers: 1,
    maxRequestBodyBytes: 2 * 1024 * 1024,
    maxWriteActionsPerMinute: 5,
    maxSyncRequestsPerUtcDay: 2_000,
    maxRowsReadPerUtcDay: 50_000,
    maxRowsWrittenPerUtcDay: 2_500,
    maxPushChanges: 100,
    maxPullRows: 200,
  });
});

test("client synchronization has bounded batches, retries, background timing, and failure suspension", () => {
  assert.equal(SYNC_CLIENT_LIMITS.batchSize, 5);
  assert.equal(SYNC_CLIENT_LIMITS.maximumAutomaticRetries, 3);
  assert.equal(SYNC_CLIENT_LIMITS.minimumBackgroundIntervalMs, 15 * 60 * 1000);
  assert.equal(SYNC_CLIENT_LIMITS.failureSuspensionThreshold, 3);
});

test("oversized synchronization payloads are rejected before D1 access", async () => {
  const oversized = "x".repeat(SYNC_LIMITS.maxRequestBodyBytes + 1);
  const response = await worker.fetch(new Request("https://study.example/api/sync/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-abpn-device-id": "test-device",
    },
    body: oversized,
  }), {
    APP_RELEASE_MODE: "full",
    CLOUD_SYNC_ENABLED: "true",
    STUDY_USER_ID: "test-user",
    DB: {},
  });
  assert.equal(response.status, 413);
  assert.match(await response.text(), /2 MiB/);
});

test("non-retryable quota responses do not create an automatic retry loop", async () => {
  let calls = 0;
  const client = new SyncClient({
    deviceId: "test-device",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "quota", localOnly: true }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(() => client.request("/api/sync/pull"), (error) => {
    assert.ok(error instanceof SyncRequestError);
    assert.equal(error.status, 429);
    assert.equal(error.localOnly, true);
    return true;
  });
  assert.equal(calls, 1);
});

test("D1 migration creates one persistent guardrail row without destructive statements", async () => {
  const migration = await read("migrations/0002_sync_usage_guardrails.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_usage/);
  assert.match(migration, /CHECK \(id = 1\)/);
  assert.match(migration, /INSERT OR IGNORE INTO app_usage/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
});

test("production remains locked while guardrails are deployed", async () => {
  const wrangler = await read("wrangler.toml");
  assert.match(wrangler, /APP_RELEASE_MODE\s*=\s*"setup"/);
  assert.match(wrangler, /CLOUD_SYNC_ENABLED\s*=\s*"false"/);
  assert.match(wrangler, /STUDY_USER_ID\s*=\s*"[a-f0-9-]+"/);
});

test("the visible application includes the guarded local-only synchronization controller", async () => {
  const [index, controller, publicClient] = await Promise.all([
    read("public/index.html"),
    read("public/sync-controller.js"),
    read("public/client/sync.js"),
  ]);
  assert.match(index, /sync-controller\.js/);
  assert.match(controller, /Local only · sync paused/);
  assert.match(controller, /Local study data is safe/);
  assert.match(publicClient, /FAILURE_SUSPENSION_THRESHOLD = 3/);
  assert.match(publicClient, /MIN_BACKGROUND_INTERVAL_MS = 15 \* 60 \* 1000/);
});
