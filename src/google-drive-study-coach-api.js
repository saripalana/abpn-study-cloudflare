import {
  STUDY_COACH_OUTPUT_FORMAT,
  STUDY_COACH_OUTPUT_SCHEMA_VERSION,
  validateStudyCoachOutput,
  validateStudyCoachPackage,
} from "./client/study-coach-package.js";

const MAX_EXCHANGE_BYTES = 25 * 1024 * 1024;
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

async function uploadPackage(config, token, text, metadata) {
  const boundary = `abpn-study-coach-${crypto.randomUUID()}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  const response = await driveFetch(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,createdTime,size,appProperties`, token, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return response.json();
}

export async function handleGoogleDriveStudyCoachRequest(request, env, helpers) {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/study-coach/google-drive"
    && url.pathname !== "/api/study-coach/google-drive/package"
    && url.pathname !== "/api/study-coach/google-drive/output/latest"
  ) return null;

  const { json, requireSyncReady, requireContext, ensureUserAndDevice } = helpers;
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);
  const config = configuration(env);

  if (request.method === "GET" && url.pathname === "/api/study-coach/google-drive") {
    if (!config) return json({ configured: false, latestPackage: null, latestOutput: null });
    const token = await accessToken(config);
    const [packages, outputs] = await Promise.all([
      listExchangeFiles(config, token, "package"),
      listExchangeFiles(config, token, "output"),
    ]);
    return json({
      configured: true,
      latestPackage: summarizeFile(packages[0]),
      latestOutput: summarizeFile(outputs[0]),
    });
  }

  if (!config) return json({ error: "Restricted Google Drive Study Coach exchange is not configured" }, 503);
  const token = await accessToken(config);

  if (request.method === "PUT" && url.pathname === "/api/study-coach/google-drive/package") {
    const { text, byteCount } = await readBodyText(request);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "Study Coach package is not valid JSON" }, 400);
    }
    let pkg;
    try {
      pkg = validateStudyCoachPackage(parsed);
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
    const file = await uploadPackage(config, token, text, metadata);
    return json({
      ok: true,
      configured: true,
      file: {
        id: file.id,
        name: file.name,
        createdAt: file.createdTime,
        byteCount,
        exportedAt: pkg.exportedAt,
        bankCount: pkg.bankCount,
        questionCount: pkg.questionCount,
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/study-coach/google-drive/output/latest") {
    const [latest] = await listExchangeFiles(config, token, "output");
    if (!latest) return json({ error: "No Study Coach output exists in Google Drive" }, 404);
    const response = await driveFetch(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(latest.id)}?alt=media`, token);
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      return json({ error: "Stored Study Coach output is not valid JSON" }, 502);
    }
    try {
      validateStudyCoachOutput(parsed);
    } catch (error) {
      return json({ error: error.message || "Stored Study Coach output is invalid" }, 502);
    }
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
