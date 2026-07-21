import {
  STORES,
  createRecoverySnapshot,
  deleteRecord,
  getAllRecords,
  getRecord,
  openStudyDatabase,
  putRecord,
  recordsByIndex,
} from "./storage.js";

const LAST_DESTRUCTIVE_ACTION_KEY = "lastDestructiveAction";

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
});

const validDateValue = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

function preferIncomingProgress(current, incoming) {
  if (!current) return true;
  const currentRevision = Number(current.revision ?? 0);
  const incomingRevision = Number(incoming.revision ?? 0);
  if (incomingRevision !== currentRevision) return incomingRevision > currentRevision;
  return validDateValue(incoming.updatedAt) > validDateValue(current.updatedAt);
}

function preferIncomingTimestamp(current, incoming) {
  if (!current) return true;
  return validDateValue(incoming.updatedAt ?? incoming.createdAt)
    > validDateValue(current.updatedAt ?? current.createdAt);
}

async function snapshotForAction(reason, context) {
  const snapshot = await createRecoverySnapshot(reason);
  const enriched = {
    ...snapshot,
    context: structuredClone(context),
  };
  await putRecord(STORES.SNAPSHOTS, enriched);
  return enriched;
}

async function recordAction(snapshot, context, summary) {
  const action = {
    key: LAST_DESTRUCTIVE_ACTION_KEY,
    snapshotId: snapshot.id,
    createdAt: new Date().toISOString(),
    context: structuredClone(context),
    summary: structuredClone(summary),
  };
  await putRecord(STORES.META, action);
  return action;
}

export async function getLastDestructiveAction() {
  const action = await getRecord(STORES.META, LAST_DESTRUCTIVE_ACTION_KEY);
  if (!action?.snapshotId || !action?.context?.type) return null;
  const snapshot = await getRecord(STORES.SNAPSHOTS, action.snapshotId);
  return snapshot ? action : null;
}

export async function clearLastDestructiveAction() {
  await deleteRecord(STORES.META, LAST_DESTRUCTIVE_ACTION_KEY);
}

export async function latestActiveSet(bankId) {
  if (!bankId) return null;
  return (await recordsByIndex(STORES.SETS, "byStatus", "active"))
    .filter((record) => record.bankId === bankId && !record.submitted)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] ?? null;
}

async function deleteSetAndAnswers(setId) {
  const set = await getRecord(STORES.SETS, setId);
  if (!set) return { deletedSets: 0, deletedAnswers: 0 };
  const answers = await recordsByIndex(STORES.ANSWERS, "bySet", setId);
  const db = await openStudyDatabase();
  try {
    const transaction = db.transaction([STORES.SETS, STORES.ANSWERS], "readwrite");
    transaction.objectStore(STORES.SETS).delete(setId);
    const answerStore = transaction.objectStore(STORES.ANSWERS);
    for (const answer of answers) answerStore.delete([answer.setId, answer.questionId]);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
  return { deletedSets: 1, deletedAnswers: answers.length };
}

export async function deleteSavedSet({ setId, bankId, label, type = "delete-completed-set" }) {
  if (!setId || !bankId) throw new Error("A saved set and question bank are required.");
  const set = await getRecord(STORES.SETS, setId);
  if (!set || set.bankId !== bankId) throw new Error("The selected saved set could not be found.");

  const context = { type, setId, bankId, label: label || "saved set" };
  const snapshot = await snapshotForAction(`before-${type}`, context);
  const summary = await deleteSetAndAnswers(setId);
  await recordAction(snapshot, context, summary);
  return { snapshot, summary };
}

function outboxBelongsToBank(entry, bankId) {
  return entry?.payload?.bankId === bankId
    || String(entry?.entityKey ?? "").startsWith(`${bankId}:`);
}

export async function resetQuestionBankData({ bankId, label }) {
  if (!bankId) throw new Error("A question bank is required.");

  const [progress, sets, outbox] = await Promise.all([
    recordsByIndex(STORES.PROGRESS, "byBank", bankId),
    recordsByIndex(STORES.SETS, "byBank", bankId),
    getAllRecords(STORES.OUTBOX),
  ]);
  const answers = (await Promise.all(
    sets.map((set) => recordsByIndex(STORES.ANSWERS, "bySet", set.id))
  )).flat();
  const matchingOutbox = outbox.filter((entry) => outboxBelongsToBank(entry, bankId));

  const context = { type: "reset-bank", bankId, label: label || bankId };
  const snapshot = await snapshotForAction("before-reset-question-bank", context);

  const db = await openStudyDatabase();
  try {
    const transaction = db.transaction(
      [STORES.PROGRESS, STORES.SETS, STORES.ANSWERS, STORES.OUTBOX],
      "readwrite"
    );
    const progressStore = transaction.objectStore(STORES.PROGRESS);
    const setStore = transaction.objectStore(STORES.SETS);
    const answerStore = transaction.objectStore(STORES.ANSWERS);
    const outboxStore = transaction.objectStore(STORES.OUTBOX);

    for (const record of progress) progressStore.delete([record.bankId, record.questionId]);
    for (const set of sets) setStore.delete(set.id);
    for (const answer of answers) answerStore.delete([answer.setId, answer.questionId]);
    for (const entry of matchingOutbox) outboxStore.delete(entry.id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }

  const summary = {
    deletedProgress: progress.length,
    deletedSets: sets.length,
    deletedAnswers: answers.length,
    deletedPendingSyncEntries: matchingOutbox.length,
  };
  await recordAction(snapshot, context, summary);
  return { snapshot, summary };
}

async function currentRecordsForScope(context) {
  if (context.type === "reset-bank") {
    const progress = await recordsByIndex(STORES.PROGRESS, "byBank", context.bankId);
    const sets = await recordsByIndex(STORES.SETS, "byBank", context.bankId);
    const answers = (await Promise.all(
      sets.map((set) => recordsByIndex(STORES.ANSWERS, "bySet", set.id))
    )).flat();
    return { progress, sets, answers };
  }

  const set = await getRecord(STORES.SETS, context.setId);
  const answers = set ? await recordsByIndex(STORES.ANSWERS, "bySet", context.setId) : [];
  return { progress: [], sets: set ? [set] : [], answers };
}

function snapshotRecordsForScope(snapshot, context) {
  const allProgress = snapshot.data?.progress ?? [];
  const allSets = snapshot.data?.sets ?? [];
  const allAnswers = snapshot.data?.answers ?? [];

  if (context.type === "reset-bank") {
    const sets = allSets.filter((set) => set.bankId === context.bankId);
    const setIds = new Set(sets.map((set) => set.id));
    return {
      progress: allProgress.filter((record) => record.bankId === context.bankId),
      sets,
      answers: allAnswers.filter((answer) => setIds.has(answer.setId)),
    };
  }

  return {
    progress: [],
    sets: allSets.filter((set) => set.id === context.setId),
    answers: allAnswers.filter((answer) => answer.setId === context.setId),
  };
}

export async function undoLastDestructiveAction() {
  const action = await getLastDestructiveAction();
  if (!action) throw new Error("There is no deletion or reset available to undo.");
  const snapshot = await getRecord(STORES.SNAPSHOTS, action.snapshotId);
  if (!snapshot?.data) throw new Error("The recovery snapshot is unavailable.");

  const incoming = snapshotRecordsForScope(snapshot, action.context);
  const current = await currentRecordsForScope(action.context);
  const currentProgress = new Map(
    current.progress.map((record) => [`${record.bankId}\u0000${record.questionId}`, record])
  );
  const currentSets = new Map(current.sets.map((record) => [record.id, record]));
  const currentAnswers = new Map(
    current.answers.map((record) => [`${record.setId}\u0000${record.questionId}`, record])
  );

  const restoreProgress = incoming.progress.filter((record) => preferIncomingProgress(
    currentProgress.get(`${record.bankId}\u0000${record.questionId}`),
    record
  ));
  const restoreSets = incoming.sets.filter((record) => preferIncomingTimestamp(
    currentSets.get(record.id),
    record
  ));
  const restoreAnswers = incoming.answers.filter((record) => preferIncomingTimestamp(
    currentAnswers.get(`${record.setId}\u0000${record.questionId}`),
    record
  ));

  const db = await openStudyDatabase();
  try {
    const transaction = db.transaction(
      [STORES.PROGRESS, STORES.SETS, STORES.ANSWERS, STORES.OUTBOX],
      "readwrite"
    );
    const progressStore = transaction.objectStore(STORES.PROGRESS);
    const setStore = transaction.objectStore(STORES.SETS);
    const answerStore = transaction.objectStore(STORES.ANSWERS);
    const outboxStore = transaction.objectStore(STORES.OUTBOX);
    const restoredAt = new Date().toISOString();

    for (const record of restoreProgress) {
      progressStore.put(record);
      outboxStore.put({
        id: crypto.randomUUID(),
        entityType: "questionProgress",
        entityKey: `${record.bankId}:${record.questionId}`,
        operation: "upsert",
        payload: record,
        createdAt: restoredAt,
      });
    }
    for (const record of restoreSets) setStore.put(record);
    for (const record of restoreAnswers) answerStore.put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }

  await clearLastDestructiveAction();
  return {
    action,
    restoredProgress: restoreProgress.length,
    restoredSets: restoreSets.length,
    restoredAnswers: restoreAnswers.length,
  };
}
