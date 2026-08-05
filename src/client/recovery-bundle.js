import { STORES, createRecoverySnapshot, getAllRecords, openStudyDatabase } from "./storage.js";

// One recovery contract is shared by device downloads and cloud destinations.
// Authentication, device identifiers, staging sessions, and the sync outbox are
// deliberately excluded; a restored browser creates fresh transport state.
export const RECOVERY_BUNDLE_FORMAT = "abpn-study-complete-recovery";
export const RECOVERY_BUNDLE_SCHEMA_VERSION = 1;
export const MAX_RECOVERY_BUNDLE_BYTES = 100 * 1024 * 1024;

const SETTINGS_KEYS = Object.freeze([
  "abpn-study:exam-date",
  "abpn-study:selected-bank",
  "abpn-study:multi-deck-builder",
  "abpn-study:last-github-bank-address",
]);
const SETTINGS_PREFIXES = Object.freeze(["abpn-study:builder-settings:"]);
const STORE_FIELDS = Object.freeze({
  [STORES.META]: "metadata",
  [STORES.BANKS]: "banks",
  [STORES.BANK_CONTENT]: "bankContent",
  [STORES.BANK_REVISIONS]: "bankRevisions",
  [STORES.PROGRESS]: "progress",
  [STORES.SETS]: "practiceSets",
  [STORES.ANSWERS]: "practiceSetAnswers",
  [STORES.SNAPSHOTS]: "recoverySnapshots",
});

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const timestamp = (record) => Date.parse(record?.updatedAt || record?.createdAt || "") || 0;

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeSettings() {
  const settings = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && (SETTINGS_KEYS.includes(key) || SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix)))) {
      settings[key] = localStorage.getItem(key);
    }
  }
  return settings;
}

function recordKey(storeName, record) {
  if (storeName === STORES.BANK_REVISIONS) return `${record.bankId}\u0000${record.checksum}`;
  if (storeName === STORES.PROGRESS) return `${record.bankId}\u0000${record.questionId}`;
  if (storeName === STORES.ANSWERS) return `${record.setId}\u0000${record.questionId}`;
  if (storeName === STORES.META) return String(record.key || "");
  return String(record.id || "");
}

function validateRecords(storeName, records) {
  if (!Array.isArray(records)) throw new Error(`Recovery data for ${storeName} must be an array.`);
  const seen = new Set();
  for (const record of records) {
    const key = isObject(record) ? recordKey(storeName, record) : "";
    if (!key || seen.has(key)) throw new Error(`Recovery data for ${storeName} contains an invalid or duplicate key.`);
    seen.add(key);
  }
}

function validateSettings(settings) {
  if (!isObject(settings)) throw new Error("Recovery settings are missing.");
  for (const [key, value] of Object.entries(settings)) {
    const allowed = SETTINGS_KEYS.includes(key) || SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!allowed || (value !== null && typeof value !== "string")) throw new Error("Recovery bundle contains a setting that is not permitted.");
  }
}

export async function validateRecoveryBundle(bundle) {
  if (!isObject(bundle) || bundle.format !== RECOVERY_BUNDLE_FORMAT) throw new Error("This is not a complete ABPN Study recovery bundle.");
  if (bundle.schemaVersion !== RECOVERY_BUNDLE_SCHEMA_VERSION) throw new Error(`Unsupported recovery schema version: ${bundle.schemaVersion ?? "missing"}.`);
  if (!validDate(bundle.createdAt) || !isObject(bundle.data) || !isObject(bundle.manifest)) throw new Error("Recovery bundle metadata is incomplete.");
  for (const [storeName, field] of Object.entries(STORE_FIELDS)) validateRecords(storeName, bundle.data[field]);
  validateSettings(bundle.data.settings);
  const expected = await sha256(bundle.data);
  if (bundle.integrity?.algorithm !== "SHA-256" || bundle.integrity.digest !== expected) throw new Error("Recovery bundle integrity check failed.");
  return bundle;
}

export async function createRecoveryBundle({ appVersion = "unknown" } = {}) {
  const entries = await Promise.all(Object.keys(STORE_FIELDS).map(async (storeName) => [STORE_FIELDS[storeName], await getAllRecords(storeName)]));
  const data = Object.fromEntries(entries);
  data.settings = safeSettings();
  const createdAt = new Date().toISOString();
  return {
    format: RECOVERY_BUNDLE_FORMAT,
    schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
    createdAt,
    appVersion,
    scope: "complete-study-workspace",
    includes: ["deck-packages", "deck-revisions", "progress", "answers", "active-and-completed-tests", "flags", "settings", "recovery-metadata"],
    excludes: ["authentication", "tokens", "device-identifiers", "staging-sessions", "sync-outbox"],
    data,
    manifest: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Array.isArray(value) ? value.length : Object.keys(value).length])),
    integrity: { algorithm: "SHA-256", digest: await sha256(data) },
  };
}

export function recoveryBundleFilename(createdAt = new Date().toISOString()) {
  return `abpn-study-complete-${createdAt.replace(/[:.]/g, "-")}.json`;
}

export async function parseRecoveryBundleFile(file) {
  if (!file) throw new Error("Choose a complete recovery file first.");
  if (file.size > MAX_RECOVERY_BUNDLE_BYTES) throw new Error("Recovery file exceeds the 100 MiB safety limit.");
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch { throw new Error("Recovery file is not valid JSON."); }
  return validateRecoveryBundle(parsed);
}

export async function downloadRecoveryBundle(bundle) {
  await validateRecoveryBundle(bundle);
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: recoveryBundleFilename(bundle.createdAt), rel: "noopener" });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("Recovery transaction failed"));
  transaction.onabort = () => reject(transaction.error ?? new Error("Recovery transaction was aborted"));
});

// Restore is intentionally non-destructive: absent records are added and only
// demonstrably newer records replace older ones. Existing settings win. This
// makes an accidental restore recoverable without erasing current study work.
export async function restoreRecoveryBundle(input) {
  const bundle = await validateRecoveryBundle(input);
  await createRecoverySnapshot("before-complete-recovery-restore");
  const currentEntries = await Promise.all(Object.keys(STORE_FIELDS).map(async (storeName) => [storeName, await getAllRecords(storeName)]));
  const currentMaps = new Map(currentEntries.map(([storeName, records]) => [storeName, new Map(records.map((record) => [recordKey(storeName, record), record]))]));
  const db = await openStudyDatabase();
  let imported = 0;
  let keptCurrent = 0;
  try {
    const storeNames = Object.keys(STORE_FIELDS);
    const transaction = db.transaction(storeNames, "readwrite");
    for (const [storeName, field] of Object.entries(STORE_FIELDS)) {
      const store = transaction.objectStore(storeName);
      const current = currentMaps.get(storeName);
      for (const record of bundle.data[field]) {
        const existing = current.get(recordKey(storeName, record));
        if (existing && timestamp(existing) >= timestamp(record)) { keptCurrent += 1; continue; }
        store.put(structuredClone(record));
        imported += 1;
      }
    }
    await transactionDone(transaction);
  } finally { db.close(); }
  let settingsImported = 0;
  for (const [key, value] of Object.entries(bundle.data.settings)) {
    if (localStorage.getItem(key) !== null || value === null) continue;
    localStorage.setItem(key, value);
    settingsImported += 1;
  }
  return { restoredAt: new Date().toISOString(), manifest: bundle.manifest, imported, keptCurrent, settingsImported, preRestoreSnapshotCreated: true };
}
