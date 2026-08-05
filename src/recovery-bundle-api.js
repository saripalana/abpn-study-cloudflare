const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const CHUNK_CHARACTERS = 220_000;
const RETENTION_MILLISECONDS = 3 * 24 * 60 * 60 * 1000;

const bundlePath = (pathname) => pathname === "/api/recovery/cloudflare"
  || pathname === "/api/recovery/cloudflare/latest";

async function readBoundedText(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BUNDLE_BYTES) throw new Error("Complete recovery bundle exceeds the 25 MiB Cloudflare limit");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("Complete recovery bundle exceeds the 25 MiB Cloudflare limit");
  return { text: new TextDecoder().decode(bytes), bytes: bytes.byteLength };
}

function validateEnvelope(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Recovery bundle is not valid JSON"); }
  if (parsed?.format !== "abpn-study-complete-recovery" || parsed?.schemaVersion !== 1) {
    throw new Error("Recovery bundle format is invalid");
  }
  if (!parsed?.integrity?.digest || !parsed?.manifest || !parsed?.createdAt) {
    throw new Error("Recovery bundle metadata is incomplete");
  }
  return parsed;
}

async function latestBundle(env, userId) {
  return env.DB.prepare(`
    SELECT id, created_at, byte_count, chunk_count, integrity_digest, manifest_json
    FROM complete_recovery_bundles
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(userId).first();
}

export async function handleRecoveryBundleRequest(request, env, helpers) {
  const url = new URL(request.url);
  if (!bundlePath(url.pathname)) return null;
  const { json, requireSyncReady, requireContext, reserveUsage, ensureUserAndDevice } = helpers;
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);

  if (request.method === "GET" && url.pathname === "/api/recovery/cloudflare") {
    await reserveUsage(env, { requests: 1, rowsRead: 4 });
    const rows = await env.DB.prepare(`
      SELECT id, created_at, byte_count, integrity_digest, manifest_json
      FROM complete_recovery_bundles WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 4
    `).bind(userId).all();
    return json({ backups: rows.results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      byteCount: Number(row.byte_count),
      integrityDigest: row.integrity_digest,
      manifest: JSON.parse(row.manifest_json),
    })) });
  }

  if (request.method === "GET" && url.pathname === "/api/recovery/cloudflare/latest") {
    const record = await latestBundle(env, userId);
    if (!record) return json({ error: "No Cloudflare recovery backup exists" }, 404);
    await reserveUsage(env, { requests: 1, rowsRead: Number(record.chunk_count) + 1 });
    const chunks = await env.DB.prepare(`
      SELECT chunk_text FROM complete_recovery_chunks
      WHERE bundle_id = ? ORDER BY chunk_index ASC
    `).bind(record.id).all();
    if (chunks.results.length !== Number(record.chunk_count)) return json({ error: "Cloudflare recovery backup is incomplete" }, 500);
    return new Response(chunks.results.map((row) => row.chunk_text).join(""), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (request.method === "PUT" && url.pathname === "/api/recovery/cloudflare") {
    const body = await readBoundedText(request);
    const bundle = validateEnvelope(body.text);
    const chunks = [];
    for (let start = 0; start < body.text.length; start += CHUNK_CHARACTERS) chunks.push(body.text.slice(start, start + CHUNK_CHARACTERS));
    if (chunks.length > 120) throw new Error("Complete recovery bundle requires too many storage chunks");
    await reserveUsage(env, { requests: 1, writeActions: 1, rowsRead: 2, rowsWritten: chunks.length + 2 });
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const utcDay = createdAt.slice(0, 10);
    const cutoff = new Date(Date.now() - RETENTION_MILLISECONDS).toISOString();
    const prior = await env.DB.prepare("SELECT id FROM complete_recovery_bundles WHERE user_id = ? AND utc_day = ?").bind(userId, utcDay).first();
    const expired = await env.DB.prepare("SELECT id FROM complete_recovery_bundles WHERE user_id = ? AND created_at < ?").bind(userId, cutoff).all();
    const deleteIds = [...new Set([prior?.id, ...expired.results.map((row) => row.id)].filter(Boolean))];
    const statements = [];
    for (const deleteId of deleteIds) {
      statements.push(env.DB.prepare("DELETE FROM complete_recovery_chunks WHERE bundle_id = ?").bind(deleteId));
      statements.push(env.DB.prepare("DELETE FROM complete_recovery_bundles WHERE id = ? AND user_id = ?").bind(deleteId, userId));
    }
    statements.push(env.DB.prepare(`
      INSERT INTO complete_recovery_bundles
        (id, user_id, utc_day, created_at, byte_count, chunk_count, integrity_digest, manifest_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, userId, utcDay, createdAt, body.bytes, chunks.length, bundle.integrity.digest, JSON.stringify(bundle.manifest)));
    chunks.forEach((chunk, index) => statements.push(
      env.DB.prepare("INSERT INTO complete_recovery_chunks (bundle_id, chunk_index, chunk_text) VALUES (?, ?, ?)").bind(id, index, chunk)
    ));
    await env.DB.batch(statements);
    return json({ ok: true, id, createdAt, byteCount: body.bytes, manifest: bundle.manifest, retention: "one-per-day-for-three-days" });
  }

  return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT" });
}
