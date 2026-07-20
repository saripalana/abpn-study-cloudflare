import test from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/access-worker.js";

const TEAM_DOMAIN = "https://unit-test.cloudflareaccess.com";
const AUDIENCE = "unit-test-audience";

function environment(overrides = {}) {
  let assetRequests = 0;
  return {
    env: {
      APP_ENV: "test",
      APP_RELEASE_MODE: "setup",
      CLOUD_SYNC_ENABLED: "false",
      ACCESS_JWT_REQUIRED: "true",
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_POLICY_AUD: AUDIENCE,
      ASSETS: {
        async fetch() {
          assetRequests += 1;
          return new Response("sensitive study asset");
        },
      },
      ...overrides,
    },
    assetRequestCount: () => assetRequests,
  };
}

async function signingFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "unit-test-key";
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const sign = (audience = AUDIENCE) => new SignJWT({ email: "authorized@example.com" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  return { publicJwk, sign };
}

test("Access validation fails closed when its configuration is missing", async () => {
  const { env, assetRequestCount } = environment({ ACCESS_POLICY_AUD: "" });
  const response = await worker.fetch(new Request("https://study.example/"), env);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "Cloudflare Access validation is not configured");
  assert.equal(assetRequestCount(), 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Access validation rejects requests without the assertion header", async () => {
  const { env, assetRequestCount } = environment();
  const response = await worker.fetch(new Request("https://study.example/"), env);
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error, "Cloudflare Access authentication is required");
  assert.equal(assetRequestCount(), 0);
});

test("a valid Access JWT reaches the locked setup application", async () => {
  const originalFetch = globalThis.fetch;
  const { publicJwk, sign } = await signingFixture();
  globalThis.fetch = async (input, init) => {
    if (String(input) === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const { env, assetRequestCount } = environment();
    const token = await sign();
    const response = await worker.fetch(new Request("https://study.example/", {
      headers: { "cf-access-jwt-assertion": token },
    }), env);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Protected setup is active/);
    assert.equal(assetRequestCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a signed token for another audience is rejected", async () => {
  const originalFetch = globalThis.fetch;
  const { publicJwk, sign } = await signingFixture();
  globalThis.fetch = async (input, init) => {
    if (String(input) === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const { env, assetRequestCount } = environment();
    const token = await sign("wrong-audience");
    const response = await worker.fetch(new Request("https://study.example/", {
      headers: { "cf-access-jwt-assertion": token },
    }), env);
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.error, "Cloudflare Access authentication is invalid");
    assert.equal(assetRequestCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local browser tests can explicitly disable Access validation", async () => {
  const { env } = environment({ ACCESS_JWT_REQUIRED: "false" });
  const response = await worker.fetch(new Request("https://study.example/"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Protected setup is active/);
});
