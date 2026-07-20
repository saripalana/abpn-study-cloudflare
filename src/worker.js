const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  },
});

const withSecurityHeaders = (response) => {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, headers });
};

async function handleHealth(env) {
  let database = "unconfigured";
  if (env.DB) {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      database = "connected";
    } catch {
      database = "error";
    }
  }

  return json({
    ok: database !== "error",
    service: "abpn-study-cloudflare",
    environment: env.APP_ENV || "unknown",
    database,
    timestamp: new Date().toISOString(),
  }, database === "error" ? 503 : 200);
}

async function routeApi(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return handleHealth(env);
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      const response = url.pathname.startsWith("/api/")
        ? await routeApi(request, env)
        : await env.ASSETS.fetch(request);
      return withSecurityHeaders(response);
    } catch (error) {
      console.error("Unhandled request error", error);
      return withSecurityHeaders(json({ error: "Internal server error" }, 500));
    }
  },
};
