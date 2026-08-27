import {
  MAX_STUDY_COACH_EXCHANGE_BYTES,
  normalizeStudyCoachPackage,
  prepareStudyCoachOutput,
  protectedStudyCoachBanks,
  STUDY_COACH_OUTPUT_FORMAT,
  STUDY_COACH_OUTPUT_SCHEMA_VERSION,
  validateStudyCoachPackage,
} from "./client/study-coach-package.js";

const MAX_EXCHANGE_BYTES = MAX_STUDY_COACH_EXCHANGE_BYTES;
const EXCHANGE_CONSENT_VERSION = 1;
const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function configuration(env) {
  const values = {
    clientId: env.GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_DRIVE_REFRESH_TOKEN,
    folderId: env.GOOGLE_DRIVE_RECOVERY_FOLDER_ID,
  };
  return Object.values(values).every(Boolean) ? values : null;
}

async function accessToken(config) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error("Google Drive authorization could not be refreshed");
  const result = await response.json();
  if (!result.access_token) throw new Error("Google Drive did not return an access token");
  return result.access_token;
}

async function driveFetch(path, token, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Google Drive Study Coach request failed (${response.status})`);
  return response;
}

function exchangeQuery(config, kind) {
  return `'${config.folderId.replaceAll("'", "\\'")}' in parents and trashed = false and appProperties has { key='abpnStudyCoach' and value='${kind}' }`;
}

async function listExchangeFiles(config, token, kind) {
  const url = new URL(DRIVE_FILES_ENDPOINT);
  url.searchParams.set("q", exchangeQuery(config, kind));
  url.searchParams.set("fields", "files(id,name,createdTime,size,appProperties)");
  url.searchParams.set("orderBy", "createdTime desc");
  url.searchParams.set("pageSize", "10");
  const response = await driveFetch(url.toString(), token);
  return (await response.json()).files || [];
}

async function prepareOutputAgainstDrivePackage(input, config, token) {
  if (!Array.isArray(input?.generatedDecks) || !input.generatedDecks.length) {
    return prepareStudyCoachOutput(input);
  }
  const [latestPackage] = await listExchangeFiles(config, token, "package");
  if (!latestPackage) throw new Error("Archive a current Study Coach package before publishing generated decks");
  if (Number(latestPackage.size || 0) > MAX_EXCHANGE_BYTES) throw new Error("Stored Study Coach package exceeds the 25 MiB limit");
  const response = await driveFetch(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(latestPackage.id)}?alt=media`, token);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_EXCHANGE_BYTES) throw new Error("Stored Study Coach package exceeds the 25 MiB limit");
  const pkg = normalizeStudyCoachPackage(JSON.parse(new TextDecoder().decode(bytes)));
  const protectedBanks = protectedStudyCoachBanks(pkg.banks);
  if (!protectedBanks.length) throw new Error("The current Study Coach package has no protected source baseline");
  return prepareStudyCoachOutput(input, {
    reservedIds: protectedBanks.map((bank) => bank.id),
    protectedBanks,
  });
}

function summarizeFile(file) {
  if (!file) return null;
  return {
    id: file.id,
    name: file.name,
    createdAt: file.createdTime,
    byteCount: Number(file.size || 0),
    appProperties: file.appProperties || {},
  };
}

async function readBodyText(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_EXCHANGE_BYTES) throw new Error("Study Coach exchange file exceeds the 25 MiB limit");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_EXCHANGE_BYTES) throw new Error("Study Coach exchange file exceeds the 25 MiB limit");
  return { text: new TextDecoder().decode(bytes), byteCount: bytes.byteLength };
}

function coachPackageFilename(exportedAt) {
  return `abpn-study-coach-package-${exportedAt.replace(/[:.]/g, "-")}.json`;
}

function coachOutputFilename(generatedAt) {
  return `abpn-study-coach-output-${generatedAt.replace(/[:.]/g, "-")}.json`;
}

async function uploadExchangeFile(config, token, text, metadata) {
  const boundary = `abpn-study-coach-${crypto.randomUUID()}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  const response = await driveFetch(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,createdTime,size,appProperties`, token, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return response.json();
}

async function exchangePermission(env, userId) {
  const row = await env.DB.prepare(`
    SELECT enabled, consent_version, exchange_consent_version
    FROM assistant_weakness_permissions WHERE user_id = ?
  `).bind(userId).first();
  return Boolean(row?.enabled)
    && Number(row?.consent_version || 0) === 2
    && Number(row?.exchange_consent_version || 0) === EXCHANGE_CONSENT_VERSION;
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

export async function handleGoogleDriveStudyCoachRequest(request, env, helpers) {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/study-coach/google-drive"
    && url.pathname !== "/api/study-coach/google-drive/package"
    && url.pathname !== "/api/study-coach/google-drive/output"
    && url.pathname !== "/api/study-coach/google-drive/output/latest"
  ) return null;

  const { json, requireSyncReady, requireContext, ensureUserAndDevice, reserveUsage = async () => {} } = helpers;
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);
  const isWrite = request.method === "PUT";
  await reserveUsage({ requests: 1, writeActions: isWrite ? 1 : 0, rowsRead: 1, rowsWritten: 2 });
  if (!await exchangePermission(env, userId)) {
    return json({ error: "Fresh Study Coach exchange permission is required" }, 403);
  }
  const config = configuration(env);

  if (request.method === "GET" && url.pathname === "/api/study-coach/google-drive") {
    if (!config) return json({ configured: false, latestPackage: null, latestOutput: null });
    const token = await accessToken(config);
    const [packages, outputs] = await Promise.all([
      listExchangeFiles(config, token, "package"),
      listExchangeFiles(config, token, "output"),
    ]);
    await exchangeAudit(env, userId, "google-drive-status-accessed", deviceId, { access: true });
    return json({
      configured: true,
      latestPackage: summarizeFile(packages[0]),
      latestOutput: summarizeFile(outputs[0]),
    });
  }

  if (!config) return json({ error: "Restricted Google Drive Study Coach exchange is not configured" }, 503);
  const token = await accessToken(config);

  if (request.method === "PUT" && url.pathname === "/api/study-coach/google-drive/package") {
    const { text } = await readBodyText(request);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "Study Coach package is not valid JSON" }, 400);
    }
    let pkg;
    let normalized;
    try {
      normalized = normalizeStudyCoachPackage(parsed);
      pkg = validateStudyCoachPackage(normalized);
    } catch (error) {
      return json({ error: error.message || "Study Coach package is invalid" }, 400);
    }
    const metadata = {
      name: coachPackageFilename(pkg.exportedAt),
      parents: [config.folderId],
      appProperties: {
        abpnStudyCoach: "package",
        exportedAt: pkg.exportedAt,
        bankCount: String(pkg.bankCount),
        questionCount: String(pkg.questionCount),
        uploadedByUserId: userId,
        uploadedByDeviceId: deviceId,
      },
    };
    const canonicalText = JSON.stringify(normalized);
    const canonicalByteCount = new TextEncoder().encode(canonicalText).byteLength;
    const file = await uploadExchangeFile(config, token, canonicalText, metadata);
    await exchangeAudit(env, userId, "google-drive-package-archived", deviceId, { publish: true });
    return json({
      ok: true,
      configured: true,
      file: {
        id: file.id,
        name: file.name,
        createdAt: file.createdTime,
        byteCount: canonicalByteCount,
        exportedAt: pkg.exportedAt,
        bankCount: pkg.bankCount,
        questionCount: pkg.questionCount,
      },
    });
  }

  if (request.method === "PUT" && url.pathname === "/api/study-coach/google-drive/output") {
    const { text } = await readBodyText(request);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "Study Coach output is not valid JSON" }, 400);
    }
    let output;
    try {
      output = await prepareOutputAgainstDrivePackage(parsed, config, token);
    } catch (error) {
      return json({ error: error.message || "Study Coach output is invalid" }, 400);
    }
    const appProperties = {
      abpnStudyCoach: "output",
      generatedAt: output.generatedAt,
      format: output.format,
      schemaVersion: String(output.schemaVersion),
      uploadedByUserId: userId,
      uploadedByDeviceId: deviceId,
    };
    if (output.sourcePackageGeneratedAt) appProperties.sourcePackageGeneratedAt = output.sourcePackageGeneratedAt;
    const canonicalText = JSON.stringify(output);
    const byteCount = new TextEncoder().encode(canonicalText).byteLength;
    if (byteCount > MAX_EXCHANGE_BYTES) return json({ error: "Study Coach output exceeds the 25 MiB limit" }, 400);
    const metadata = {
      name: coachOutputFilename(output.generatedAt),
      parents: [config.folderId],
      appProperties,
    };
    const file = await uploadExchangeFile(config, token, canonicalText, metadata);
    await exchangeAudit(env, userId, "google-drive-output-archived", deviceId, { publish: true });
    return json({
      ok: true,
      configured: true,
      file: {
        id: file.id,
        name: file.name,
        createdAt: file.createdTime,
        byteCount,
        generatedAt: output.generatedAt,
        sourcePackageGeneratedAt: output.sourcePackageGeneratedAt,
        format: output.format,
        schemaVersion: output.schemaVersion,
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/study-coach/google-drive/output/latest") {
    const [latest] = await listExchangeFiles(config, token, "output");
    if (!latest) return json({ error: "No Study Coach output exists in Google Drive" }, 404);
    if (Number(latest.size || 0) > MAX_EXCHANGE_BYTES) return json({ error: "Stored Study Coach output exceeds the 25 MiB limit" }, 502);
    const response = await driveFetch(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(latest.id)}?alt=media`, token);
    let parsed;
    try {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_EXCHANGE_BYTES) throw new Error("Stored Study Coach output exceeds the 25 MiB limit");
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ error: "Stored Study Coach output is not valid JSON" }, 502);
    }
    try {
      parsed = await prepareOutputAgainstDrivePackage(parsed, config, token);
    } catch (error) {
      return json({ error: error.message || "Stored Study Coach output is invalid" }, 502);
    }
    await exchangeAudit(env, userId, "google-drive-output-accessed", deviceId, { access: true });
    return json({
      ok: true,
      configured: true,
      file: {
        id: latest.id,
        name: latest.name,
        createdAt: latest.createdTime,
        byteCount: Number(latest.size || 0),
        sourcePackageGeneratedAt: latest.appProperties?.sourcePackageGeneratedAt || null,
        format: latest.appProperties?.format || STUDY_COACH_OUTPUT_FORMAT,
        schemaVersion: Number(latest.appProperties?.schemaVersion || STUDY_COACH_OUTPUT_SCHEMA_VERSION),
      },
      output: parsed,
    });
  }

  return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT" });
}
