import {
  STORES,
  createRecoverySnapshot,
  getAllRecords,
  openStudyDatabase,
} from "./storage.js";

export const BACKUP_FORMAT = "abpn-study-local-backup";
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024;

const BACKUP_STORE_KEYS = Object.freeze({
  [STORES.BANKS]: "banks",
  [STORES.PROGRESS]: "progress",
  [STORES.SETS]: "practiceSets",
  [STORES.ANSWERS]: "practiceSetAnswers",
  [STORES.SNAPSHOTS]: "snapshots",
});

const REQUIRED_ARRAY_KEYS = Object.freeze(Object.values(BACKUP_STORE_KEYS));
const RESTORABLE_STORES = Object.freeze(Object.keys(BACKUP_STORE_KEYS));

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
});

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const laterTimestamp = (left, right) => {
  const leftTime = validDate(left) ? Date.parse(left) : 0;
  const rightTime = validDate(right) ? Date.parse(right) : 0;
  return rightTime > leftTime;
};

function recordKey(storeName, record) {
  if (storeName === STORES.PROGRESS) return `${record.bankId}\u0000${record.questionId}`;
  if (storeName === STORES.ANSWERS) return `${record.setId}\u0000${record.questionId}`;
  return String(record.id || "");
}

function assertUniqueRecords(storeName, records, label) {
  const seen = new Set();
  for (const record of records) {
    const key = recordKey(storeName, record);
    if (!key) throw new Error(`${label} contains a record without a valid key.`);
    if (seen.has(key)) throw new Error(`${label} contains duplicate record key ${key}.`);
    seen.add(key);
  }
}

function validateBank(record) {
  if (!isObject(record) || !record.id || !record.title) throw new Error("Backup contains invalid question-bank metadata.");
  if (Object.hasOwn(record, "questions")) {
    throw new Error("Backup must not contain question-bank content. Only bank metadata is portable.");
  }
}

function validateProgress(record) {
  if (!isObject(record) || !record.bankId || !record.questionId) throw new Error("Backup contains invalid question progress.");
  const revision = Number(record.revision ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Backup contains invalid progress revisions.");
  if (record.updatedAt != null && !validDate(record.updatedAt)) throw new Error("Backup contains invalid progress timestamps.");
}

function validateSet(record) {
  if (!isObject(record) || !record.id || !record.bankId || !Array.isArray(record.questionIds)) {
    throw new Error("Backup contains an invalid practice set.");
  }
  if (record.questionIds.length > 10_000 || record.questionIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Backup contains invalid practice-set question references.");
  }
  if (record.updatedAt != null && !validDate(record.updatedAt)) throw new Error("Backup contains invalid practice-set timestamps.");
}

function validateAnswer(record) {
  if (!isObject(record) || !record.setId || !record.questionId) throw new Error("Backup contains an invalid practice-set answer.");
  if (record.updatedAt != null && !validDate(record.updatedAt)) throw new Error("Backup contains invalid answer timestamps.");
}

function validateSnapshot(record) {
  if (!isObject(record) || !record.id || !validDate(record.createdAt) || !isObject(record.data)) {
    throw new Error("Backup contains an invalid recovery snapshot.");
  }
}

export function validatePortableBackup(input) {
  if (!isObject(input)) throw new Error("Backup file must contain a JSON object.");
  if (input.format !== BACKUP_FORMAT) throw new Error("This is not an ABPN Study portable backup.");
  if (input.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup schema version: ${input.schemaVersion ?? "missing"}.`);
  }
  if (!validDate(input.createdAt)) throw new Error("Backup creation time is missing or invalid.");
  if (!isObject(input.data)) throw new Error("Backup data section is missing.");
  if (input.questionContentIncluded !== false) {
    throw new Error("Backup does not confirm that original question-bank content is excluded.");
  }

  for (const key of REQUIRED_ARRAY_KEYS) {
    if (!Array.isArray(input.data[key])) throw new Error(`Backup data.${key} must be an array.`);
  }

  input.data.banks.forEach(validateBank);
  input.data.progress.forEach(validateProgress);
  input.data.practiceSets.forEach(validateSet);
  input.data.practiceSetAnswers.forEach(validateAnswer);
  input.data.snapshots.forEach(validateSnapshot);

  assertUniqueRecords(STORES.BANKS, input.data.banks, "Bank metadata");
  assertUniqueRecords(STORES.PROGRESS, input.data.progress, "Progress");
  assertUniqueRecords(STORES.SETS, input.data.practiceSets, "Practice sets");
  assertUniqueRecords(STORES.ANSWERS, input.data.practiceSetAnswers, "Practice-set answers");
  assertUniqueRecords(STORES.SNAPSHOTS, input.data.snapshots, "Recovery snapshots");

  return input;
}

export function choosePreferredRecord(storeName, current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;

  if (storeName === STORES.PROGRESS) {
    const currentRevision = Number(current.revision ?? 0);
    const incomingRevision = Number(incoming.revision ?? 0);
    if (incomingRevision > currentRevision) return incoming;
    if (incomingRevision < currentRevision) return current;
  }

  if (storeName === STORES.SNAPSHOTS) return current;
  return laterTimestamp(current.updatedAt ?? current.createdAt, incoming.updatedAt ?? incoming.createdAt)
    ? incoming
    : current;
}

function knownQuestionMap(input) {
  const map = new Map();
  if (input instanceof Map) {
    for (const [bankId, values] of input.entries()) map.set(bankId, new Set(values));
    return map;
  }
  if (isObject(input)) {
    for (const [bankId, values] of Object.entries(input)) map.set(bankId, new Set(values));
  }
  return map;
}

export async function createPortableBackup({ appVersion = "unknown" } = {}) {
  const [banks, progress, practiceSets, practiceSetAnswers, snapshots] = await Promise.all([
    getAllRecords(STORES.BANKS),
    getAllRecords(STORES.PROGRESS),
    getAllRecords(STORES.SETS),
    getAllRecords(STORES.ANSWERS),
    getAllRecords(STORES.SNAPSHOTS),
  ]);

  const createdAt = new Date().toISOString();
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt,
    appVersion,
    contentScope: "local-study-records-only",
    questionContentIncluded: false,
    deviceSpecificSyncStateIncluded: false,
    data: { banks, progress, practiceSets, practiceSetAnswers, snapshots },
    manifest: {
      banks: banks.length,
      progress: progress.length,
      practiceSets: practiceSets.length,
      practiceSetAnswers: practiceSetAnswers.length,
      snapshots: snapshots.length,
    },
  };
}

export function backupFilename(createdAt = new Date().toISOString()) {
  const safe = createdAt.replace(/[:.]/g, "-");
  return `abpn-study-backup-${safe}.json`;
}

export function downloadPortableBackup(backup) {
  validatePortableBackup(backup);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFilename(backup.createdAt);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function parsePortableBackupFile(file) {
  if (!file) throw new Error("Choose a backup file first.");
  if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error("Backup file exceeds the 25 MiB safety limit.");
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("Backup file is not valid JSON.");
  }
  return validatePortableBackup(parsed);
}

export async function restorePortableBackup(input, { knownQuestionIdsByBank = {} } = {}) {
  const backup = validatePortableBackup(input);
  const knownQuestions = knownQuestionMap(knownQuestionIdsByBank);
  if (knownQuestions.size === 0) throw new Error("Installed question-bank references are required before restore.");

  await createRecoverySnapshot("before-portable-backup-restore");

  const incomingByStore = new Map([
    [STORES.BANKS, backup.data.banks],
    [STORES.PROGRESS, backup.data.progress],
    [STORES.SETS, backup.data.practiceSets],
    [STORES.ANSWERS, backup.data.practiceSetAnswers],
    [STORES.SNAPSHOTS, backup.data.snapshots],
  ]);
  const currentArrays = await Promise.all(RESTORABLE_STORES.map((store) => getAllRecords(store)));
  const currentByStore = new Map(RESTORABLE_STORES.map((store, index) => [store, currentArrays[index]]));
  const chosenSets = new Map();
  const writes = new Map(RESTORABLE_STORES.map((store) => [store, []]));
  const summary = {
    imported: 0,
    keptNewerLocal: 0,
    skippedUnknownBank: 0,
    skippedUnknownQuestion: 0,
    quarantinedSets: 0,
    preRestoreSnapshotCreated: true,
  };

  for (const storeName of RESTORABLE_STORES) {
    const currentMap = new Map(currentByStore.get(storeName).map((record) => [recordKey(storeName, record), record]));
    for (const incomingRecord of incomingByStore.get(storeName)) {
      let candidate = structuredClone(incomingRecord);

      if (storeName === STORES.BANKS && !knownQuestions.has(candidate.id)) {
        summary.skippedUnknownBank += 1;
        continue;
      }
      if (storeName === STORES.PROGRESS) {
        const bankQuestions = knownQuestions.get(candidate.bankId);
        if (!bankQuestions) {
          summary.skippedUnknownBank += 1;
          continue;
        }
        if (!bankQuestions.has(candidate.questionId)) {
          summary.skippedUnknownQuestion += 1;
          continue;
        }
      }
      if (storeName === STORES.SETS) {
        const bankQuestions = knownQuestions.get(candidate.bankId);
        if (!bankQuestions) {
          summary.skippedUnknownBank += 1;
          continue;
        }
        const invalidReferences = candidate.questionIds.filter((id) => !bankQuestions.has(id));
        if (invalidReferences.length) {
          candidate = {
            ...candidate,
            status: "invalid",
            restoreWarning: "Question references were not present in the installed bank.",
            invalidQuestionIds: invalidReferences.slice(0, 100),
          };
          summary.quarantinedSets += 1;
        } else if (candidate.status === "active" && candidate.timed && !candidate.submitted) {
          candidate = {
            ...candidate,
            restoredFromUpdatedAt: candidate.updatedAt ?? null,
            updatedAt: new Date().toISOString(),
          };
        }
      }
      if (storeName === STORES.ANSWERS) {
        const incomingSet = backup.data.practiceSets.find((set) => set.id === candidate.setId);
        const currentSet = currentByStore.get(STORES.SETS).find((set) => set.id === candidate.setId);
        const parentSet = incomingSet || currentSet;
        if (!parentSet || !knownQuestions.get(parentSet.bankId)?.has(candidate.questionId)) {
          summary.skippedUnknownQuestion += 1;
          continue;
        }
      }

      const key = recordKey(storeName, candidate);
      const current = currentMap.get(key);
      const preferred = choosePreferredRecord(storeName, current, candidate);
      if (preferred === current) {
        summary.keptNewerLocal += 1;
        if (storeName === STORES.SETS) chosenSets.set(key, current);
        continue;
      }
      writes.get(storeName).push(preferred);
      currentMap.set(key, preferred);
      if (storeName === STORES.SETS) chosenSets.set(key, preferred);
      summary.imported += 1;
    }
  }

  const db = await openStudyDatabase();
  try {
    const storesWithWrites = RESTORABLE_STORES.filter((store) => writes.get(store).length > 0);
    if (storesWithWrites.length) {
      const transaction = db.transaction(storesWithWrites, "readwrite");
      for (const storeName of storesWithWrites) {
        const store = transaction.objectStore(storeName);
        for (const record of writes.get(storeName)) store.put(record);
      }
      await transactionDone(transaction);
    }
  } finally {
    db.close();
  }

  return summary;
}
