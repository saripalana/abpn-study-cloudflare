import { deleteStudyDatabase } from "./storage.js";
import { restoreRecoveryBundle, validateRecoveryBundle } from "./recovery-bundle.js";

// Staging mirrors production behavior but never retains a prior test session.
// Production is deliberately a no-op: cleanup requires an exact health result
// of `staging`, and the server independently repeats the same environment gate.
const SESSION_KEY = "abpn-study:staging-session";
const DEVICE_KEY = "abpn-study:device-id";
const EXAM_DATE_KEY = "abpn-study:exam-date";
const VALIDATION_VISIBILITY_KEY = "abpn-study:allow-system-validation";
const STAGING_HOSTNAME = "abpn-study-cloudflare-staging.saripalana.workers.dev";

function withTimeout(operation, milliseconds) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), milliseconds);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
}

async function readEnvironment(fetchImpl) {
  try {
    const response = await withTimeout(fetchImpl("/api/health", {
      headers: { accept: "application/json" },
      cache: "no-store",
    }), 2_000);
    if (!response) return "unavailable";
    if (!response.ok) return "unavailable";
    const health = await response.json();
    return health?.environment === "staging" ? "staging" : "other";
  } catch {
    return "unavailable";
  }
}

async function clearBrowserState({ localStorageRef, cacheStorage, deleteDatabase }) {
  // Exam date is a durable preference, not disposable staging test data.
  const preservedExamDate = localStorageRef.getItem(EXAM_DATE_KEY);
  await deleteDatabase();
  localStorageRef.clear();
  if (preservedExamDate) localStorageRef.setItem(EXAM_DATE_KEY, preservedExamDate);
  if (cacheStorage?.keys) {
    const keys = await cacheStorage.keys();
    await Promise.all(keys.map((key) => cacheStorage.delete(key)));
  }
}

async function resetRemoteStagingState(fetchImpl, sessionId) {
  const response = await fetchImpl("/api/staging/session", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-abpn-device-id": sessionId,
      "x-abpn-staging-session": sessionId,
    },
    body: "{}",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Staging session cleanup failed safely");
}

async function stagingSessionIsActive(fetchImpl, sessionId) {
  const response = await fetchImpl("/api/staging/session", {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-abpn-device-id": sessionId,
      "x-abpn-staging-session": sessionId,
    },
    cache: "no-store",
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error("Staging session validation failed safely");
  return true;
}

async function seedFromProductionSnapshot(fetchImpl, sessionId) {
  const response = await fetchImpl("/api/recovery/google-drive/latest", {
    headers: {
      accept: "application/json",
      "x-abpn-device-id": sessionId,
    },
    cache: "no-store",
  });
  // A first-ever installation may legitimately have no snapshot. A configured
  // provider failure must stop staging rather than present an empty workspace
  // as a faithful production shadow.
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Production shadow snapshot could not be loaded safely");
  await restoreRecoveryBundle(await validateRecoveryBundle(await response.json()));
  return true;
}

export async function prepareStagingSession({
  fetchImpl = globalThis.fetch.bind(globalThis),
  localStorageRef = globalThis.localStorage,
  sessionStorageRef = globalThis.sessionStorage,
  cacheStorage = globalThis.caches,
  locationRef = globalThis.location,
  createId = () => crypto.randomUUID(),
  deleteDatabase = deleteStudyDatabase,
} = {}) {
  const environment = await readEnvironment(fetchImpl);
  // The sole staging hostname must prove its staging identity before any app
  // state is read. A failed or misconfigured health response therefore blocks
  // staging startup, while every non-staging hostname remains a safe no-op.
  if (locationRef?.hostname === STAGING_HOSTNAME && environment !== "staging") {
    throw new Error("Staging environment verification failed safely");
  }
  if (environment !== "staging") {
    return { staging: false, reset: false, sessionId: null };
  }

  // The validation fixture is available only to the local automated browser
  // harness. It must never appear in the private staging or production UI.
  if (locationRef?.hostname === STAGING_HOSTNAME) {
    sessionStorageRef.removeItem(VALIDATION_VISIBILITY_KEY);
  } else {
    sessionStorageRef.setItem(VALIDATION_VISIBILITY_KEY, "true");
  }

  const existing = sessionStorageRef.getItem(SESSION_KEY);
  // sessionStorage survives a reload but disappears when the isolated browser
  // tab/session closes. The server lease may expire while a tab remains open,
  // so every reload validates it before any application state is read.
  if (existing && await stagingSessionIsActive(fetchImpl, existing)) {
    return { staging: true, reset: false, sessionId: existing };
  }
  if (existing) sessionStorageRef.removeItem(SESSION_KEY);

  const sessionId = createId();
  await resetRemoteStagingState(fetchImpl, sessionId);
  await clearBrowserState({ localStorageRef, cacheStorage, deleteDatabase });
  localStorageRef.setItem(DEVICE_KEY, sessionId);
  sessionStorageRef.setItem(SESSION_KEY, sessionId);
  const shadowRestored = await seedFromProductionSnapshot(fetchImpl, sessionId);
  return { staging: true, reset: true, sessionId, shadowRestored };
}

let sharedPreparation;

export function ensureStagingSession() {
  sharedPreparation ??= prepareStagingSession();
  return sharedPreparation;
}

export const STAGING_SESSION_KEY = SESSION_KEY;
