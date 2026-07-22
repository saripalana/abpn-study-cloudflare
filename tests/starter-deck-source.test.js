import test from "node:test";
import assert from "node:assert/strict";
import {
  handleStarterDeckSourceRequest,
  STARTER_DECK_SOURCE_LIMITS,
} from "../src/starter-deck-source.js";

const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json", ...extraHeaders },
});

function helpers(fetchExternal) {
  return {
    json,
    requireContext(request) {
      assert.equal(request.headers.get("x-abpn-device-id"), "device-test");
      return { userId: "user-test", deviceId: "device-test" };
    },
    fetchExternal,
  };
}

test("ignores unrelated routes", async () => {
  const response = await handleStarterDeckSourceRequest(
    new Request("https://study.example/api/health"),
    {},
    {},
  );
  assert.equal(response, null);
});

test("returns the pinned K&S source through a same-origin protected route", async () => {
  let requestedUrl = null;
  const source = "const QUESTIONS = [];";
  const response = await handleStarterDeckSourceRequest(
    new Request("https://study.example/api/deck-sources/ks-psychiatry-core", {
      headers: { "x-abpn-device-id": "device-test" },
    }),
    {},
    helpers(async (url) => {
      requestedUrl = url;
      return new Response(source, { status: 200, headers: { "content-type": "text/javascript" } });
    }),
  );
  assert.equal(response.status, 200);
  assert.match(requestedUrl, /raw\.githubusercontent\.com\/saripalana\/ks-study-guide\/4d03f158/);
  assert.equal(await response.text(), source);
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400, immutable");
});

test("reports upstream retrieval failures without exposing an unbounded proxy", async () => {
  const response = await handleStarterDeckSourceRequest(
    new Request("https://study.example/api/deck-sources/ks-psychiatry-core", {
      headers: { "x-abpn-device-id": "device-test" },
    }),
    {},
    helpers(async () => new Response("not found", { status: 404 })),
  );
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /HTTP 404/);
});

test("starter source limit matches the ordinary deck package limit", () => {
  assert.equal(STARTER_DECK_SOURCE_LIMITS.maximumBytes, 20 * 1024 * 1024);
});
