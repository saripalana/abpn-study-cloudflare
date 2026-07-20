import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function setupEnvironment() {
  let assetRequests = 0;
  return {
    env: {
      APP_ENV: "test",
      APP_RELEASE_MODE: "setup",
      CLOUD_SYNC_ENABLED: "false",
      ASSETS: {
        async fetch() {
          assetRequests += 1;
          return new Response("sensitive study asset", { status: 200 });
        },
      },
    },
    assetRequestCount: () => assetRequests,
  };
}

test("setup mode blocks every static study asset before the asset binding runs", async () => {
  const { env, assetRequestCount } = setupEnvironment();
  const response = await worker.fetch(new Request("https://study.example/app.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Protected setup is active/);
  assert.match(body, /Cloud synchronization is disabled/);
  assert.equal(assetRequestCount(), 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("setup health endpoint reports locked local-only state without requiring D1", async () => {
  const { env, assetRequestCount } = setupEnvironment();
  const response = await worker.fetch(new Request("https://study.example/api/health"), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.releaseMode, "setup");
  assert.equal(body.cloudSyncEnabled, false);
  assert.equal(body.database, "unconfigured");
  assert.equal(assetRequestCount(), 0);
});

test("setup mode rejects synchronization without touching assets or a database", async () => {
  const { env, assetRequestCount } = setupEnvironment();
  const response = await worker.fetch(new Request("https://study.example/api/sync/push", {
    method: "POST",
    body: JSON.stringify({ changes: [] }),
    headers: { "content-type": "application/json" },
  }), env);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "Application setup is not complete");
  assert.equal(assetRequestCount(), 0);
});
