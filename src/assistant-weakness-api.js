const MAX_DECKS = 20;
const MAX_DOMAINS = 100;
const MAX_COACHING_ITEMS = 200;
const MAX_COMPLETED_TESTS = 100;
const CONSENT_VERSION = 2;
// The schema keeps an internal non-null timestamp for compatibility. This
// sentinel represents the user-selected policy "until revoked" and is never
// presented as a real expiration date.
const UNTIL_REVOKED_AT = "9999-12-31T23:59:59.999Z";

function assistantFeatureEnabled(env) {
  return ["staging", "production"].includes(env.APP_ENV) && env.ASSISTANT_WEAKNESS_ENABLED === "true";
}

function requireFeature(env, json) {
  if (!assistantFeatureEnabled(env)) {
    throw json({ error: "Study Coach access is not enabled in this environment" }, 404);
  }
}

function finiteRatio(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${field} is invalid`);
  return number;
}

// Validate and rebuild the content-aware coaching payload from an explicit
// allowlist. Credentials and unrelated browser/device data can never cross
// this boundary, even if a browser caller is compromised.
export function sanitizeStudyCoachDataset(input) {
  if (!input || input.schemaVersion !== 2 || input.consentVersion !== CONSENT_VERSION
    || !Array.isArray(input.decks) || input.decks.length > MAX_DECKS
    || !Array.isArray(input.coachingItems) || input.coachingItems.length > MAX_COACHING_ITEMS) {
    throw new Error("Study Coach dataset schema is invalid");
  }
  const generatedAt = String(input.generatedAt || "");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generatedAt is invalid");
  const text = (value, field, maximum, required = true) => {
    const result = String(value || "").trim();
    if ((required && !result) || result.length > maximum) throw new Error(`${field} is invalid`);
    return result;
  };
  const integer = (value) => Math.max(0, Math.trunc(Number(value || 0)));
  const answer = (value, field) => {
    if (value == null || value === "") return null;
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 12) throw new Error(`${field} is invalid`);
    return values.map((entry) => text(entry, field, 20));
  };
  return {
    schemaVersion: 2,
    consentVersion: CONSENT_VERSION,
    generatedAt,
    selectionPolicy: text(input.selectionPolicy, "selectionPolicy", 100),
    decks: input.decks.map((deck) => ({
      id: text(deck.id, "deck.id", 100),
      title: text(deck.title, "deck.title", 200),
      version: text(deck.version, "deck.version", 100),
      totalQuestions: integer(deck.totalQuestions),
      usedQuestions: integer(deck.usedQuestions),
      domains: Array.isArray(deck.domains) && deck.domains.length <= MAX_DOMAINS ? deck.domains.map((domain) => ({
        title: text(domain.title, "domain.title", 200),
        totalQuestions: integer(domain.totalQuestions),
        usedQuestions: integer(domain.usedQuestions),
        attempts: integer(domain.attempts),
        accuracy: finiteRatio(domain.accuracy, "domain.accuracy"),
        averageTimeMs: domain.averageTimeMs == null ? null : integer(domain.averageTimeMs),
        evidence: ["none", "limited", "adequate"].includes(domain.evidence) ? domain.evidence : "none",
        priorityScore: domain.priorityScore == null ? null : Math.max(0, Math.min(100, integer(domain.priorityScore))),
        mastered: Boolean(domain.mastered),
      })) : (() => { throw new Error("deck.domains is invalid"); })(),
    })),
    completedTests: Array.isArray(input.completedTests) && input.completedTests.length <= MAX_COMPLETED_TESTS
      ? input.completedTests.map((set) => ({
        setId: text(set.setId, "completedTest.setId", 200),
        bankIds: Array.isArray(set.bankIds) && set.bankIds.length <= MAX_DECKS
          ? set.bankIds.map((id) => text(id, "completedTest.bankId", 100))
          : (() => { throw new Error("completedTest.bankIds is invalid"); })(),
        mode: set.mode === "tutor" ? "tutor" : "test",
        timed: Boolean(set.timed),
        startedAt: set.startedAt == null ? null : text(set.startedAt, "completedTest.startedAt", 40),
        completedAt: set.completedAt == null ? null : text(set.completedAt, "completedTest.completedAt", 40),
        questionCount: integer(set.questionCount),
        answered: integer(set.answered),
        correct: integer(set.correct),
        incorrect: integer(set.incorrect),
        omitted: integer(set.omitted),
        totalTimeMs: integer(set.totalTimeMs),
      }))
      : (() => { throw new Error("completedTests is invalid"); })(),
    coachingItems: input.coachingItems.map((item) => ({
      bankId: text(item.bankId, "coachingItem.bankId", 100),
      questionId: text(item.questionId, "coachingItem.questionId", 200),
      subject: text(item.subject, "coachingItem.subject", 200),
      testSection: text(item.testSection, "coachingItem.testSection", 200),
      prompt: text(item.prompt, "coachingItem.prompt", 20_000),
      vignetteStem: text(item.vignetteStem, "coachingItem.vignetteStem", 20_000, false),
      choices: Array.isArray(item.choices) && item.choices.length >= 2 && item.choices.length <= 12
        ? item.choices.map((choice) => ({ letter: text(choice.letter, "choice.letter", 20), text: text(choice.text, "choice.text", 10_000) }))
        : (() => { throw new Error("coachingItem.choices is invalid"); })(),
      selectedAnswer: answer(item.selectedAnswer, "selectedAnswer"),
      correctAnswer: answer(item.correctAnswer, "correctAnswer"),
      answerText: text(item.answerText, "answerText", 20_000, false),
      explanation: text(item.explanation, "explanation", 30_000),
      note: text(item.note, "note", 20_000, false),
      isCorrect: item.isCorrect == null ? null : Boolean(item.isCorrect),
      isFlagged: Boolean(item.isFlagged),
      timesUsed: integer(item.timesUsed),
      totalTimeMs: integer(item.totalTimeMs),
      lastUsedAt: item.lastUsedAt == null ? null : text(item.lastUsedAt, "lastUsedAt", 40),
    })),
    totalEligibleCoachingItems: integer(input.totalEligibleCoachingItems),
    truncated: Boolean(input.truncated),
  };
}

async function status(env, userId) {
  const row = await env.DB.prepare(`
    SELECT enabled, consent_version, granted_at, expires_at, revoked_at, publish_count, access_count,
           delete_count, last_accessed_at
    FROM assistant_weakness_permissions WHERE user_id = ?
  `).bind(userId).first();
  const snapshot = await env.DB.prepare(
    "SELECT user_id, generated_at FROM assistant_weakness_snapshots WHERE user_id = ?"
  ).bind(userId).first();
  const enabled = Boolean(row?.enabled) && Number(row?.consent_version || 0) === CONSENT_VERSION;
  return {
    enabled,
    grantedAt: row?.granted_at || null,
    retention: enabled ? "until-revoked" : null,
    expiresAt: null,
    revokedAt: row?.revoked_at || null,
    snapshotPresent: Boolean(snapshot),
    lastPublishedAt: snapshot?.generated_at || null,
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
  if (!url.pathname.startsWith("/api/assistant/study-coach")) return null;
  requireFeature(env, json);
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);

  if (url.pathname === "/api/assistant/study-coach/permission" && request.method === "GET") {
    return json(await status(env, userId));
  }

  if (url.pathname === "/api/assistant/study-coach/permission" && request.method === "PUT") {
    const body = await parseBoundedJson(request);
    const enabled = body.enabled === true && body.consentVersion === CONSENT_VERSION;
    const now = new Date();
    await env.DB.prepare(`
      INSERT INTO assistant_weakness_permissions
        (user_id, enabled, consent_version, granted_at, expires_at, revoked_at, publish_count, access_count)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled = excluded.enabled,
        consent_version = excluded.consent_version,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at
    `).bind(userId, Number(enabled), CONSENT_VERSION, enabled ? now.toISOString() : null, enabled ? UNTIL_REVOKED_AT : null, enabled ? null : now.toISOString()).run();
    await audit(env, userId, enabled ? "permission-granted" : "permission-revoked", deviceId);
    return json(await status(env, userId));
  }

  if (url.pathname === "/api/assistant/study-coach/snapshot" && request.method === "POST") {
    const permission = await status(env, userId);
    if (!permission.enabled) return json({ error: "Explicit Study Coach permission is required" }, 403);
    let aggregate;
    try {
      aggregate = sanitizeStudyCoachDataset(await parseBoundedJson(request));
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

  if (url.pathname === "/api/assistant/study-coach/snapshot" && request.method === "GET") {
    const permission = await status(env, userId);
    if (!permission.enabled) return json({ error: "Explicit Study Coach permission is required" }, 403);
    const row = await env.DB.prepare(`
      SELECT payload_json, generated_at FROM assistant_weakness_snapshots
      WHERE user_id = ?
    `).bind(userId).first();
    if (!row) return json({ error: "No current Study Coach dataset" }, 404);
    const accessedAt = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE assistant_weakness_permissions
      SET access_count = access_count + 1, last_accessed_at = ? WHERE user_id = ?
    `).bind(accessedAt, userId).run();
    await audit(env, userId, "snapshot-accessed", deviceId);
    return json({ aggregate: JSON.parse(row.payload_json), generatedAt: row.generated_at, retention: "until-revoked", expiresAt: null });
  }

  if (url.pathname === "/api/assistant/study-coach/snapshot" && request.method === "DELETE") {
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
