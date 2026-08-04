import test from "node:test";
import assert from "node:assert/strict";
import { prepareStagingSession, STAGING_SESSION_KEY } from "../src/client/staging-lifecycle.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    clearCalls: 0,
    clear() { this.clearCalls += 1; values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    values,
  };
}

function health(environment) {
  return new Response(JSON.stringify({ environment }), {
    headers: { "content-type": "application/json" },
  });
}

test("production never invokes disposable staging cleanup", async () => {
  const local = memoryStorage({ preserved: "production" });
  let deleted = 0;
  const result = await prepareStagingSession({
    fetchImpl: async () => health("production"),
    localStorageRef: local,
    sessionStorageRef: memoryStorage(),
    cacheStorage: null,
    deleteDatabase: async () => { deleted += 1; },
  });
  assert.deepEqual(result, { staging: false, reset: false, sessionId: null });
  assert.equal(local.values.get("preserved"), "production");
  assert.equal(local.clearCalls, 0);
  assert.equal(deleted, 0);
});

test("a new staging browser session clears remote and browser-local test state", async () => {
  const local = memoryStorage({ old: "test-state" });
  const session = memoryStorage();
  const calls = [];
  const deletedCaches = [];
  let deletedDatabase = 0;
  const result = await prepareStagingSession({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return url === "/api/health" ? health("staging") : new Response(JSON.stringify({ ok: true }));
    },
    localStorageRef: local,
    sessionStorageRef: session,
    cacheStorage: {
      keys: async () => ["test-cache-a", "test-cache-b"],
      delete: async (key) => { deletedCaches.push(key); return true; },
    },
    createId: () => "staging-session-1234",
    deleteDatabase: async () => { deletedDatabase += 1; },
  });
  assert.deepEqual(result, { staging: true, reset: true, sessionId: "staging-session-1234" });
  assert.equal(calls[1].url, "/api/staging/session");
  assert.equal(calls[1].options.method, "DELETE");
  assert.equal(calls[1].options.headers["x-abpn-staging-session"], "staging-session-1234");
  assert.equal(local.clearCalls, 1);
  assert.equal(local.values.get("abpn-study:device-id"), "staging-session-1234");
  assert.equal(session.values.get(STAGING_SESSION_KEY), "staging-session-1234");
  assert.equal(deletedDatabase, 1);
  assert.deepEqual(deletedCaches, ["test-cache-a", "test-cache-b"]);
});

test("reloads preserve the current isolated staging session", async () => {
  const session = memoryStorage({ [STAGING_SESSION_KEY]: "staging-session-existing" });
  let cleanupCalls = 0;
  const result = await prepareStagingSession({
    fetchImpl: async (url) => {
      if (url !== "/api/health") cleanupCalls += 1;
      return health("staging");
    },
    localStorageRef: memoryStorage({ current: "session-state" }),
    sessionStorageRef: session,
    cacheStorage: null,
    deleteDatabase: async () => { cleanupCalls += 1; },
  });
  assert.deepEqual(result, { staging: true, reset: false, sessionId: "staging-session-existing" });
  assert.equal(cleanupCalls, 0);
});

test("failed remote cleanup fails closed before local state is changed", async () => {
  const local = memoryStorage({ old: "preserved-until-remote-clean" });
  await assert.rejects(() => prepareStagingSession({
    fetchImpl: async (url) => url === "/api/health"
      ? health("staging")
      : new Response(JSON.stringify({ error: "blocked" }), { status: 503 }),
    localStorageRef: local,
    sessionStorageRef: memoryStorage(),
    cacheStorage: null,
    createId: () => "staging-session-1234",
    deleteDatabase: async () => assert.fail("local cleanup must not run"),
  }), /failed safely/);
  assert.equal(local.values.get("old"), "preserved-until-remote-clean");
  assert.equal(local.clearCalls, 0);
});

test("the exact staging site fails closed when environment verification is unavailable", async () => {
  const local = memoryStorage({ old: "preserved-while-startup-is-blocked" });
  await assert.rejects(() => prepareStagingSession({
    fetchImpl: async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    localStorageRef: local,
    sessionStorageRef: memoryStorage(),
    cacheStorage: null,
    locationRef: { hostname: "abpn-study-cloudflare-staging.saripalana.workers.dev" },
    deleteDatabase: async () => assert.fail("cleanup must wait for verified staging identity"),
  }), /verification failed safely/);
  assert.equal(local.values.get("old"), "preserved-while-startup-is-blocked");
  assert.equal(local.clearCalls, 0);
});

test("the exact staging site rejects a non-staging health identity", async () => {
  await assert.rejects(() => prepareStagingSession({
    fetchImpl: async () => health("production"),
    localStorageRef: memoryStorage(),
    sessionStorageRef: memoryStorage(),
    cacheStorage: null,
    locationRef: { hostname: "abpn-study-cloudflare-staging.saripalana.workers.dev" },
    deleteDatabase: async () => assert.fail("mismatched environment must not clean state"),
  }), /verification failed safely/);
});
