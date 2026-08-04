const MAX_DOMAINS = 100;
// The schema keeps an internal non-null timestamp for compatibility. This
// sentinel represents the user-selected policy "until revoked" and is never
// presented as a real expiration date.
const UNTIL_REVOKED_AT = "9999-12-31T23:59:59.999Z";

function assistantFeatureEnabled(env) {
  return ["staging", "production"].includes(env.APP_ENV) && env.ASSISTANT_WEAKNESS_ENABLED === "true";
}

function requireFeature(env, json) {
  if (!assistantFeatureEnabled(env)) {
    throw json({ error: "Assistant weakness access is not enabled in this environment" }, 404);
  }
}

function finiteRatio(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${field} is invalid`);
  return number;
}

// Validate and rebuild the payload from an explicit allowlist. No unrecognized
// key can cross into storage, even if a browser caller is compromised.
export function sanitizeWeaknessAggregate(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.domains) || input.domains.length > MAX_DOMAINS) {
    throw new Error("Weakness aggregate schema is invalid");
  }
  const generatedAt = String(input.generatedAt || "");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generatedAt is invalid");
  const text = (value, field, maximum) => {
    const result = String(value || "").trim();
    if (!result || result.length > maximum) throw new Error(`${field} is invalid`);
    return result;
  };
  return {
    schemaVersion: 1,
    generatedAt,
    evidenceModel: text(input.evidenceModel, "evidenceModel", 80),
    deck: {
      id: text(input.deck?.id, "deck.id", 100),
      title: text(input.deck?.title, "deck.title", 200),
    },
    summary: {
      evidenceCoverage: finiteRatio(input.summary?.evidenceCoverage, "evidenceCoverage"),
      masteryCoverage: finiteRatio(input.summary?.masteryCoverage, "masteryCoverage"),
    },
    domains: input.domains.map((domain) => ({
      title: text(domain.title, "domain.title", 200),
      totalQuestions: Math.max(0, Math.trunc(Number(domain.totalQuestions || 0))),
      usedQuestions: Math.max(0, Math.trunc(Number(domain.usedQuestions || 0))),
      attempts: Math.max(0, Math.trunc(Number(domain.attempts || 0))),
      accuracy: finiteRatio(domain.accuracy, "domain.accuracy"),
      averageTimeMs: domain.averageTimeMs == null ? null : Math.max(0, Math.trunc(Number(domain.averageTimeMs))),
      evidence: ["none", "limited", "adequate"].includes(domain.evidence) ? domain.evidence : "none",
      priorityScore: domain.priorityScore == null ? null : Math.max(0, Math.min(100, Math.trunc(Number(domain.priorityScore)))),
      mastered: Boolean(domain.mastered),
    })),
  };
}

async function status(env, userId) {
  const row = await env.DB.prepare(`
    SELECT enabled, granted_at, expires_at, revoked_at, publish_count, access_count,
           delete_count, last_accessed_at
    FROM assistant_weakness_permissions WHERE user_id = ?
  `).bind(userId).first();
  const snapshot = await env.DB.prepare(
    "SELECT user_id FROM assistant_weakness_snapshots WHERE user_id = ?"
  ).bind(userId).first();
  const enabled = Boolean(row?.enabled);
  return {
    enabled,
    grantedAt: row?.granted_at || null,
    retention: enabled ? "until-revoked" : null,
    expiresAt: null,
    revokedAt: row?.revoked_at || null,
    snapshotPresent: Boolean(snapshot),
    publishCount: Number(row?.publish_count || 0),
    accessCount: Number(row?.access_count || 0),
    deleteCount: Number(row?.delete_count || 0),
    lastAccessedAt: row?.last_accessed_at || null,
  };
}

async function audit(env, userId, action, deviceId) {
  await env.DB.prepare(`
    INSERT INTO assistant_weakness_audit (user_id, action, device_id, occurred_at)
    VALUES (?, ?, ?, ?)
  `).bind(userId, action, deviceId, new Date().toISOString()).run();
}

export async function handleAssistantWeaknessRequest(request, env, helpers) {
  const { json, requireSyncReady, requireContext, ensureUserAndDevice, parseBoundedJson } = helpers;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/assistant/weakness")) return null;
  requireFeature(env, json);
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);

  if (url.pathname === "/api/assistant/weakness/permission" && request.method === "GET") {
    return json(await status(env, userId));
  }

  if (url.pathname === "/api/assistant/weakness/permission" && request.method === "PUT") {
    const body = await parseBoundedJson(request);
    const enabled = body.enabled === true;
    const now = new Date();
    await env.DB.prepare(`
      INSERT INTO assistant_weakness_permissions
        (user_id, enabled, granted_at, expires_at, revoked_at, publish_count, access_count)
      VALUES (?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled = excluded.enabled,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at
    `).bind(userId, Number(enabled), enabled ? now.toISOString() : null, enabled ? UNTIL_REVOKED_AT : null, enabled ? null : now.toISOString()).run();
    await audit(env, userId, enabled ? "permission-granted" : "permission-revoked", deviceId);
    return json(await status(env, userId));
  }

  if (url.pathname === "/api/assistant/weakness/snapshot" && request.method === "POST") {
    const permission = await status(env, userId);
    if (!permission.enabled) return json({ error: "Explicit assistant-insights permission is required" }, 403);
    let aggregate;
    try {
      aggregate = sanitizeWeaknessAggregate(await parseBoundedJson(request));
    } catch (error) {
      return json({ error: error.message || "Invalid weakness aggregate" }, 400);
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO assistant_weakness_snapshots (user_id, payload_json, generated_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET payload_json = excluded.payload_json,
          generated_at = excluded.generated_at, expires_at = excluded.expires_at
      `).bind(userId, JSON.stringify(aggregate), aggregate.generatedAt, UNTIL_REVOKED_AT),
      env.DB.prepare(`
        UPDATE assistant_weakness_permissions SET publish_count = publish_count + 1 WHERE user_id = ?
      `).bind(userId),
    ]);
    await audit(env, userId, "snapshot-published", deviceId);
    return json({ ok: true, generatedAt: aggregate.generatedAt, retention: "until-revoked", expiresAt: null });
  }

  if (url.pathname === "/api/assistant/weakness/snapshot" && request.method === "GET") {
    const permission = await status(env, userId);
    if (!permission.enabled) return json({ error: "Explicit assistant-insights permission is required" }, 403);
    const row = await env.DB.prepare(`
      SELECT payload_json, generated_at FROM assistant_weakness_snapshots
      WHERE user_id = ?
    `).bind(userId).first();
    if (!row) return json({ error: "No current content-free weakness snapshot" }, 404);
    const accessedAt = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE assistant_weakness_permissions
      SET access_count = access_count + 1, last_accessed_at = ? WHERE user_id = ?
    `).bind(accessedAt, userId).run();
    await audit(env, userId, "snapshot-accessed", deviceId);
    return json({ aggregate: JSON.parse(row.payload_json), generatedAt: row.generated_at, retention: "until-revoked", expiresAt: null });
  }

  if (url.pathname === "/api/assistant/weakness/snapshot" && request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assistant_weakness_snapshots WHERE user_id = ?").bind(userId),
      env.DB.prepare(`
        UPDATE assistant_weakness_permissions
        SET delete_count = delete_count + 1 WHERE user_id = ?
      `).bind(userId),
    ]);
    return json({ ok: true, deleted: true });
  }

  return json({ error: "Not found" }, 404);
}
