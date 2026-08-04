import { handleDeckLibraryRequest } from "./deck-library-api.js";
import { handleStarterDeckSourceRequest } from "./starter-deck-source.js";
import { handleAssistantWeaknessRequest } from "./assistant-weakness-api.js";

// ABPN_CLOUD_DECK_LIBRARY_V1
const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  },
});

export const SYNC_LIMITS = Object.freeze({
  maxAuthorizedUsers: 1,
  maxRequestBodyBytes: 2 * 1024 * 1024,
  maxWriteActionsPerMinute: 5,
  maxSyncRequestsPerUtcDay: 2_000,
  maxRowsReadPerUtcDay: 50_000,
  maxRowsWrittenPerUtcDay: 2_500,
  maxPushChanges: 100,
  maxPullRows: 200,
});

const releaseMode = (env) => env.APP_RELEASE_MODE === "full" ? "full" : "setup";
const cloudSyncEnabled = (env) => releaseMode(env) === "full" && env.CLOUD_SYNC_ENABLED === "true";
const disposableStagingEnabled = (env) => env.APP_ENV === "staging"
  && env.STAGING_DISPOSABLE_ENABLED === "true"
  && env.STUDY_USER_ID === "staging-user";
const stagingSessionTtlSeconds = (env) => Math.max(300, Math.min(
  86_400,
  Number(env.STAGING_SESSION_TTL_SECONDS || 14_400),
));

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
    throw json({ error: "Application setup is not complete", localOnly: true }, 503);
  }
  if (env.CLOUD_SYNC_ENABLED !== "true") {
    throw json({ error: "Cloud synchronization is disabled", localOnly: true }, 503);
  }
  if (!env.DB) {
    throw json({ error: "Cloud synchronization database is not configured", localOnly: true }, 503);
  }
}

function requireContext(request, env) {
  const deviceId = request.headers.get("x-abpn-device-id")?.trim();
  const userId = env.STUDY_USER_ID?.trim();
  if (!userId) throw json({ error: "STUDY_USER_ID is not configured", localOnly: true }, 503);
  if (!deviceId) throw json({ error: "Missing x-abpn-device-id" }, 400);
  if (deviceId.length > 200) throw json({ error: "Invalid x-abpn-device-id" }, 400);
  return { userId, deviceId };
}

function requireDisposableStaging(request, env) {
  if (!disposableStagingEnabled(env)) {
    throw json({ error: "Disposable session cleanup is available only in isolated staging" }, 404);
  }
  const sessionId = request.headers.get("x-abpn-staging-session")?.trim();
  const deviceId = request.headers.get("x-abpn-device-id")?.trim();
  if (!sessionId || sessionId !== deviceId || !/^[A-Za-z0-9-]{8,200}$/.test(sessionId)) {
    throw json({ error: "A valid isolated staging session is required" }, 400);
  }
  return sessionId;
}

async function clearDisposableStagingState(env, { activeSessionId = null } = {}) {
  const userId = env.STUDY_USER_ID;
  const now = new Date().toISOString();
  // Delete children before parents so cleanup remains valid across the current
  // legacy package schema and its immutable revision foreign-key constraints.
  const statements = [
    env.DB.prepare("DELETE FROM assistant_weakness_audit WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM assistant_weakness_snapshots WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM assistant_weakness_permissions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM deck_package_heads WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM deck_package_revision_chunks WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM deck_package_revisions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM deck_package_chunks WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM deck_packages WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM deck_library_state WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM practice_set_answers WHERE set_id IN (SELECT id FROM practice_sets WHERE user_id = ?)").bind(userId),
    env.DB.prepare("DELETE FROM practice_sets WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM question_progress WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sync_changes WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    env.DB.prepare("DELETE FROM question_banks WHERE id NOT IN (SELECT bank_id FROM question_progress UNION SELECT bank_id FROM practice_sets)"),
    env.DB.prepare(`
      UPDATE app_usage
      SET utc_day = '', utc_minute = '', request_count = 0, write_actions = 0,
          rows_read = 0, rows_written = 0, suspended = 0,
          suspension_reason = NULL, updated_at = ?
      WHERE id = 1
    `).bind(now),
  ];
  // The active staging lease is created in the same atomic batch as cleanup.
  // Any older browser tab therefore loses authorization before it can sync.
  if (activeSessionId) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)"
      ).bind(userId, now, now),
      env.DB.prepare(
        "INSERT INTO devices (id, user_id, last_seen_at) VALUES (?, ?, ?)"
      ).bind(activeSessionId, userId, now),
    );
  }
  await env.DB.batch(statements);
}

async function expireDisposableStagingState(env) {
  // Browser close delivery is not reliable. A later staging health check
  // therefore clears any session whose last device heartbeat exceeded the
  // bounded TTL. The exact staging guard makes this path unreachable in live.
  if (!disposableStagingEnabled(env) || !env.DB) return false;
  const latest = await env.DB.prepare(
    "SELECT MAX(last_seen_at) AS last_seen_at FROM devices WHERE user_id = ?"
  ).bind(env.STUDY_USER_ID).first();
  if (!latest?.last_seen_at) return false;
  const ageMs = Date.now() - Date.parse(latest.last_seen_at);
  if (!Number.isFinite(ageMs) || ageMs <= stagingSessionTtlSeconds(env) * 1000) return false;
  await clearDisposableStagingState(env);
  return true;
}

async function handleStagingSessionReset(request, env) {
  requireSyncReady(env);
  const sessionId = requireDisposableStaging(request, env);
  await clearDisposableStagingState(env, { activeSessionId: sessionId });
  return json({ ok: true, environment: "staging", state: "cleared" });
}

function utcBuckets(now = new Date()) {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), minute: iso.slice(0, 16), now: iso };
}

async function readUsage(env) {
  return env.DB.prepare(`
    SELECT utc_day, utc_minute, request_count, write_actions, rows_read, rows_written,
           suspended, suspension_reason, updated_at
    FROM app_usage
    WHERE id = 1
  `).first();
}

async function suspendCloudSync(env, reason) {
  await env.DB.prepare(`
    UPDATE app_usage
    SET suspended = 1, suspension_reason = ?, updated_at = ?
    WHERE id = 1
  `).bind(reason, new Date().toISOString()).run();
}

function usageSnapshot(row) {
  if (!row) return null;
  return {
    utcDay: row.utc_day,
    utcMinute: row.utc_minute,
    requestCount: Number(row.request_count || 0),
    writeActions: Number(row.write_actions || 0),
    rowsRead: Number(row.rows_read || 0),
    rowsWritten: Number(row.rows_written || 0),
    suspended: Boolean(row.suspended),
    suspensionReason: row.suspension_reason || null,
    updatedAt: row.updated_at,
  };
}

function quotaReason(projected) {
  if (projected.requests > SYNC_LIMITS.maxSyncRequestsPerUtcDay) return "daily-sync-request-limit";
  if (projected.writeActions > SYNC_LIMITS.maxWriteActionsPerMinute) return "per-minute-write-action-limit";
  if (projected.rowsRead > SYNC_LIMITS.maxRowsReadPerUtcDay) return "daily-rows-read-limit";
  if (projected.rowsWritten > SYNC_LIMITS.maxRowsWrittenPerUtcDay) return "daily-rows-written-limit";
  return null;
}

async function reserveUsage(env, delta = {}) {
  const bucket = utcBuckets();
  let row = await readUsage(env);
  if (!row) throw json({ error: "Usage guardrail table is not configured", localOnly: true }, 503);
  if (row.suspended) {
    throw json({
      error: "Cloud synchronization is suspended",
      reason: row.suspension_reason || "manual-suspension",
      localOnly: true,
    }, 503);
  }

  const dayChanged = row.utc_day !== bucket.day;
  const minuteChanged = row.utc_minute !== bucket.minute;
  let resetWrite = 0;

  if (dayChanged || minuteChanged) {
    await env.DB.prepare(`
      UPDATE app_usage
      SET utc_day = ?,
          utc_minute = ?,
          request_count = CASE WHEN utc_day = ? THEN request_count ELSE 0 END,
          rows_read = CASE WHEN utc_day = ? THEN rows_read ELSE 0 END,
          rows_written = CASE WHEN utc_day = ? THEN rows_written ELSE 0 END,
          write_actions = CASE WHEN utc_minute = ? THEN write_actions ELSE 0 END,
          updated_at = ?
      WHERE id = 1 AND suspended = 0
    `).bind(
      bucket.day,
      bucket.minute,
      bucket.day,
      bucket.day,
      bucket.day,
      bucket.minute,
      bucket.now
    ).run();
    resetWrite = 1;
    row = {
      ...row,
      utc_day: bucket.day,
      utc_minute: bucket.minute,
      request_count: dayChanged ? 0 : row.request_count,
      rows_read: dayChanged ? 0 : row.rows_read,
      rows_written: dayChanged ? 0 : row.rows_written,
      write_actions: minuteChanged ? 0 : row.write_actions,
    };
  }

  const increments = {
    requests: Math.max(0, Number(delta.requests || 0)),
    writeActions: Math.max(0, Number(delta.writeActions || 0)),
    rowsRead: Math.max(0, Number(delta.rowsRead || 0)) + 1,
    rowsWritten: Math.max(0, Number(delta.rowsWritten || 0)) + 1 + resetWrite,
  };
  const projected = {
    requests: Number(row.request_count || 0) + increments.requests,
    writeActions: Number(row.write_actions || 0) + increments.writeActions,
    rowsRead: Number(row.rows_read || 0) + increments.rowsRead,
    rowsWritten: Number(row.rows_written || 0) + increments.rowsWritten,
  };
  const reason = quotaReason(projected);
  if (reason) {
    await suspendCloudSync(env, reason);
    throw json({
      error: "Cloud synchronization was suspended before an internal free-tier limit was reached",
      reason,
      localOnly: true,
      limits: SYNC_LIMITS,
    }, 429, { "retry-after": "86400" });
  }

  const updated = await env.DB.prepare(`
    UPDATE app_usage
    SET request_count = request_count + ?,
        write_actions = write_actions + ?,
        rows_read = rows_read + ?,
        rows_written = rows_written + ?,
        updated_at = ?
    WHERE id = 1
      AND suspended = 0
      AND request_count + ? <= ?
      AND write_actions + ? <= ?
      AND rows_read + ? <= ?
      AND rows_written + ? <= ?
    RETURNING utc_day, utc_minute, request_count, write_actions, rows_read, rows_written,
              suspended, suspension_reason, updated_at
  `).bind(
    increments.requests,
    increments.writeActions,
    increments.rowsRead,
    increments.rowsWritten,
    bucket.now,
    increments.requests,
    SYNC_LIMITS.maxSyncRequestsPerUtcDay,
    increments.writeActions,
    SYNC_LIMITS.maxWriteActionsPerMinute,
    increments.rowsRead,
    SYNC_LIMITS.maxRowsReadPerUtcDay,
    increments.rowsWritten,
    SYNC_LIMITS.maxRowsWrittenPerUtcDay
  ).first();

  if (!updated) {
    await suspendCloudSync(env, "concurrent-quota-check-failed");
    throw json({
      error: "Cloud synchronization was suspended because a quota reservation could not be completed safely",
      reason: "concurrent-quota-check-failed",
      localOnly: true,
    }, 429, { "retry-after": "86400" });
  }
  return usageSnapshot(updated);
}

async function parseBoundedJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > SYNC_LIMITS.maxRequestBodyBytes) {
    throw json({ error: "Request body exceeds the 2 MiB synchronization limit" }, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > SYNC_LIMITS.maxRequestBodyBytes) {
    throw json({ error: "Request body exceeds the 2 MiB synchronization limit" }, 413);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw json({ error: "Invalid JSON request body" }, 400);
  }
}

async function ensureUserAndDevice(env, userId, deviceId) {
  if (disposableStagingEnabled(env)) {
    const activeDevice = await env.DB.prepare(
      "SELECT id FROM devices WHERE user_id = ? LIMIT 1"
    ).bind(userId).first();
    if (!activeDevice || activeDevice.id !== deviceId) {
      throw json({
        error: "Staging session is no longer active",
        localOnly: true,
        staleSession: true,
      }, 409);
    }
    await env.DB.prepare(
      "UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?"
    ).bind(new Date().toISOString(), deviceId, userId).run();
    return;
  }

  const otherUser = await env.DB.prepare("SELECT id FROM users WHERE id != ? LIMIT 1").bind(userId).first();
  if (otherUser) {
    throw json({
      error: "The one-user synchronization limit has been reached",
      localOnly: true,
    }, 403);
  }

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
  let usage = null;

  if (syncEnabled && env.DB) {
    try {
      await expireDisposableStagingState(env);
      await env.DB.prepare("SELECT 1 AS ok").first();
      const usageRow = await readUsage(env);
      usage = usageSnapshot(usageRow);
      database = usage?.suspended ? "suspended" : "connected";
    } catch {
      database = "error";
    }
  }

  return json({
    ok: database !== "error",
    service: "abpn-study-cloudflare",
    environment: env.APP_ENV || "unknown",
    releaseMode: mode,
    cloudSyncEnabled: syncEnabled && database !== "suspended",
    localOnly: !syncEnabled || database === "suspended",
    database,
    usage,
    limits: SYNC_LIMITS,
    timestamp: new Date().toISOString(),
  }, database === "error" ? 503 : 200);
}

function boundedString(value, field, maxLength = 200) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) throw new Error(`${field} is invalid`);
  return result;
}

function revisionDecision(current, incomingRevision, updatedAt) {
  if (!current) return { accept: true };
  const remoteRevision = Number(current.revision);
  const remoteUpdatedAt = current.updated_at;
  const incomingTime = Date.parse(updatedAt);
  const remoteTime = Date.parse(remoteUpdatedAt);
  if (incomingRevision < remoteRevision || (incomingRevision === remoteRevision && incomingTime < remoteTime)) {
    return { accept: false, conflict: true, remoteWins: true, remoteRevision, remoteUpdatedAt };
  }
  if (incomingRevision === remoteRevision && incomingTime === remoteTime) {
    return { accept: false, conflict: false, idempotent: true, remoteRevision, remoteUpdatedAt };
  }
  return { accept: true };
}

async function ensureQuestionBank(env, bankId) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO question_banks (id, slug, name, version, question_count, created_at, updated_at)
    VALUES (?, ?, ?, 'synced', 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).bind(bankId, bankId, bankId, now, now).run();
}

async function upsertQuestionProgress(env, userId, deviceId, payload) {
  const bankId = boundedString(payload.bankId, "bankId");
  const questionId = boundedString(payload.questionId, "questionId");
  const incomingRevision = Number(payload.revision || 1);
  if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 1) {
    throw new Error("questionProgress revision is invalid");
  }
  const updatedAt = String(payload.updatedAt || new Date().toISOString());
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("questionProgress updatedAt is invalid");

  const current = await env.DB.prepare(
    "SELECT revision, updated_at FROM question_progress WHERE user_id = ? AND bank_id = ? AND question_id = ?"
  ).bind(userId, bankId, questionId).first();
  const decision = revisionDecision(current, incomingRevision, updatedAt);
  if (!decision.accept) return { ...decision, entityType: "questionProgress", entityKey: `${bankId}:${questionId}`, changeId: null };

  await ensureQuestionBank(env, bankId);

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
    payload.selectedAnswer == null ? null : String(payload.selectedAnswer).slice(0, 20),
    payload.isCorrect == null ? null : Number(Boolean(payload.isCorrect)),
    Number(Boolean(payload.isFlagged)),
    Math.max(0, Number(payload.timesUsed || 0)),
    Math.max(0, Number(payload.totalTimeMs || 0)),
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

async function upsertPracticeSet(env, userId, deviceId, payload) {
  const id = boundedString(payload.id, "practiceSet id");
  const bankId = boundedString(payload.bankId, "practiceSet bankId");
  const incomingRevision = Number(payload.revision || 1);
  if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 1) throw new Error("practiceSet revision is invalid");
  const updatedAt = String(payload.updatedAt || new Date().toISOString());
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("practiceSet updatedAt is invalid");
  const questionIds = Array.isArray(payload.questionIds) ? payload.questionIds.map((value) => boundedString(value, "questionId")) : [];
  if (!questionIds.length || questionIds.length > 5_000) throw new Error("practiceSet questionIds are invalid");

  const current = await env.DB.prepare(
    "SELECT revision, updated_at FROM practice_sets WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first();
  const decision = revisionDecision(current, incomingRevision, updatedAt);
  if (!decision.accept) return { ...decision, entityType: "practiceSet", entityKey: id, changeId: null };
  await ensureQuestionBank(env, bankId);

  await env.DB.prepare(`
    INSERT INTO practice_sets (
      id, user_id, bank_id, name, mode, status, started_at, completed_at, elapsed_ms,
      question_ids_json, timed, current_index, remaining_seconds, submitted,
      revision, updated_at, updated_by_device
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      bank_id = excluded.bank_id, name = excluded.name, mode = excluded.mode,
      status = excluded.status, started_at = excluded.started_at, completed_at = excluded.completed_at,
      elapsed_ms = excluded.elapsed_ms, question_ids_json = excluded.question_ids_json,
      timed = excluded.timed, current_index = excluded.current_index,
      remaining_seconds = excluded.remaining_seconds, submitted = excluded.submitted,
      revision = excluded.revision, updated_at = excluded.updated_at,
      updated_by_device = excluded.updated_by_device
  `).bind(
    id, userId, bankId, payload.name == null ? null : String(payload.name).slice(0, 200),
    boundedString(payload.mode, "practiceSet mode", 20), boundedString(payload.status, "practiceSet status", 40),
    String(payload.startedAt || updatedAt), payload.completedAt || null, Math.max(0, Number(payload.elapsedMs || 0)),
    JSON.stringify(questionIds), Number(Boolean(payload.timed)), Math.max(0, Number(payload.index || 0)),
    Math.max(0, Number(payload.remainingSeconds || 0)), Number(Boolean(payload.submitted)),
    incomingRevision, updatedAt, deviceId
  ).run();

  const change = await env.DB.prepare(`
    INSERT INTO sync_changes (user_id, device_id, entity_type, entity_id, operation, revision, changed_at)
    VALUES (?, ?, 'practiceSet', ?, 'upsert', ?, ?) RETURNING id
  `).bind(userId, deviceId, id, incomingRevision, updatedAt).first();
  return { conflict: false, changeId: change.id };
}

async function upsertPracticeSetAnswer(env, userId, deviceId, payload) {
  const setId = boundedString(payload.setId, "practiceSetAnswer setId");
  const questionId = boundedString(payload.questionId, "practiceSetAnswer questionId");
  const incomingRevision = Number(payload.revision || 1);
  if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 1) throw new Error("practiceSetAnswer revision is invalid");
  const updatedAt = String(payload.updatedAt || new Date().toISOString());
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("practiceSetAnswer updatedAt is invalid");
  const parent = await env.DB.prepare("SELECT id FROM practice_sets WHERE id = ? AND user_id = ?").bind(setId, userId).first();
  if (!parent) throw new Error("practiceSetAnswer parent set is missing");
  const current = await env.DB.prepare(
    "SELECT revision, updated_at FROM practice_set_answers WHERE set_id = ? AND question_id = ?"
  ).bind(setId, questionId).first();
  const decision = revisionDecision(current, incomingRevision, updatedAt);
  if (!decision.accept) return { ...decision, entityType: "practiceSetAnswer", entityKey: `${setId}:${questionId}`, changeId: null };

  await env.DB.prepare(`
    INSERT INTO practice_set_answers (
      set_id, question_id, selected_answer, is_correct, is_flagged, time_ms,
      answered_at, revision, updated_at, updated_by_device
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(set_id, question_id) DO UPDATE SET
      selected_answer = excluded.selected_answer, is_correct = excluded.is_correct,
      is_flagged = excluded.is_flagged, time_ms = excluded.time_ms,
      answered_at = excluded.answered_at, revision = excluded.revision,
      updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device
  `).bind(
    setId, questionId, payload.selectedAnswer == null ? null : String(payload.selectedAnswer).slice(0, 20),
    payload.isCorrect == null ? null : Number(Boolean(payload.isCorrect)), Number(Boolean(payload.isFlagged)),
    Math.max(0, Number(payload.timeMs || 0)), payload.answeredAt || updatedAt,
    incomingRevision, updatedAt, deviceId
  ).run();

  const change = await env.DB.prepare(`
    INSERT INTO sync_changes (user_id, device_id, entity_type, entity_id, operation, revision, changed_at)
    VALUES (?, ?, 'practiceSetAnswer', ?, 'upsert', ?, ?) RETURNING id
  `).bind(userId, deviceId, `${setId}:${questionId}`, incomingRevision, updatedAt).first();
  return { conflict: false, changeId: change.id };
}

async function handleSyncPush(request, env) {
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  const body = await parseBoundedJson(request);
  if (!Array.isArray(body.changes)) throw json({ error: "changes must be an array" }, 400);
  if (body.changes.length > SYNC_LIMITS.maxPushChanges) {
    throw json({ error: `A synchronization batch may contain at most ${SYNC_LIMITS.maxPushChanges} changes` }, 400);
  }
  const changes = body.changes;
  await ensureUserAndDevice(env, userId, deviceId);
  await reserveUsage(env, {
    requests: 1,
    writeActions: changes.length ? 1 : 0,
    rowsRead: changes.length + (changes.length ? 1 : 0),
    rowsWritten: changes.length * 3 + (changes.length ? 2 : 0),
  });

  if (!changes.length) return json({ acceptedIds: [], conflicts: [] });
  const acceptedIds = [];
  const conflicts = [];

  for (const change of changes) {
    try {
      if (change.operation !== "upsert") {
        conflicts.push({ id: change.id, reason: "unsupported-change-type" });
        continue;
      }
      const handlers = {
        questionProgress: upsertQuestionProgress,
        practiceSet: upsertPracticeSet,
        practiceSetAnswer: upsertPracticeSetAnswer,
      };
      const handler = handlers[change.entityType];
      if (!handler) {
        conflicts.push({ id: change.id, reason: "unsupported-change-type" });
        continue;
      }
      const result = await handler(env, userId, deviceId, change.payload || {});
      if (result.conflict) conflicts.push({ id: change.id, ...result });
      else acceptedIds.push(change.id);
    } catch (error) {
      if (error instanceof Response) throw error;
      conflicts.push({ id: change.id, reason: error.message || "invalid-change" });
    }
  }

  return json({ acceptedIds, conflicts });
}

async function handleSyncPull(request, env) {
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);
  await reserveUsage(env, {
    requests: 1,
    rowsRead: SYNC_LIMITS.maxPullRows + 1,
    rowsWritten: 2,
  });
  const url = new URL(request.url);
  const rawCursor = Number(url.searchParams.get("cursor") || 0);
  const cursor = Number.isSafeInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
  const rows = await env.DB.prepare(`
    SELECT sc.id, sc.entity_type, sc.entity_id, sc.operation, sc.revision, sc.changed_at,
           qp.bank_id, qp.question_id, qp.selected_answer, qp.is_correct, qp.is_flagged,
           qp.times_used, qp.total_time_ms, qp.last_used_at, qp.updated_at, qp.updated_by_device
           ,ps.id AS ps_id, ps.bank_id AS ps_bank_id, ps.name AS ps_name, ps.mode AS ps_mode,
           ps.status AS ps_status, ps.started_at AS ps_started_at, ps.completed_at AS ps_completed_at,
           ps.elapsed_ms AS ps_elapsed_ms, ps.question_ids_json AS ps_question_ids_json,
           ps.timed AS ps_timed, ps.current_index AS ps_current_index,
           ps.remaining_seconds AS ps_remaining_seconds, ps.submitted AS ps_submitted,
           ps.updated_at AS ps_updated_at, ps.updated_by_device AS ps_updated_by_device,
           pa.set_id AS pa_set_id, pa.question_id AS pa_question_id,
           pa.selected_answer AS pa_selected_answer, pa.is_correct AS pa_is_correct,
           pa.is_flagged AS pa_is_flagged, pa.time_ms AS pa_time_ms,
           pa.answered_at AS pa_answered_at, pa.updated_at AS pa_updated_at,
           pa.updated_by_device AS pa_updated_by_device
    FROM sync_changes sc
    LEFT JOIN question_progress qp
      ON sc.user_id = qp.user_id
      AND sc.entity_type = 'questionProgress'
      AND sc.entity_id = qp.bank_id || ':' || qp.question_id
    LEFT JOIN practice_sets ps
      ON sc.user_id = ps.user_id
      AND sc.entity_type = 'practiceSet'
      AND sc.entity_id = ps.id
    LEFT JOIN practice_set_answers pa
      ON sc.entity_type = 'practiceSetAnswer'
      AND sc.entity_id = pa.set_id || ':' || pa.question_id
    LEFT JOIN practice_sets pa_owner
      ON pa_owner.id = pa.set_id AND pa_owner.user_id = sc.user_id
    WHERE sc.user_id = ? AND sc.id > ? AND (sc.device_id IS NULL OR sc.device_id != ?)
    ORDER BY sc.id ASC
    LIMIT ${SYNC_LIMITS.maxPullRows}
  `).bind(userId, cursor, deviceId).all();

  const changes = rows.results.map((row) => {
    let payload = null;
    if (row.entity_type === "questionProgress") payload = {
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
    };
    if (row.entity_type === "practiceSet") payload = {
      id: row.ps_id,
      bankId: row.ps_bank_id,
      name: row.ps_name,
      mode: row.ps_mode,
      status: row.ps_status,
      startedAt: row.ps_started_at,
      completedAt: row.ps_completed_at,
      elapsedMs: row.ps_elapsed_ms,
      questionIds: JSON.parse(row.ps_question_ids_json || "[]"),
      timed: Boolean(row.ps_timed),
      index: row.ps_current_index,
      remainingSeconds: row.ps_remaining_seconds,
      submitted: Boolean(row.ps_submitted),
      revision: row.revision,
      updatedAt: row.ps_updated_at,
      deviceId: row.ps_updated_by_device,
    };
    if (row.entity_type === "practiceSetAnswer" && row.pa_set_id) payload = {
      setId: row.pa_set_id,
      questionId: row.pa_question_id,
      selectedAnswer: row.pa_selected_answer,
      isCorrect: row.pa_is_correct == null ? null : Boolean(row.pa_is_correct),
      isFlagged: Boolean(row.pa_is_flagged),
      timeMs: row.pa_time_ms,
      answeredAt: row.pa_answered_at,
      revision: row.revision,
      updatedAt: row.pa_updated_at,
      deviceId: row.pa_updated_by_device,
    };
    return {
      id: row.id,
      entityType: row.entity_type,
      entityKey: row.entity_id,
      operation: row.operation,
      revision: row.revision,
      changedAt: row.changed_at,
      payload,
    };
  }).filter((change) => change.payload);

  return json({
    changes,
    nextCursor: changes.length ? String(changes.at(-1).id) : String(cursor),
  });
}

async function routeApi(request, env) {
  const url = new URL(request.url);

  const deckResponse = await handleDeckLibraryRequest(request, env, {
    json,
    requireSyncReady,
    requireContext,
    reserveUsage,
    ensureUserAndDevice,
  });
  if (deckResponse) return deckResponse;

  const starterSourceResponse = await handleStarterDeckSourceRequest(request, env, {
    json,
    requireSyncReady,
    requireContext,
    reserveUsage,
    ensureUserAndDevice,
  });
  if (starterSourceResponse) return starterSourceResponse;

  const assistantResponse = await handleAssistantWeaknessRequest(request, env, {
    json,
    requireSyncReady,
    requireContext,
    ensureUserAndDevice,
    parseBoundedJson,
  });
  if (assistantResponse) return assistantResponse;

  if (request.method === "GET" && url.pathname === "/api/health") return handleHealth(env);
  if (request.method === "DELETE" && url.pathname === "/api/staging/session") {
    return handleStagingSessionReset(request, env);
  }
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
            ? json({ error: "Application setup is not complete", localOnly: true }, 503)
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
      return withSecurityHeaders(json({ error: "Internal server error", localOnly: true }, 500));
    }
  },
};
