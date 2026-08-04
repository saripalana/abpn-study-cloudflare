import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { SYNC_LIMITS } from "../src/worker.js";
import { SYNC_CLIENT_LIMITS, SyncClient, SyncRequestError } from "../src/client/sync.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function recordingDb({ lastSeenAt = null, activeDeviceId = null } = {}) {
  const executed = [];
  const prepare = (sql) => ({
    sql,
    values: [],
    bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes("MAX(last_seen_at)")) return { last_seen_at: lastSeenAt };
      if (sql.includes("SELECT id FROM devices WHERE user_id = ? LIMIT 1")) {
        return activeDeviceId ? { id: activeDeviceId } : null;
      }
      if (sql.includes("SELECT 1 AS ok")) return { ok: 1 };
      if (sql.includes("FROM app_usage")) return null;
      return null;
    },
    async run() { executed.push({ sql, values: this.values }); return { success: true }; },
  });
  return {
    executed,
    prepare,
    async batch(statements) {
      executed.push(...statements.map((statement) => ({ sql: statement.sql, values: statement.values })));
      return statements.map(() => ({ success: true }));
    },
  };
}

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
  assert.equal(SYNC_CLIENT_LIMITS.batchSize, 100);
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

test("the default browser fetch keeps its required global context", async () => {
  const originalFetch = globalThis.fetch;
  let observedThis;
  globalThis.fetch = function () {
    observedThis = this;
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
  };
  try {
    const client = new SyncClient({ deviceId: "test-device" });
    await client.request("/api/test");
    assert.equal(observedThis, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D1 migration creates one persistent guardrail row without destructive statements", async () => {
  const migration = await read("migrations/0002_sync_usage_guardrails.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_usage/);
  assert.match(migration, /CHECK \(id = 1\)/);
  assert.match(migration, /INSERT OR IGNORE INTO app_usage/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
});

test("D1 migration adds resumable practice-set fields without destructive statements", async () => {
  const migration = await read("migrations/0003_complete_study_sync.sql");
  assert.match(migration, /ADD COLUMN timed/);
  assert.match(migration, /ADD COLUMN current_index/);
  assert.match(migration, /ADD COLUMN remaining_seconds/);
  assert.match(migration, /ADD COLUMN submitted/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
});

test("production enables protected sync while the server kill switch remains enforceable", async () => {
  const wrangler = await read("wrangler.toml");
  assert.match(wrangler, /APP_RELEASE_MODE\s*=\s*"full"/);
  assert.match(wrangler, /CLOUD_SYNC_ENABLED\s*=\s*"true"/);
  assert.match(wrangler, /ACCESS_JWT_REQUIRED\s*=\s*"true"/);
  assert.match(wrangler, /STUDY_USER_ID\s*=\s*"[a-f0-9-]+"/);

  let assetRequests = 0;
  const env = {
    APP_RELEASE_MODE: "full",
    CLOUD_SYNC_ENABLED: "false",
    ASSETS: {
      fetch: async () => {
        assetRequests += 1;
        return new Response("local-only-app", { headers: { "content-type": "text/html" } });
      },
    },
  };

  const appResponse = await worker.fetch(new Request("https://study.example/"), env);
  assert.equal(appResponse.status, 200);
  assert.equal(await appResponse.text(), "local-only-app");
  assert.equal(assetRequests, 1);

  const healthResponse = await worker.fetch(new Request("https://study.example/api/health"), env);
  const health = await healthResponse.json();
  assert.equal(health.releaseMode, "full");
  assert.equal(health.cloudSyncEnabled, false);
  assert.equal(health.localOnly, true);
  assert.equal(health.database, "unconfigured");

  const syncResponse = await worker.fetch(new Request("https://study.example/api/sync/pull", {
    headers: { "x-abpn-device-id": "test-device" },
  }), env);
  assert.equal(syncResponse.status, 503);
  assert.deepEqual(await syncResponse.json(), {
    error: "Cloud synchronization is disabled",
    localOnly: true,
  });
});

test("the visible application has one guarded sync controller with local-only fallback", async () => {
  const [index, bootstrap, app, controller, publicClient] = await Promise.all([
    read("public/index.html"),
    read("public/bootstrap.js"),
    read("public/app.js"),
    read("public/sync-controller.js"),
    read("public/client/sync.js"),
  ]);
  assert.match(index, /bootstrap\.js/);
  assert.match(bootstrap, /sync-controller\.js/);
  assert.match(bootstrap, /backup-controller\.js/);
  assert.match(bootstrap, /data-management-controller\.js/);
  assert.match(controller, /Local only · sync paused/);
  assert.match(controller, /Restart staging sync/);
  assert.match(controller, /STAGING_SESSION_KEY/);
  assert.match(controller, /Local study data is safe/);
  assert.match(controller, /syncButton\.onclick/);
  assert.match(controller, /clearSyncSuspension/);
  assert.match(publicClient, /globalThis\.fetch\.bind\(globalThis\)/);
  assert.doesNotMatch(app, /syncBtn\.onclick/);
  assert.match(publicClient, /FAILURE_SUSPENSION_THRESHOLD = 3/);
  assert.match(publicClient, /MIN_BACKGROUND_INTERVAL_MS = 15 \* 60 \* 1000/);
  assert.match(publicClient, /applyRemoteRecord/);
  assert.match(publicClient, /practiceSetAnswer/);
});

test("disposable session reset is impossible outside isolated staging", async () => {
  const db = recordingDb();
  const response = await worker.fetch(new Request("https://study.example/api/staging/session", {
    method: "DELETE",
    headers: {
      "x-abpn-device-id": "staging-session-1234",
      "x-abpn-staging-session": "staging-session-1234",
    },
  }), {
    APP_ENV: "production",
    APP_RELEASE_MODE: "full",
    CLOUD_SYNC_ENABLED: "true",
    STUDY_USER_ID: "production-user",
    STAGING_DISPOSABLE_ENABLED: "true",
    DB: db,
  });
  assert.equal(response.status, 404);
  assert.equal(db.executed.length, 0);
});

test("isolated staging reset removes every user-scoped test table and resets usage", async () => {
  const db = recordingDb();
  const response = await worker.fetch(new Request("https://study.example/api/staging/session", {
    method: "DELETE",
    headers: {
      "x-abpn-device-id": "staging-session-1234",
      "x-abpn-staging-session": "staging-session-1234",
    },
  }), {
    APP_ENV: "staging",
    APP_RELEASE_MODE: "full",
    CLOUD_SYNC_ENABLED: "true",
    STUDY_USER_ID: "staging-user",
    STAGING_DISPOSABLE_ENABLED: "true",
    STAGING_SESSION_TTL_SECONDS: "14400",
    DB: db,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, environment: "staging", state: "cleared" });
  const sql = db.executed.map((entry) => entry.sql).join("\n");
  for (const table of [
    "deck_package_heads", "deck_package_revision_chunks", "deck_package_revisions",
    "deck_package_chunks", "deck_packages", "deck_library_state",
    "practice_set_answers", "practice_sets", "question_progress", "sync_changes",
    "devices", "users", "question_banks",
  ]) assert.match(sql, new RegExp(`DELETE FROM ${table}`));
  assert.match(sql, /UPDATE app_usage/);
  assert.match(sql, /INSERT INTO users/);
  assert.match(sql, /INSERT INTO devices/);
  assert.ok(db.executed.some((entry) => entry.values.includes("staging-session-1234")));
});

test("a replaced staging session cannot sync or consume the current session quota", async () => {
  const db = recordingDb({ activeDeviceId: "current-session-5678" });
  const response = await worker.fetch(new Request("https://study.example/api/sync/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-abpn-device-id": "stale-session-1234",
    },
    body: JSON.stringify({ changes: [] }),
  }), {
    APP_ENV: "staging",
    APP_RELEASE_MODE: "full",
    CLOUD_SYNC_ENABLED: "true",
    STUDY_USER_ID: "staging-user",
    STAGING_DISPOSABLE_ENABLED: "true",
    DB: db,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Staging session is no longer active",
    localOnly: true,
    staleSession: true,
  });
  assert.equal(db.executed.length, 0);
});

test("stale staging state expires lazily while production health stays non-destructive", async () => {
  const db = recordingDb({ lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const response = await worker.fetch(new Request("https://study.example/api/health"), {
    APP_ENV: "staging",
    APP_RELEASE_MODE: "full",
    CLOUD_SYNC_ENABLED: "true",
    STUDY_USER_ID: "staging-user",
    STAGING_DISPOSABLE_ENABLED: "true",
    STAGING_SESSION_TTL_SECONDS: "300",
    DB: db,
  });
  assert.equal(response.status, 200);
  assert.ok(db.executed.some((entry) => entry.sql.includes("DELETE FROM users")));
});
