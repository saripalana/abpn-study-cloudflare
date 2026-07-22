const MAX_DECK_PACKAGE_BYTES = 20 * 1024 * 1024;
const CHUNK_CHARACTERS = 240_000;
const MAX_CHUNKS = 96;
const MAX_DECKS = 50;

const safeId = (value) => {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(id)) throw new Error("Deck id is invalid");
  return id;
};

const safeText = (value, field, maxLength, required = true) => {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text;
};

async function readBoundedText(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_DECK_PACKAGE_BYTES) throw new Error("Deck package exceeds the 20 MiB cloud-library limit");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_DECK_PACKAGE_BYTES) throw new Error("Deck package exceeds the 20 MiB cloud-library limit");
  return { text: new TextDecoder().decode(bytes), bytes: bytes.byteLength };
}

function validatePackage(parsed, expectedId) {
  if (!parsed || parsed.format !== "abpn-question-bank" || parsed.schemaVersion !== 1) {
    throw new Error("Deck package format is invalid");
  }
  const bank = parsed.bank;
  if (!bank || typeof bank !== "object") throw new Error("Deck package bank is missing");
  const id = safeId(bank.id);
  if (id !== expectedId) throw new Error("Deck id does not match the request path");
  if (bank.protected) throw new Error("Protected built-in decks cannot be replaced through the deck library");
  if (!Array.isArray(bank.questions) || !bank.questions.length || bank.questions.length > 5000) {
    throw new Error("Deck must contain between 1 and 5,000 questions");
  }
  return {
    id,
    title: safeText(bank.title, "Deck title", 200),
    shortTitle: safeText(bank.shortTitle || bank.title, "Deck short title", 100),
    description: safeText(bank.description || "", "Deck description", 2000, false),
    version: safeText(bank.version, "Deck version", 50),
    sourceType: safeText(bank.sourceType, "Deck source type", 50),
    contentClass: safeText(bank.contentClass, "Deck content class", 50),
    sourceLabel: safeText(bank.sourceLabel || "", "Deck source label", 300, false),
    checksum: safeText(bank.checksum || parsed.checksum, "Deck checksum", 128),
    questionCount: bank.questions.length,
  };
}

function deckPath(url) {
  const prefix = "/api/decks/";
  if (!url.pathname.startsWith(prefix)) return null;
  const encoded = url.pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  return safeId(decodeURIComponent(encoded));
}

export async function handleDeckLibraryRequest(request, env, helpers) {
  const { json, requireSyncReady, requireContext, reserveUsage, ensureUserAndDevice } = helpers;
  const url = new URL(request.url);
  if (url.pathname !== "/api/decks" && !url.pathname.startsWith("/api/decks/")) return null;

  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);

  if (request.method === "GET" && url.pathname === "/api/decks") {
    await reserveUsage(env, { requests: 1, rowsRead: MAX_DECKS, rowsWritten: 0 });
    await ensureUserAndDevice(env, userId, deviceId);
    const rows = await env.DB.prepare(`
      SELECT deck_id, title, short_title, description, version, source_type, content_class,
             source_label, checksum, question_count, package_bytes, chunk_count, created_at, updated_at
      FROM deck_packages WHERE user_id = ? ORDER BY title COLLATE NOCASE LIMIT ${MAX_DECKS}
    `).bind(userId).all();
    return json({ decks: rows.results.map((row) => ({
      id: row.deck_id,
      title: row.title,
      shortTitle: row.short_title,
      description: row.description,
      version: row.version,
      sourceType: row.source_type,
      contentClass: row.content_class,
      sourceLabel: row.source_label,
      checksum: row.checksum,
      questionCount: Number(row.question_count),
      packageBytes: Number(row.package_bytes),
      updatedAt: row.updated_at,
    })) });
  }

  const deckId = deckPath(url);
  if (!deckId) return json({ error: "Invalid deck path" }, 400);

  if (request.method === "GET") {
    const metadata = await env.DB.prepare(
      "SELECT chunk_count FROM deck_packages WHERE user_id = ? AND deck_id = ?"
    ).bind(userId, deckId).first();
    if (!metadata) return json({ error: "Deck not found" }, 404);
    await reserveUsage(env, { requests: 1, rowsRead: Number(metadata.chunk_count) + 1, rowsWritten: 0 });
    await ensureUserAndDevice(env, userId, deviceId);
    const chunks = await env.DB.prepare(`
      SELECT chunk_text FROM deck_package_chunks
      WHERE user_id = ? AND deck_id = ? ORDER BY chunk_index ASC
    `).bind(userId, deckId).all();
    return new Response(chunks.results.map((row) => row.chunk_text).join(""), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (request.method === "PUT") {
    const existing = await env.DB.prepare(
      "SELECT chunk_count, version, checksum FROM deck_packages WHERE user_id = ? AND deck_id = ?"
    ).bind(userId, deckId).first();
    const body = await readBoundedText(request);
    let parsed;
    try { parsed = JSON.parse(body.text); } catch { throw new Error("Deck package is not valid JSON"); }
    const bank = validatePackage(parsed, deckId);

    if (existing?.checksum === bank.checksum) {
      return json({ ok: true, unchanged: true, deck: { ...bank, chunkCount: Number(existing.chunk_count) } });
    }
    if (existing && String(existing.version) === bank.version) {
      return json({
        error: "Deck content changed without a new version. Increase the deck version before updating it.",
      }, 409);
    }
    if (!existing) {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS deck_count FROM deck_packages WHERE user_id = ?"
      ).bind(userId).first();
      if (Number(count?.deck_count || 0) >= MAX_DECKS) {
        return json({ error: `The Deck Library may contain at most ${MAX_DECKS} user-added decks.` }, 409);
      }
    }

    const chunks = [];
    for (let index = 0; index < body.text.length; index += CHUNK_CHARACTERS) {
      chunks.push(body.text.slice(index, index + CHUNK_CHARACTERS));
    }
    if (!chunks.length || chunks.length > MAX_CHUNKS) throw new Error("Deck package requires too many storage chunks");

    await reserveUsage(env, {
      requests: 1,
      writeActions: 1,
      rowsRead: existing ? 1 : 2,
      rowsWritten: chunks.length + Number(existing?.chunk_count || 0) + 2,
    });
    await ensureUserAndDevice(env, userId, deviceId);
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare("DELETE FROM deck_package_chunks WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
      env.DB.prepare(`
        INSERT INTO deck_packages (
          user_id, deck_id, title, short_title, description, version, source_type, content_class,
          source_label, checksum, question_count, package_bytes, chunk_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, deck_id) DO UPDATE SET
          title = excluded.title, short_title = excluded.short_title, description = excluded.description,
          version = excluded.version, source_type = excluded.source_type, content_class = excluded.content_class,
          source_label = excluded.source_label, checksum = excluded.checksum,
          question_count = excluded.question_count, package_bytes = excluded.package_bytes,
          chunk_count = excluded.chunk_count, updated_at = excluded.updated_at
      `).bind(
        userId, deckId, bank.title, bank.shortTitle, bank.description, bank.version, bank.sourceType,
        bank.contentClass, bank.sourceLabel, bank.checksum, bank.questionCount, body.bytes, chunks.length,
        now, now
      ),
      ...chunks.map((chunk, index) => env.DB.prepare(`
        INSERT INTO deck_package_chunks (user_id, deck_id, chunk_index, chunk_text)
        VALUES (?, ?, ?, ?)
      `).bind(userId, deckId, index, chunk)),
    ];
    await env.DB.batch(statements);
    return json({ ok: true, deck: { ...bank, packageBytes: body.bytes, chunkCount: chunks.length, updatedAt: now } });
  }

  if (request.method === "DELETE") {
    const existing = await env.DB.prepare(
      "SELECT chunk_count FROM deck_packages WHERE user_id = ? AND deck_id = ?"
    ).bind(userId, deckId).first();
    if (!existing) return json({ ok: true, deleted: false });
    await reserveUsage(env, {
      requests: 1,
      writeActions: 1,
      rowsRead: 1,
      rowsWritten: Number(existing.chunk_count) + 2,
    });
    await ensureUserAndDevice(env, userId, deviceId);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deck_package_chunks WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
      env.DB.prepare("DELETE FROM deck_packages WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
    ]);
    return json({ ok: true, deleted: true });
  }

  return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT, DELETE" });
}

export const DECK_LIBRARY_LIMITS = Object.freeze({
  maximumPackageBytes: MAX_DECK_PACKAGE_BYTES,
  maximumDecks: MAX_DECKS,
  maximumChunks: MAX_CHUNKS,
});
