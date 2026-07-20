const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  },
});

const releaseMode = (env) => env.APP_RELEASE_MODE === "full" ? "full" : "setup";
const cloudSyncEnabled = (env) => releaseMode(env) === "full" && env.CLOUD_SYNC_ENABLED === "true";

const withSecurityHeaders = (response) => {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  return new Response(response.body, { status: response.status, headers });
};

const setupPage = () => new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ABPN Study · Protected setup</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #172033; }
    main { width: min(38rem, calc(100% - 2rem)); padding: 2.5rem; border: 1px solid #dbe3ef; border-radius: 1.25rem; background: white; box-shadow: 0 1rem 3rem rgba(20, 35, 60, .10); }
    h1 { margin: .3rem 0 .8rem; font-size: clamp(1.8rem, 5vw, 2.6rem); }
    p { line-height: 1.6; color: #4d5b73; }
    .eyebrow { font-size: .78rem; font-weight: 800; letter-spacing: .12em; color: #2458c6; }
    .status { margin-top: 1.5rem; padding: .9rem 1rem; border-radius: .8rem; background: #eef4ff; color: #173f91; font-weight: 700; }
    @media (prefers-color-scheme: dark) {
      body { background: #101522; color: #f4f7fb; }
      main { background: #171e2d; border-color: #2b3850; }
      p { color: #bac5d8; }
      .status { background: #1d3157; color: #cfe0ff; }
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">ABPN PSYCHIATRY STUDY</div>
    <h1>Protected setup is active</h1>
    <p>The study application and question banks are intentionally unavailable during initial Cloudflare configuration.</p>
    <p>Cloud synchronization is disabled. No study progress is being written to Cloudflare.</p>
    <div class="status">Safe setup mode · local study data remains untouched</div>
  </main>
</body>
</html>`, {
  status: 200,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  },
});

function requireSyncReady(env) {
  if (releaseMode(env) !== "full") {
    throw json({ error: "Application setup is not complete" }, 503);
  }
  if (env.CLOUD_SYNC_ENABLED !== "true") {
    throw json({ error: "Cloud synchronization is disabled" }, 503);
  }
  if (!env.DB) {
    throw json({ error: "Cloud synchronization database is not configured" }, 503);
  }
}

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
  const mode = releaseMode(env);
  const syncEnabled = cloudSyncEnabled(env);
  let database = env.DB ? "configured" : "unconfigured";

  if (syncEnabled && env.DB) {
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
    releaseMode: mode,
    cloudSyncEnabled: syncEnabled,
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
  requireSyncReady(env);
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
  requireSyncReady(env);
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
      if (releaseMode(env) !== "full") {
        const response = url.pathname === "/api/health"
          ? await handleHealth(env)
          : url.pathname.startsWith("/api/")
            ? json({ error: "Application setup is not complete" }, 503)
            : setupPage();
        return withSecurityHeaders(response);
      }

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
