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

function requireContext(request, env) {
  const deviceId = request.headers.get("x-abpn-device-id")?.trim();
  const userId = env.STUDY_USER_ID?.trim();
  if (!userId) throw new Response("STUDY_USER_ID is not configured", { status: 503 });
  if (!deviceId) throw new Response("Missing x-abpn-device-id", { status: 400 });
  return { userId, deviceId };
}

async function ensureUserAndDevice(env, userId, deviceId) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at"
    ).bind(userId, now, now),
    env.DB.prepare(
      "INSERT INTO devices (id, user_id, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, user_id = excluded.user_id"
    ).bind(deviceId, userId, now),
  ]);
}

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

async function upsertQuestionProgress(env, userId, deviceId, payload) {
  const bankId = String(payload.bankId || "");
  const questionId = String(payload.questionId || "");
  if (!bankId || !questionId) throw new Error("questionProgress requires bankId and questionId");

  const current = await env.DB.prepare(
    "SELECT revision, updated_at FROM question_progress WHERE user_id = ? AND bank_id = ? AND question_id = ?"
  ).bind(userId, bankId, questionId).first();

  const incomingRevision = Number(payload.revision || 1);
  if (current && incomingRevision < Number(current.revision)) {
    return {
      conflict: true,
      entityType: "questionProgress",
      entityKey: `${bankId}:${questionId}`,
      remoteRevision: Number(current.revision),
      remoteUpdatedAt: current.updated_at,
    };
  }

  const updatedAt = String(payload.updatedAt || new Date().toISOString());
  await env.DB.prepare(`
    INSERT INTO question_progress (
      user_id, bank_id, question_id, selected_answer, is_correct, is_flagged,
      times_used, total_time_ms, last_used_at, revision, updated_at, updated_by_device
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, bank_id, question_id) DO UPDATE SET
      selected_answer = excluded.selected_answer,
      is_correct = excluded.is_correct,
      is_flagged = excluded.is_flagged,
      times_used = excluded.times_used,
      total_time_ms = excluded.total_time_ms,
      last_used_at = excluded.last_used_at,
      revision = excluded.revision,
      updated_at = excluded.updated_at,
      updated_by_device = excluded.updated_by_device
  `).bind(
    userId,
    bankId,
    questionId,
    payload.selectedAnswer ?? null,
    payload.isCorrect == null ? null : Number(Boolean(payload.isCorrect)),
    Number(Boolean(payload.isFlagged)),
    Number(payload.timesUsed || 0),
    Number(payload.totalTimeMs || 0),
    payload.lastUsedAt ?? null,
    incomingRevision,
    updatedAt,
    deviceId
  ).run();

  const change = await env.DB.prepare(`
    INSERT INTO sync_changes (user_id, device_id, entity_type, entity_id, operation, revision, changed_at)
    VALUES (?, ?, 'questionProgress', ?, 'upsert', ?, ?)
    RETURNING id
  `).bind(userId, deviceId, `${bankId}:${questionId}`, incomingRevision, updatedAt).first();

  return { conflict: false, changeId: change.id };
}

async function handleSyncPush(request, env) {
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);
  const body = await request.json();
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 100) : [];
  const acceptedIds = [];
  const conflicts = [];

  for (const change of changes) {
    try {
      if (change.entityType !== "questionProgress" || change.operation !== "upsert") {
        conflicts.push({ id: change.id, reason: "unsupported-change-type" });
        continue;
      }
      const result = await upsertQuestionProgress(env, userId, deviceId, change.payload || {});
      if (result.conflict) conflicts.push({ id: change.id, ...result });
      else acceptedIds.push(change.id);
    } catch (error) {
      conflicts.push({ id: change.id, reason: error.message || "invalid-change" });
    }
  }

  return json({ acceptedIds, conflicts });
}

async function handleSyncPull(request, env) {
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);
  const url = new URL(request.url);
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") || 0));
  const rows = await env.DB.prepare(`
    SELECT sc.id, sc.entity_type, sc.entity_id, sc.operation, sc.revision, sc.changed_at,
           qp.bank_id, qp.question_id, qp.selected_answer, qp.is_correct, qp.is_flagged,
           qp.times_used, qp.total_time_ms, qp.last_used_at, qp.updated_at, qp.updated_by_device
    FROM sync_changes sc
    LEFT JOIN question_progress qp
      ON sc.user_id = qp.user_id
      AND sc.entity_type = 'questionProgress'
      AND sc.entity_id = qp.bank_id || ':' || qp.question_id
    WHERE sc.user_id = ? AND sc.id > ? AND (sc.device_id IS NULL OR sc.device_id != ?)
    ORDER BY sc.id ASC
    LIMIT 200
  `).bind(userId, cursor, deviceId).all();

  const changes = rows.results.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityKey: row.entity_id,
    operation: row.operation,
    revision: row.revision,
    changedAt: row.changed_at,
    payload: row.entity_type === "questionProgress" ? {
      bankId: row.bank_id,
      questionId: row.question_id,
      selectedAnswer: row.selected_answer,
      isCorrect: row.is_correct == null ? null : Boolean(row.is_correct),
      isFlagged: Boolean(row.is_flagged),
      timesUsed: row.times_used,
      totalTimeMs: row.total_time_ms,
      lastUsedAt: row.last_used_at,
      revision: row.revision,
      updatedAt: row.updated_at,
      deviceId: row.updated_by_device,
    } : null,
  }));

  return json({
    changes,
    nextCursor: changes.length ? String(changes.at(-1).id) : String(cursor),
  });
}

async function routeApi(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") return handleHealth(env);
  if (request.method === "POST" && url.pathname === "/api/sync/push") return handleSyncPush(request, env);
  if (request.method === "GET" && url.pathname === "/api/sync/pull") return handleSyncPull(request, env);

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
      if (error instanceof Response) return withSecurityHeaders(error);
      console.error("Unhandled request error", error);
      return withSecurityHeaders(json({ error: "Internal server error" }, 500));
    }
  },
};
