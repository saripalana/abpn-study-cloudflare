import {
  MAX_STUDY_COACH_EXCHANGE_BYTES,
  normalizeStudyCoachPackage,
  prepareStudyCoachOutput,
  protectedStudyCoachBanks,
  validateStudyCoachPackage,
} from "./client/study-coach-package.js";

const MAX_DECKS = 20;
const MAX_DOMAINS = 100;
const MAX_COACHING_ITEMS = 200;
const MAX_COMPLETED_TESTS = 100;
const MAX_EXCHANGE_BYTES = MAX_STUDY_COACH_EXCHANGE_BYTES;
const CHUNK_CHARACTERS = 220_000;
const CONSENT_VERSION = 2;
const EXCHANGE_CONSENT_VERSION = 1;
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

async function readBoundedText(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_EXCHANGE_BYTES) throw new Error("Study Coach exchange file exceeds the 25 MiB Cloudflare limit");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_EXCHANGE_BYTES) throw new Error("Study Coach exchange file exceeds the 25 MiB Cloudflare limit");
  return { text: new TextDecoder().decode(bytes), byteCount: bytes.byteLength };
}

function splitChunks(text) {
  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARACTERS) chunks.push(text.slice(start, start + CHUNK_CHARACTERS));
  if (chunks.length > 120) throw new Error("Study Coach exchange file requires too many Cloudflare storage chunks");
  return chunks;
}

function parseArtifactMetadata(row) {
  try {
    return JSON.parse(row.metadata_json || "{}");
  } catch {
    return {};
  }
}

function summarizeArtifact(type, row) {
  if (!row) return null;
  const metadata = parseArtifactMetadata(row);
  return {
    id: row.id,
    createdAt: row.created_at,
    byteCount: Number(row.byte_count || 0),
    chunkCount: Number(row.chunk_count || 0),
    ...(type === "package"
      ? {
        exportedAt: metadata.exportedAt || null,
        bankCount: Number(metadata.bankCount || 0),
        questionCount: Number(metadata.questionCount || 0),
      }
      : {
        generatedAt: metadata.generatedAt || null,
        sourcePackageGeneratedAt: metadata.sourcePackageGeneratedAt || null,
        format: metadata.format || null,
        schemaVersion: Number(metadata.schemaVersion || 0) || null,
      }),
  };
}

async function artifactRows(env, userId) {
  const rows = await env.DB.prepare(`
    SELECT id, artifact_type, created_at, byte_count, chunk_count, metadata_json
    FROM assistant_study_coach_artifacts
    WHERE user_id = ?
  `).bind(userId).all();
  return new Map((rows.results || []).map((row) => [row.artifact_type, row]));
}

async function latestArtifact(env, userId, type) {
  const row = await env.DB.prepare(`
    SELECT id, created_at, byte_count, chunk_count, primary_timestamp, metadata_json
    FROM assistant_study_coach_artifacts
    WHERE user_id = ? AND artifact_type = ?
    LIMIT 1
  `).bind(userId, type).first();
  if (!row) return null;
  const chunks = await env.DB.prepare(`
    SELECT chunk_text FROM assistant_study_coach_artifact_chunks
    WHERE artifact_id = ? ORDER BY chunk_index ASC
  `).bind(row.id).all();
  if ((chunks.results || []).length !== Number(row.chunk_count)) throw new Error("Stored Study Coach exchange file is incomplete");
  return {
    row,
    text: chunks.results.map((entry) => entry.chunk_text).join(""),
  };
}

async function prepareOutputAgainstCurrentPackage(input, env, userId) {
  if (!Array.isArray(input?.generatedDecks) || !input.generatedDecks.length) {
    return prepareStudyCoachOutput(input);
  }
  const record = await latestArtifact(env, userId, "package");
  if (!record) throw new Error("Share a current Study Coach package before publishing generated decks");
  const pkg = normalizeStudyCoachPackage(JSON.parse(record.text));
  const protectedBanks = protectedStudyCoachBanks(pkg.banks);
  if (!protectedBanks.length) throw new Error("The current Study Coach package has no protected source baseline");
  return prepareStudyCoachOutput(input, {
    reservedIds: protectedBanks.map((bank) => bank.id),
    protectedBanks,
  });
}

async function replaceArtifact(env, userId, type, text, byteCount, primaryTimestamp, metadata) {
  const prior = await env.DB.prepare(`
    SELECT id FROM assistant_study_coach_artifacts
    WHERE user_id = ? AND artifact_type = ?
    LIMIT 1
  `).bind(userId, type).first();
  const artifactId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const chunks = splitChunks(text);
  const statements = [];
  if (prior?.id) {
    statements.push(env.DB.prepare(`
      DELETE FROM assistant_study_coach_artifact_chunks WHERE artifact_id = ?
    `).bind(prior.id));
    statements.push(env.DB.prepare(`
      DELETE FROM assistant_study_coach_artifacts WHERE id = ?
    `).bind(prior.id));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO assistant_study_coach_artifacts
      (id, user_id, artifact_type, created_at, byte_count, chunk_count, primary_timestamp, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(artifactId, userId, type, createdAt, byteCount, chunks.length, primaryTimestamp, JSON.stringify(metadata)));
  chunks.forEach((chunk, index) => statements.push(
    env.DB.prepare(`
      INSERT INTO assistant_study_coach_artifact_chunks (artifact_id, chunk_index, chunk_text)
      VALUES (?, ?, ?)
    `).bind(artifactId, index, chunk)
  ));
  await env.DB.batch(statements);
  return summarizeArtifact(type, {
    id: artifactId,
    created_at: createdAt,
    byte_count: byteCount,
    chunk_count: chunks.length,
    metadata_json: JSON.stringify(metadata),
  });
}

async function deleteArtifacts(env, userId) {
  const rows = await env.DB.prepare(`
    SELECT id FROM assistant_study_coach_artifacts WHERE user_id = ?
  `).bind(userId).all();
  const statements = [];
  for (const row of rows.results || []) {
    statements.push(env.DB.prepare(`
      DELETE FROM assistant_study_coach_artifact_chunks WHERE artifact_id = ?
    `).bind(row.id));
    statements.push(env.DB.prepare(`
      DELETE FROM assistant_study_coach_artifacts WHERE id = ?
    `).bind(row.id));
  }
  if (statements.length) await env.DB.batch(statements);
}

async function reserveStudyCoachUsage(reserveUsage, pathname, method) {
  const key = `${method} ${pathname}`;
  const budgets = {
    "GET /api/assistant/study-coach/permission": { requests: 1, rowsRead: 4 },
    "PUT /api/assistant/study-coach/permission": { requests: 1, writeActions: 1, rowsRead: 4, rowsWritten: 2 },
    "POST /api/assistant/study-coach/snapshot": { requests: 1, writeActions: 1, rowsRead: 4, rowsWritten: 3 },
    "GET /api/assistant/study-coach/snapshot": { requests: 1, writeActions: 1, rowsRead: 5, rowsWritten: 2 },
    "DELETE /api/assistant/study-coach/snapshot": { requests: 1, writeActions: 1, rowsRead: 4, rowsWritten: 246 },
    "PUT /api/assistant/study-coach/package": { requests: 1, writeActions: 1, rowsRead: 5, rowsWritten: 245 },
    "GET /api/assistant/study-coach/package": { requests: 1, writeActions: 1, rowsRead: 125, rowsWritten: 2 },
    "PUT /api/assistant/study-coach/output": { requests: 1, writeActions: 1, rowsRead: 5, rowsWritten: 245 },
    "GET /api/assistant/study-coach/output": { requests: 1, writeActions: 1, rowsRead: 125, rowsWritten: 2 },
  };
  await reserveUsage(budgets[key] || { requests: 1, rowsRead: 1 });
}

async function exchangeAudit(env, userId, action, deviceId, { publish = false, access = false } = {}) {
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(`
    INSERT INTO assistant_study_coach_exchange_audit (user_id, action, device_id, occurred_at)
    VALUES (?, ?, ?, ?)
  `).bind(userId, action, deviceId, now)];
  if (publish) {
    statements.push(env.DB.prepare(`
      UPDATE assistant_weakness_permissions
      SET exchange_publish_count = exchange_publish_count + 1 WHERE user_id = ?
    `).bind(userId));
  }
  if (access) {
    statements.push(env.DB.prepare(`
      UPDATE assistant_weakness_permissions
      SET exchange_access_count = exchange_access_count + 1, last_exchange_accessed_at = ? WHERE user_id = ?
    `).bind(now, userId));
  }
  await env.DB.batch(statements);
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
           delete_count, last_accessed_at, exchange_consent_version, exchange_granted_at,
           exchange_publish_count, exchange_access_count, last_exchange_accessed_at
    FROM assistant_weakness_permissions WHERE user_id = ?
  `).bind(userId).first();
  const snapshot = await env.DB.prepare(
    "SELECT user_id, generated_at FROM assistant_weakness_snapshots WHERE user_id = ?"
  ).bind(userId).first();
  const artifacts = await artifactRows(env, userId);
  const latestPackage = summarizeArtifact("package", artifacts.get("package"));
  const latestOutput = summarizeArtifact("output", artifacts.get("output"));
  const enabled = Boolean(row?.enabled) && Number(row?.consent_version || 0) === CONSENT_VERSION;
  const exchangeEnabled = enabled && Number(row?.exchange_consent_version || 0) === EXCHANGE_CONSENT_VERSION;
  return {
    enabled,
    exchangeEnabled,
    exchangeConsentVersion: Number(row?.exchange_consent_version || 0),
    exchangeGrantedAt: row?.exchange_granted_at || null,
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
    exchangePublishCount: Number(row?.exchange_publish_count || 0),
    exchangeAccessCount: Number(row?.exchange_access_count || 0),
    lastExchangeAccessedAt: row?.last_exchange_accessed_at || null,
    packagePresent: Boolean(latestPackage),
    latestPackage,
    outputPresent: Boolean(latestOutput),
    latestOutput,
  };
}

async function audit(env, userId, action, deviceId) {
  await env.DB.prepare(`
    INSERT INTO assistant_weakness_audit (user_id, action, device_id, occurred_at)
    VALUES (?, ?, ?, ?)
  `).bind(userId, action, deviceId, new Date().toISOString()).run();
}

export async function handleAssistantWeaknessRequest(request, env, helpers) {
  const {
    json,
    requireSyncReady,
    requireContext,
    ensureUserAndDevice,
    parseBoundedJson,
    reserveUsage = async () => {},
  } = helpers;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/assistant/study-coach")) return null;
  requireFeature(env, json);
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);
  await reserveStudyCoachUsage(reserveUsage, url.pathname, request.method);

  if (url.pathname === "/api/assistant/study-coach/permission" && request.method === "GET") {
    return json(await status(env, userId));
  }

  if (url.pathname === "/api/assistant/study-coach/permission" && request.method === "PUT") {
    const body = await parseBoundedJson(request);
    const enabled = body.enabled === true && body.consentVersion === CONSENT_VERSION;
    const exchangeEnabled = enabled && body.exchangeConsentVersion === EXCHANGE_CONSENT_VERSION;
    const now = new Date();
    await env.DB.prepare(`
      INSERT INTO assistant_weakness_permissions
        (user_id, enabled, consent_version, granted_at, expires_at, revoked_at, publish_count, access_count,
         exchange_consent_version, exchange_granted_at, exchange_publish_count, exchange_access_count)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled = excluded.enabled,
        consent_version = excluded.consent_version,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at,
        exchange_consent_version = excluded.exchange_consent_version,
        exchange_granted_at = excluded.exchange_granted_at
    `).bind(
      userId,
      Number(enabled),
      CONSENT_VERSION,
      enabled ? now.toISOString() : null,
      enabled ? UNTIL_REVOKED_AT : null,
      enabled ? null : now.toISOString(),
      exchangeEnabled ? EXCHANGE_CONSENT_VERSION : 0,
      exchangeEnabled ? now.toISOString() : null,
    ).run();
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
    await env.DB.prepare("DELETE FROM assistant_weakness_snapshots WHERE user_id = ?").bind(userId).run();
    await deleteArtifacts(env, userId);
    await env.DB.prepare(`
      UPDATE assistant_weakness_permissions
      SET delete_count = delete_count + 1 WHERE user_id = ?
    `).bind(userId).run();
    await exchangeAudit(env, userId, "exchange-deleted", deviceId);
    return json({ ok: true, deleted: true });
  }

  if (url.pathname === "/api/assistant/study-coach/package" && request.method === "PUT") {
    const permission = await status(env, userId);
    if (!permission.exchangeEnabled) return json({ error: "Fresh Study Coach exchange permission is required" }, 403);
    let parsed;
    let normalized;
    let pkg;
    let payload;
    try {
      payload = await readBoundedText(request);
      parsed = JSON.parse(payload.text);
      normalized = normalizeStudyCoachPackage(parsed);
      pkg = validateStudyCoachPackage(normalized);
    } catch (error) {
      return json({ error: error.message || "Study Coach package is invalid" }, 400);
    }
    const canonicalText = JSON.stringify(normalized);
    const canonicalByteCount = new TextEncoder().encode(canonicalText).byteLength;
    const file = await replaceArtifact(env, userId, "package", canonicalText, canonicalByteCount, pkg.exportedAt, {
      exportedAt: pkg.exportedAt,
      bankCount: pkg.bankCount,
      questionCount: pkg.questionCount,
    });
    await exchangeAudit(env, userId, "package-published", deviceId, { publish: true });
    return json({ ok: true, file });
  }

  if (url.pathname === "/api/assistant/study-coach/package" && request.method === "GET") {
    const permission = await status(env, userId);
    if (!permission.exchangeEnabled) return json({ error: "Fresh Study Coach exchange permission is required" }, 403);
    let record;
    try {
      record = await latestArtifact(env, userId, "package");
    } catch (error) {
      return json({ error: error.message || "Stored Study Coach package is incomplete" }, 500);
    }
    if (!record) return json({ error: "No current Study Coach package" }, 404);
    let parsed;
    try {
      parsed = normalizeStudyCoachPackage(JSON.parse(record.text));
      validateStudyCoachPackage(parsed);
    } catch (error) {
      return json({ error: error.message || "Stored Study Coach package is invalid" }, 502);
    }
    await exchangeAudit(env, userId, "package-accessed", deviceId, { access: true });
    return json({
      ok: true,
      file: summarizeArtifact("package", {
        ...record.row,
        metadata_json: record.row.metadata_json,
      }),
      package: parsed,
    });
  }

  if (url.pathname === "/api/assistant/study-coach/output" && request.method === "PUT") {
    const permission = await status(env, userId);
    if (!permission.exchangeEnabled) return json({ error: "Fresh Study Coach exchange permission is required" }, 403);
    let parsed;
    let output;
    let payload;
    try {
      payload = await readBoundedText(request);
      parsed = JSON.parse(payload.text);
      output = await prepareOutputAgainstCurrentPackage(parsed, env, userId);
    } catch (error) {
      return json({ error: error.message || "Study Coach output is invalid" }, 400);
    }
    const canonicalText = JSON.stringify(output);
    const canonicalByteCount = new TextEncoder().encode(canonicalText).byteLength;
    const file = await replaceArtifact(env, userId, "output", canonicalText, canonicalByteCount, output.generatedAt, {
      generatedAt: output.generatedAt,
      sourcePackageGeneratedAt: output.sourcePackageGeneratedAt,
      format: output.format,
      schemaVersion: output.schemaVersion,
    });
    await exchangeAudit(env, userId, "output-published", deviceId, { publish: true });
    return json({ ok: true, file });
  }

  if (url.pathname === "/api/assistant/study-coach/output" && request.method === "GET") {
    const permission = await status(env, userId);
    if (!permission.exchangeEnabled) return json({ error: "Fresh Study Coach exchange permission is required" }, 403);
    let record;
    try {
      record = await latestArtifact(env, userId, "output");
    } catch (error) {
      return json({ error: error.message || "Stored Study Coach output is incomplete" }, 500);
    }
    if (!record) return json({ error: "No current Study Coach output" }, 404);
    let parsed;
    try {
      parsed = JSON.parse(record.text);
      parsed = await prepareOutputAgainstCurrentPackage(parsed, env, userId);
    } catch (error) {
      return json({ error: error.message || "Stored Study Coach output is invalid" }, 502);
    }
    await exchangeAudit(env, userId, "output-accessed", deviceId, { access: true });
    return json({
      ok: true,
      file: summarizeArtifact("output", {
        ...record.row,
        metadata_json: record.row.metadata_json,
      }),
      output: parsed,
    });
  }

  return json({ error: "Not found" }, 404);
}
