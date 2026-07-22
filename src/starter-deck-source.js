const KS_SOURCE_URL = "https://raw.githubusercontent.com/saripalana/ks-study-guide/4d03f158c6fbfacd698796d94c213a49ac8a377d/data.js";
const MAX_STARTER_SOURCE_BYTES = 20 * 1024 * 1024;

export async function handleStarterDeckSourceRequest(request, env, helpers) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/deck-sources/ks-psychiatry-core") return null;

  const { json, requireContext, fetchExternal = globalThis.fetch.bind(globalThis) } = helpers;
  requireContext(request, env);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });

  const response = await fetchExternal(KS_SOURCE_URL, {
    headers: { accept: "text/javascript,text/plain" },
    redirect: "follow",
  });
  if (!response.ok) {
    return json({ error: `Pinned K&S source could not be retrieved (HTTP ${response.status})` }, 502);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_STARTER_SOURCE_BYTES) {
    return json({ error: "Pinned K&S source exceeds the 20 MiB deck-source limit" }, 502);
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
