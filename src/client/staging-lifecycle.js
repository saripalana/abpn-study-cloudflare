import { deleteStudyDatabase } from "./storage.js";

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
  // tab/session closes. Its absence is the reliable next-launch cleanup signal.
  if (existing) return { staging: true, reset: false, sessionId: existing, importLiveBackup: false };

  const sessionId = createId();
  await resetRemoteStagingState(fetchImpl, sessionId);
  await clearBrowserState({ localStorageRef, cacheStorage, deleteDatabase });
  localStorageRef.setItem(DEVICE_KEY, sessionId);
  sessionStorageRef.setItem(SESSION_KEY, sessionId);
  return { staging: true, reset: true, sessionId, importLiveBackup: true };
}

export async function importLiveBackupIntoStaging(
  sessionId,
  fetchImpl = globalThis.fetch.bind(globalThis),
) {
  if (!sessionId) return false;
  const response = await fetchImpl("/api/recovery/google-drive/latest", {
    method: "GET",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "x-abpn-device-id": sessionId,
      "x-abpn-staging-session": sessionId,
    },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("The latest live backup could not be copied into staging.");
  const { restoreRecoveryBundle, validateRecoveryBundle } = await import("./recovery-bundle.js");
  await restoreRecoveryBundle(await validateRecoveryBundle(await response.json()));
  return true;
}

let sharedPreparation;

export function ensureStagingSession() {
  sharedPreparation ??= prepareStagingSession();
  return sharedPreparation;
}

export const STAGING_SESSION_KEY = SESSION_KEY;
