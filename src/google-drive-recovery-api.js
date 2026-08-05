const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const RETENTION_MILLISECONDS = 3 * 24 * 60 * 60 * 1000;
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
  if (!response.ok) throw new Error(`Google Drive recovery request failed (${response.status})`);
  return response;
}

async function listBackups(config, token) {
  const query = `'${config.folderId.replaceAll("'", "\\'")}' in parents and trashed = false and appProperties has { key='abpnRecovery' and value='complete' }`;
  const url = new URL(DRIVE_FILES_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", "files(id,name,createdTime,size,appProperties)");
  url.searchParams.set("orderBy", "createdTime desc");
  url.searchParams.set("pageSize", "20");
  const response = await driveFetch(url.toString(), token);
  return (await response.json()).files || [];
}

function productionBackups(files) {
  const labeled = files.filter((file) => file.appProperties?.abpnEnvironment === "production");
  // Existing verified backups predate environment labeling. Use them only
  // until the first labeled production shadow snapshot is available.
  return labeled.length ? labeled : files.filter((file) => !file.appProperties?.abpnEnvironment);
}

async function pruneBackups(files, token, keepId) {
  const cutoff = Date.now() - RETENTION_MILLISECONDS;
  const newestByDay = new Set();
  for (const file of files) {
    if (file.id === keepId) continue;
    const created = Date.parse(file.createdTime);
    const day = Number.isFinite(created) ? new Date(created).toISOString().slice(0, 10) : "invalid";
    const remove = !Number.isFinite(created) || created < cutoff || newestByDay.has(day);
    newestByDay.add(day);
    if (remove) await driveFetch(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(file.id)}`, token, { method: "DELETE" });
  }
}

async function readBundle(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BUNDLE_BYTES) throw new Error("Complete recovery bundle exceeds the 25 MiB Google Drive limit");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("Complete recovery bundle exceeds the 25 MiB Google Drive limit");
  const text = new TextDecoder().decode(bytes);
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error("Recovery bundle is not valid JSON"); }
  if (bundle?.format !== "abpn-study-complete-recovery" || bundle?.schemaVersion !== 1 || !bundle?.integrity?.digest) {
    throw new Error("Recovery bundle format is invalid");
  }
  return { text, bytes: bytes.byteLength, bundle };
}

export async function handleGoogleDriveRecoveryRequest(request, env, helpers) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/recovery/google-drive" && url.pathname !== "/api/recovery/google-drive/latest") return null;
  const { json, requireSyncReady, requireContext, ensureUserAndDevice } = helpers;
  requireSyncReady(env);
  const { userId, deviceId } = requireContext(request, env);
  await ensureUserAndDevice(env, userId, deviceId);
  const config = configuration(env);
  if (!config) {
    return json({ configured: false, error: "Restricted Google Drive recovery is not configured" }, request.method === "GET" && url.pathname.endsWith("google-drive") ? 200 : 503);
  }
  const token = await accessToken(config);
  const environment = env.APP_ENV === "staging" ? "staging" : "production";
  const files = productionBackups(await listBackups(config, token));

  if (request.method === "GET" && url.pathname === "/api/recovery/google-drive") {
    return json({ configured: true, environment, writeAllowed: environment === "production", shadowSource: environment === "staging", backups: files.map((file) => ({
      id: file.id,
      name: file.name,
      createdAt: file.createdTime,
      byteCount: Number(file.size || 0),
      integrityDigest: file.appProperties?.integrityDigest || null,
    })) });
  }

  if (request.method === "GET" && url.pathname === "/api/recovery/google-drive/latest") {
    const [latest] = files;
    if (!latest) return json({ error: "No Google Drive recovery backup exists" }, 404);
    return driveFetch(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(latest.id)}?alt=media`, token);
  }

  if (request.method === "PUT" && url.pathname === "/api/recovery/google-drive") {
    if (environment !== "production") {
      return json({ error: "Staging may read the production shadow but cannot overwrite it" }, 403);
    }
    const { text, bytes, bundle } = await readBundle(request);
    const boundary = `abpn-recovery-${crypto.randomUUID()}`;
    const metadata = {
      name: `abpn-study-complete-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      parents: [config.folderId],
      appProperties: { abpnRecovery: "complete", abpnEnvironment: "production", integrityDigest: bundle.integrity.digest },
    };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const response = await driveFetch(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,createdTime,size,appProperties`, token, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
    const file = await response.json();
    // Retention owns only production-shadow snapshots. Historical staging
    // artifacts remain outside this path until their separately gated cleanup.
    await pruneBackups(productionBackups(await listBackups(config, token)), token, file.id);
    return json({ ok: true, configured: true, id: file.id, name: file.name, createdAt: file.createdTime, byteCount: bytes, retention: "one-per-day-for-three-days" });
  }

  return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT" });
}
