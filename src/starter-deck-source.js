// Recovery reads the immutable original K&S revision; the bundled Deck Library
// package remains the offline-first runtime copy.
const KS_SOURCE_URL = "https://raw.githubusercontent.com/dancingremote/ks-study-guide/020aae0f5c55ad3bb0c122760c7b7d3fe26f1b46/data.js";
const KS_SOURCE_GIT_BLOB_SHA = "da048a097ee9d2bca4142a0e2e7444fe21b5da2e";
const MAX_STARTER_SOURCE_BYTES = 20 * 1024 * 1024;

const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((value) => value.toString(16).padStart(2, "0"))
  .join("");

async function gitBlobSha1(bytes) {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const value = new Uint8Array(prefix.byteLength + bytes.byteLength);
  value.set(prefix, 0);
  value.set(new Uint8Array(bytes), prefix.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", value));
}

// Proxies only the pinned K&S recovery source through the authenticated Worker.
// It is additive: the bundled/local K&S deck remains the offline-first default.
export async function handleStarterDeckSourceRequest(request, env, helpers) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/deck-sources/ks-psychiatry-core") return null;

  const {
    json,
    requireSyncReady,
    requireContext,
    reserveUsage,
    ensureUserAndDevice,
    fetchExternal = globalThis.fetch.bind(globalThis),
    expectedGitBlobSha = KS_SOURCE_GIT_BLOB_SHA,
  } = helpers;
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
  await ensureUserAndDevice(env, userId, deviceId);
  await reserveUsage(env, { requests: 1, rowsRead: 0, rowsWritten: 0 });

  const response = await fetchExternal(KS_SOURCE_URL, {
    headers: { accept: "text/javascript,text/plain" },
    redirect: "error",
  });
  if (!response.ok) {
    return json({ error: `Pinned K&S source could not be retrieved (HTTP ${response.status})` }, 502);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_STARTER_SOURCE_BYTES) {
    return json({ error: "Pinned K&S source exceeds the 20 MiB source limit" }, 502);
  }
  if (await gitBlobSha1(bytes) !== expectedGitBlobSha) {
    return json({ error: "Pinned K&S source integrity check failed" }, 502);
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

export const STARTER_DECK_SOURCE_LIMITS = Object.freeze({
  maximumBytes: MAX_STARTER_SOURCE_BYTES,
});
