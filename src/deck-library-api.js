const MAX_DECK_PACKAGE_BYTES = 20 * 1024 * 1024;
const CHUNK_CHARACTERS = 240_000;
const MAX_CHUNKS = 96;
const MAX_DECKS = 50;
const MAX_REVISIONS_PER_DECK = 100;
const MAX_BOOTSTRAP_BODY_BYTES = 4 * 1024;

const safeId = (value) => {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(id)) throw new Error("Deck id is invalid");
  return id;
};

const safeChecksum = (value) => {
  const checksum = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(checksum)) throw new Error("Deck checksum is invalid");
  return checksum;
};

const safeText = (value, field, maxLength, required = true) => {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text;
};

async function readBoundedText(
  request,
  maximumBytes = MAX_DECK_PACKAGE_BYTES,
  limitMessage = "Deck package exceeds the 20 MiB cloud-library limit",
) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maximumBytes) throw new Error(limitMessage);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw new Error(limitMessage);
  return { text: new TextDecoder().decode(bytes), bytes: bytes.byteLength };
}

async function readJson(request, maximumBytes = 16 * 1024, limitMessage) {
  const body = await readBoundedText(request, maximumBytes, limitMessage);
  try {
    return JSON.parse(body.text);
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function validatePackage(parsed, expectedId) {
  if (!parsed || parsed.format !== "abpn-question-bank" || parsed.schemaVersion !== 1) {
    throw new Error("Deck package format is invalid");
  }
  const bank = parsed.bank;
  if (!bank || typeof bank !== "object") throw new Error("Deck package bank is missing");
  const id = safeId(bank.id);
  if (id !== expectedId) throw new Error("Deck id does not match the request path");
  if (bank.protected) throw new Error("Deck packages must use the shared immutable revision protection contract");
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
    checksum: safeChecksum(bank.checksum || parsed.checksum),
    questionCount: bank.questions.length,
    importedAt: safeText(bank.importedAt || new Date().toISOString(), "Deck importedAt", 100),
  };
}

function routeParts(url) {
  if (url.pathname === "/api/decks") return [];
  const prefix = "/api/decks/";
  if (!url.pathname.startsWith(prefix)) return null;
  const raw = url.pathname.slice(prefix.length).split("/").filter(Boolean);
  if (!raw.length) return null;
  return raw.map((part) => decodeURIComponent(part));
}

function revisionMetadata(row) {
  return {
    checksum: row.checksum,
    version: row.version,
    title: row.title,
    shortTitle: row.short_title,
    description: row.description,
    sourceType: row.source_type,
    contentClass: row.content_class,
    sourceLabel: row.source_label,
    questionCount: Number(row.question_count),
    packageBytes: Number(row.package_bytes),
    chunkCount: Number(row.chunk_count),
    importedAt: row.imported_at,
    createdAt: row.created_at,
  };
}

async function getHead(env, userId, deckId) {
  return env.DB.prepare(`
    SELECT r.*, h.updated_at AS head_updated_at
    FROM deck_package_heads AS h
    JOIN deck_package_revisions AS r
      ON r.user_id = h.user_id
     AND r.deck_id = h.deck_id
     AND r.checksum = h.checksum
    WHERE h.user_id = ? AND h.deck_id = ?
  `).bind(userId, deckId).first();
}

async function getRevision(env, userId, deckId, checksum) {
  return env.DB.prepare(`
    SELECT *
    FROM deck_package_revisions
    WHERE user_id = ? AND deck_id = ? AND checksum = ?
  `).bind(userId, deckId, checksum).first();
}

async function packageResponse(env, userId, deckId, revision) {
  const chunks = await env.DB.prepare(`
    SELECT chunk_text
    FROM deck_package_revision_chunks
    WHERE user_id = ? AND deck_id = ? AND checksum = ?
    ORDER BY chunk_index ASC
  `).bind(userId, deckId, revision.checksum).all();
  if (chunks.results.length !== Number(revision.chunk_count)) {
    return new Response(JSON.stringify({ error: "Deck revision is incomplete" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(chunks.results.map((row) => row.chunk_text).join(""), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleDeckLibraryRequest(request, env, helpers) {
  const { json, requireSyncReady, requireContext, reserveUsage, ensureUserAndDevice } = helpers;
  const url = new URL(request.url);
  const parts = routeParts(url);
  if (parts === null) return null;

  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);

  // Bootstrap state tracks preparation only. It never changes deck content and
  // keeps the internal validation fixture governed by its existing protections.
  if (parts.length === 1 && parts[0] === "bootstrap") {
    if (request.method === "GET") {
      await ensureUserAndDevice(env, userId, deviceId);
      await reserveUsage(env, { requests: 1, rowsRead: 1, rowsWritten: 0 });
      const state = await env.DB.prepare(
        "SELECT bootstrap_version, completed_at, updated_at FROM deck_library_state WHERE user_id = ?"
      ).bind(userId).first();
      return json({
        version: state?.bootstrap_version || "",
        completedAt: state?.completed_at || null,
        updatedAt: state?.updated_at || null,
      });
    }
    if (request.method === "PUT") {
      const parsed = await readJson(
        request,
        MAX_BOOTSTRAP_BODY_BYTES,
        "Deck bootstrap request exceeds the 4 KiB limit",
      );
      const version = safeText(parsed?.version, "Deck bootstrap version", 100);
      await ensureUserAndDevice(env, userId, deviceId);
      await reserveUsage(env, { requests: 1, writeActions: 1, rowsRead: 1, rowsWritten: 1 });
      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO deck_library_state (user_id, bootstrap_version, completed_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          bootstrap_version = excluded.bootstrap_version,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `).bind(userId, version, now, now).run();
      return json({ ok: true, version, completedAt: now, updatedAt: now });
    }
    return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT" });
  }

  if (request.method === "GET" && parts.length === 0) {
    await ensureUserAndDevice(env, userId, deviceId);
    await reserveUsage(env, { requests: 1, rowsRead: MAX_DECKS, rowsWritten: 0 });
    const rows = await env.DB.prepare(`
      SELECT r.*, h.updated_at AS head_updated_at
      FROM deck_package_heads AS h
      JOIN deck_package_revisions AS r
        ON r.user_id = h.user_id
       AND r.deck_id = h.deck_id
       AND r.checksum = h.checksum
      WHERE h.user_id = ?
      ORDER BY r.title COLLATE NOCASE
      LIMIT ${MAX_DECKS}
    `).bind(userId).all();
    return json({ decks: rows.results.map((row) => ({
      id: row.deck_id,
      ...revisionMetadata(row),
      updatedAt: row.head_updated_at,
    })) });
  }

  if (parts.length < 1) return json({ error: "Invalid deck path" }, 400);
  const deckId = safeId(parts[0]);

  if (request.method === "GET" && parts.length === 1) {
    const head = await getHead(env, userId, deckId);
    if (!head) return json({ error: "Deck not found" }, 404);
    await ensureUserAndDevice(env, userId, deviceId);
    await reserveUsage(env, { requests: 1, rowsRead: Number(head.chunk_count) + 1, rowsWritten: 0 });
    return packageResponse(env, userId, deckId, head);
  }

  if (request.method === "GET" && parts.length === 2 && parts[1] === "revisions") {
    await ensureUserAndDevice(env, userId, deviceId);
    await reserveUsage(env, { requests: 1, rowsRead: MAX_REVISIONS_PER_DECK, rowsWritten: 0 });
    const head = await env.DB.prepare(
      "SELECT checksum FROM deck_package_heads WHERE user_id = ? AND deck_id = ?"
    ).bind(userId, deckId).first();
    if (!head) return json({ error: "Deck not found" }, 404);
    const rows = await env.DB.prepare(`
      SELECT *
      FROM deck_package_revisions
      WHERE user_id = ? AND deck_id = ?
      ORDER BY created_at DESC
      LIMIT ${MAX_REVISIONS_PER_DECK}
    `).bind(userId, deckId).all();
    return json({
      deckId,
      activeChecksum: head.checksum,
      revisions: rows.results.map((row) => ({
        ...revisionMetadata(row),
        active: row.checksum === head.checksum,
      })),
    });
  }

  if (request.method === "GET" && parts.length === 3 && parts[1] === "revisions") {
    const checksum = safeChecksum(parts[2]);
    const revision = await getRevision(env, userId, deckId, checksum);
    if (!revision) return json({ error: "Deck revision not found" }, 404);
    await ensureUserAndDevice(env, userId, deviceId);
    await reserveUsage(env, { requests: 1, rowsRead: Number(revision.chunk_count) + 1, rowsWritten: 0 });
    return packageResponse(env, userId, deckId, revision);
  }

  if (request.method === "POST" && parts.length === 2 && parts[1] === "restore") {
    const parsed = await readJson(request);
    const checksum = safeChecksum(parsed?.checksum);
    const revision = await getRevision(env, userId, deckId, checksum);
    if (!revision) return json({ error: "Deck revision not found" }, 404);
    await ensureUserAndDevice(env, userId, deviceId);
    await reserveUsage(env, {
      requests: 1,
      writeActions: 1,
      rowsRead: Number(revision.chunk_count) + 1,
      rowsWritten: Number(revision.chunk_count) * 2 + 4,
    });
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO deck_package_heads (user_id, deck_id, checksum, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, deck_id) DO UPDATE SET
          checksum = excluded.checksum,
          updated_at = excluded.updated_at
      `).bind(userId, deckId, checksum, now),
      env.DB.prepare("DELETE FROM deck_package_chunks WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
      env.DB.prepare(`
        INSERT INTO deck_package_chunks (user_id, deck_id, chunk_index, chunk_text)
        SELECT user_id, deck_id, chunk_index, chunk_text
        FROM deck_package_revision_chunks
        WHERE user_id = ? AND deck_id = ? AND checksum = ?
      `).bind(userId, deckId, checksum),
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
        userId, deckId, revision.title, revision.short_title, revision.description, revision.version,
        revision.source_type, revision.content_class, revision.source_label, revision.checksum,
        revision.question_count, revision.package_bytes, revision.chunk_count, revision.created_at, now
      ),
    ]);
    return json({ ok: true, restored: true, deckId, checksum, version: revision.version, updatedAt: now });
  }

  if (request.method === "PUT" && parts.length === 1) {
    const body = await readBoundedText(request);
    let parsed;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      throw new Error("Deck package is not valid JSON");
    }
    const bank = validatePackage(parsed, deckId);
    const existing = await getHead(env, userId, deckId);
    const expectedHeadChecksum = String(request.headers.get("x-abpn-expected-head-checksum") || "").trim();
    const expectNoHead = request.headers.get("x-abpn-expect-no-head") === "true";
    if (expectNoHead && existing) {
      return json({
        error: "Deck head was created before this update. Refresh, reconcile, and retry.",
        currentChecksum: existing.checksum,
      }, 409);
    }
    if (expectedHeadChecksum) {
      safeChecksum(expectedHeadChecksum);
      if (!existing || existing.checksum !== expectedHeadChecksum) {
        return json({
          error: "Deck head changed before this update. Refresh, reconcile, and retry.",
          currentChecksum: existing?.checksum || null,
        }, 409);
      }
    }

    if (existing?.checksum === bank.checksum) {
      return json({
        ok: true,
        unchanged: true,
        deck: { ...bank, chunkCount: Number(existing.chunk_count), updatedAt: existing.head_updated_at },
      });
    }
    if (existing && String(existing.version) === bank.version) {
      return json({
        error: "Deck content changed without a new version. Increase the deck version before updating it.",
      }, 409);
    }
    if (!existing) {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS deck_count FROM deck_package_heads WHERE user_id = ?"
      ).bind(userId).first();
      if (Number(count?.deck_count || 0) >= MAX_DECKS) {
        return json({ error: `The Deck Library may contain at most ${MAX_DECKS} decks.` }, 409);
      }
    }

    const priorRevision = await getRevision(env, userId, deckId, bank.checksum);
    if (priorRevision && priorRevision.version !== bank.version) {
      return json({ error: "A stored revision already uses this checksum with different metadata." }, 409);
    }

    const chunks = [];
    for (let index = 0; index < body.text.length; index += CHUNK_CHARACTERS) {
      chunks.push(body.text.slice(index, index + CHUNK_CHARACTERS));
    }
    if (!chunks.length || chunks.length > MAX_CHUNKS) throw new Error("Deck package requires too many storage chunks");

    const newRevision = !priorRevision;
    await ensureUserAndDevice(env, userId, deviceId);
    await reserveUsage(env, {
      requests: 1,
      writeActions: 1,
      rowsRead: existing ? 2 : 3,
      rowsWritten: (newRevision ? chunks.length + 1 : 0) + chunks.length + 4,
    });
    const now = new Date().toISOString();
    const statements = [];

    if (newRevision) {
      statements.push(
        env.DB.prepare(`
          INSERT INTO deck_package_revisions (
            user_id, deck_id, checksum, version, title, short_title, description, source_type,
            content_class, source_label, question_count, package_bytes, chunk_count, imported_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          userId, deckId, bank.checksum, bank.version, bank.title, bank.shortTitle, bank.description,
          bank.sourceType, bank.contentClass, bank.sourceLabel, bank.questionCount, body.bytes,
          chunks.length, bank.importedAt, now
        ),
        ...chunks.map((chunk, index) => env.DB.prepare(`
          INSERT INTO deck_package_revision_chunks (
            user_id, deck_id, checksum, chunk_index, chunk_text
          ) VALUES (?, ?, ?, ?, ?)
        `).bind(userId, deckId, bank.checksum, index, chunk))
      );
    }

    statements.push(
      env.DB.prepare(`
        INSERT INTO deck_package_heads (user_id, deck_id, checksum, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, deck_id) DO UPDATE SET
          checksum = excluded.checksum,
          updated_at = excluded.updated_at
      `).bind(userId, deckId, bank.checksum, now),
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
        existing?.created_at || now, now
      ),
      ...chunks.map((chunk, index) => env.DB.prepare(`
        INSERT INTO deck_package_chunks (user_id, deck_id, chunk_index, chunk_text)
        VALUES (?, ?, ?, ?)
      `).bind(userId, deckId, index, chunk))
    );

    await env.DB.batch(statements);
    return json({
      ok: true,
      revisionCreated: newRevision,
      deck: { ...bank, packageBytes: body.bytes, chunkCount: chunks.length, updatedAt: now },
    });
  }

  if (request.method === "DELETE" && parts.length === 1) {
    const existing = await getHead(env, userId, deckId);
    if (!existing) return json({ ok: true, deleted: false });
    const revisionSummary = await env.DB.prepare(`
      SELECT COUNT(*) AS revision_count, COALESCE(SUM(chunk_count), 0) AS chunk_count
      FROM deck_package_revisions
      WHERE user_id = ? AND deck_id = ?
    `).bind(userId, deckId).first();
    await ensureUserAndDevice(env, userId, deviceId);
    await reserveUsage(env, {
      requests: 1,
      writeActions: 1,
      rowsRead: 2,
      rowsWritten: Number(revisionSummary?.revision_count || 0) +
        Number(revisionSummary?.chunk_count || 0) + Number(existing.chunk_count || 0) + 4,
    });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deck_package_heads WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
      env.DB.prepare("DELETE FROM deck_package_revisions WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
      env.DB.prepare("DELETE FROM deck_package_chunks WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
      env.DB.prepare("DELETE FROM deck_packages WHERE user_id = ? AND deck_id = ?").bind(userId, deckId),
    ]);
    return json({ ok: true, deleted: true });
  }

  return json({ error: "Method not allowed" }, 405, {
    allow: "GET, PUT, POST, DELETE",
  });
}

export const DECK_LIBRARY_LIMITS = Object.freeze({
  maximumPackageBytes: MAX_DECK_PACKAGE_BYTES,
  maximumDecks: MAX_DECKS,
  maximumChunks: MAX_CHUNKS,
  maximumRevisionsPerDeck: MAX_REVISIONS_PER_DECK,
  maximumBootstrapBodyBytes: MAX_BOOTSTRAP_BODY_BYTES,
});
