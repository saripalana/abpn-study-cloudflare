const DB_NAME = "abpn-study";
const DB_VERSION = 1;

export const STORES = Object.freeze({
  META: "meta",
  BANKS: "banks",
  PROGRESS: "progress",
  SETS: "practiceSets",
  ANSWERS: "practiceSetAnswers",
  OUTBOX: "syncOutbox",
  SNAPSHOTS: "snapshots"
});

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function openStudyDatabase() {
  if (!("indexedDB" in globalThis)) {
    throw new Error("This browser does not support IndexedDB.");
  }

  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;

    if (!db.objectStoreNames.contains(STORES.META)) {
      db.createObjectStore(STORES.META, { keyPath: "key" });
    }
    if (!db.objectStoreNames.contains(STORES.BANKS)) {
      db.createObjectStore(STORES.BANKS, { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains(STORES.PROGRESS)) {
      const store = db.createObjectStore(STORES.PROGRESS, { keyPath: ["bankId", "questionId"] });
      store.createIndex("byBank", "bankId", { unique: false });
      store.createIndex("byUpdatedAt", "updatedAt", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.SETS)) {
      const store = db.createObjectStore(STORES.SETS, { keyPath: "id" });
      store.createIndex("byBank", "bankId", { unique: false });
      store.createIndex("byStatus", "status", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.ANSWERS)) {
      const store = db.createObjectStore(STORES.ANSWERS, { keyPath: ["setId", "questionId"] });
      store.createIndex("bySet", "setId", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
      const store = db.createObjectStore(STORES.OUTBOX, { keyPath: "id" });
      store.createIndex("byCreatedAt", "createdAt", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.SNAPSHOTS)) {
      const store = db.createObjectStore(STORES.SNAPSHOTS, { keyPath: "id" });
      store.createIndex("byCreatedAt", "createdAt", { unique: false });
    }
  };

  return requestResult(request);
}

export async function getRecord(storeName, key) {
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction(storeName, "readonly");
    return await requestResult(tx.objectStore(storeName).get(key));
  } finally {
    db.close();
  }
}

export async function getAllRecords(storeName) {
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction(storeName, "readonly");
    return await requestResult(tx.objectStore(storeName).getAll());
  } finally {
    db.close();
  }
}

export async function putRecord(storeName, value) {
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    await transactionDone(tx);
    return value;
  } finally {
    db.close();
  }
}

export async function deleteRecord(storeName, key) {
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function updateQuestionProgress({ bankId, questionId, patch, deviceId }) {
  if (!bankId || !questionId) throw new Error("bankId and questionId are required");

  const current = (await getRecord(STORES.PROGRESS, [bankId, questionId])) ?? {
    bankId,
    questionId,
    revision: 0
  };
  const updatedAt = new Date().toISOString();
  const next = {
    ...current,
    ...patch,
    bankId,
    questionId,
    deviceId,
    revision: Number(current.revision ?? 0) + 1,
    updatedAt
  };

  const outboxEntry = {
    id: crypto.randomUUID(),
    entityType: "questionProgress",
    entityKey: `${bankId}:${questionId}`,
    operation: "upsert",
    payload: next,
    createdAt: updatedAt
  };

  const db = await openStudyDatabase();
  try {
    const tx = db.transaction([STORES.PROGRESS, STORES.OUTBOX], "readwrite");
    tx.objectStore(STORES.PROGRESS).put(next);
    tx.objectStore(STORES.OUTBOX).put(outboxEntry);
    await transactionDone(tx);
    return next;
  } finally {
    db.close();
  }
}

export async function createRecoverySnapshot(reason = "automatic") {
  const [banks, progress, sets, answers] = await Promise.all([
    getAllRecords(STORES.BANKS),
    getAllRecords(STORES.PROGRESS),
    getAllRecords(STORES.SETS),
    getAllRecords(STORES.ANSWERS)
  ]);

  const snapshot = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    reason,
    createdAt: new Date().toISOString(),
    data: { banks, progress, sets, answers }
  };
  await putRecord(STORES.SNAPSHOTS, snapshot);
  return snapshot;
}
