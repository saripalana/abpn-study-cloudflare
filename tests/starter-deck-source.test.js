import test from "node:test";
import assert from "node:assert/strict";
import {
  STARTER_DECK_SOURCE_LIMITS,
  handleStarterDeckSourceRequest,
} from "../src/starter-deck-source.js";

const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json", ...extraHeaders },
});

async function gitBlobSha1(text) {
  const bytes = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const value = new Uint8Array(prefix.byteLength + bytes.byteLength);
  value.set(prefix, 0);
  value.set(bytes, prefix.byteLength);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", value))]
    .map((item) => item.toString(16).padStart(2, "0")).join("");
}

function helpers(fetchExternal, expectedGitBlobSha) {
  return {
    json,
    requireSyncReady: () => {},
    requireContext(request) {
      assert.equal(request.headers.get("x-abpn-device-id"), "device-test");
      return { userId: "user-test", deviceId: "device-test" };
    },
    reserveUsage: async () => {},
    ensureUserAndDevice: async () => {},
    fetchExternal,
    expectedGitBlobSha,
  };
}

function request(method = "GET") {
  return new Request("https://study.example/api/deck-sources/ks-psychiatry-core", {
    method,
    headers: { "x-abpn-device-id": "device-test" },
  });
}

test("ignores unrelated API routes", async () => {
  const response = await handleStarterDeckSourceRequest(
    new Request("https://study.example/api/health"),
    {},
    {},
  );
  assert.equal(response, null);
});

test("proxies only the pinned K&S source with private immutable caching", async () => {
  const source = "const QUESTIONS = [];";
  const response = await handleStarterDeckSourceRequest(
    request(),
    {},
    helpers(async (url, options) => {
      assert.match(url, /raw\.githubusercontent\.com\/saripalana\/ks-study-guide\/4d03f158/);
      assert.equal(options.redirect, "error");
      return new Response(source, { status: 200 });
    }, await gitBlobSha1(source)),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400, immutable");
  assert.equal(await response.text(), source);
});

test("rejects a pinned source whose Git blob hash does not match", async () => {
  const response = await handleStarterDeckSourceRequest(
    request(),
    {},
    helpers(async () => new Response("tampered", { status: 200 }), "0".repeat(40)),
  );
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /integrity check failed/i);
});

test("fails closed for methods other than GET", async () => {
  const response = await handleStarterDeckSourceRequest(request("POST"), {}, helpers(async () => {
    throw new Error("must not fetch");
  }));
  assert.equal(response.status, 405);
});

test("enforces the existing 20 MiB free-tier source bound", () => {
  assert.equal(STARTER_DECK_SOURCE_LIMITS.maximumBytes, 20 * 1024 * 1024);
});
