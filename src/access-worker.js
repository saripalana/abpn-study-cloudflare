import { createRemoteJWKSet, jwtVerify } from "jose";
import applicationWorker from "./worker.js";

const jwksByTeamDomain = new Map();

const json = (data, status) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
});

const withSecurityHeaders = (response) => {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  return new Response(response.body, { status: response.status, headers });
};

const accessValidationRequired = (env) => env.ACCESS_JWT_REQUIRED !== "false";

function normalizeTeamDomain(value) {
  const domain = String(value || "").trim().replace(/\/$/, "");
  if (!domain.startsWith("https://") || !domain.endsWith(".cloudflareaccess.com")) {
    throw json({ error: "Cloudflare Access validation is not configured" }, 503);
  }
  return domain;
}

function remoteJwks(teamDomain) {
  if (!jwksByTeamDomain.has(teamDomain)) {
    jwksByTeamDomain.set(
      teamDomain,
      createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
    );
  }
  return jwksByTeamDomain.get(teamDomain);
}

async function requireCloudflareAccess(request, env) {
  if (!accessValidationRequired(env)) return null;

  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = String(env.ACCESS_POLICY_AUD || "").trim();
  if (!audience) {
    throw json({ error: "Cloudflare Access validation is not configured" }, 503);
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw json({ error: "Cloudflare Access authentication is required" }, 403);
  }

  try {
    const { payload } = await jwtVerify(token, remoteJwks(teamDomain), {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
    });
    return payload;
  } catch {
    throw json({ error: "Cloudflare Access authentication is invalid" }, 403);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      await requireCloudflareAccess(request, env);
      return applicationWorker.fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) return withSecurityHeaders(error);
      console.error("Cloudflare Access validation failure", error);
      return withSecurityHeaders(json({ error: "Authentication validation failed" }, 500));
    }
  },
};
