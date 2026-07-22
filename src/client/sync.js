import { STORES, deleteRecord, getAllRecords, getRecord, putRecord } from "./storage.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_AUTOMATIC_RETRIES = 3;
const MIN_BACKGROUND_INTERVAL_MS = 15 * 60 * 1000;
const FAILURE_SUSPENSION_THRESHOLD = 3;
const SYNC_STATE_KEY = "syncState";
const RETRYABLE_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const defaultSyncState = () => ({
  key: SYNC_STATE_KEY,
  mode: "local-only",
  suspended: false,
  suspensionReason: null,
  consecutiveFailures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  updatedAt: new Date().toISOString(),
});

export async function getSyncState() {
  return (await getRecord(STORES.META, SYNC_STATE_KEY)) ?? defaultSyncState();
}

async function saveSyncState(patch) {
  const current = await getSyncState();
  const next = {
    ...current,
    ...patch,
    key: SYNC_STATE_KEY,
    updatedAt: new Date().toISOString(),
  };
  await putRecord(STORES.META, next);
  return next;
}

export async function clearSyncSuspension() {
  return saveSyncState({
    mode: "local-only",
    suspended: false,
    suspensionReason: null,
    consecutiveFailures: 0,
  });
}

export class SyncRequestError extends Error {
  constructor(message, { status = null, responseBody = null, localOnly = false } = {}) {
    super(message);
    this.name = "SyncRequestError";
    this.status = status;
    this.responseBody = responseBody;
    this.localOnly = localOnly;
  }
}

function retryDelay(attempt) {
  const base = Math.min(8_000, 500 * (2 ** attempt));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.25)));
  return base + jitter;
}

async function parseErrorResponse(response) {
  const text = await response.text();
  if (!text) return { message: response.statusText || "Cloud synchronization request failed", body: null, localOnly: false };
  try {
    const body = JSON.parse(text);
    return {
      message: body.error || response.statusText || "Cloud synchronization request failed",
      body,
      localOnly: Boolean(body.localOnly),
    };
  } catch {
    return { message: text, body: text, localOnly: false };
  }
}

export class SyncClient {
  constructor({ apiBase = "", deviceId, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    if (!deviceId) throw new Error("deviceId is required");
    this.apiBase = apiBase.replace(/\/$/, "");
    this.deviceId = deviceId;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    let lastError;

    for (let attempt = 0; attempt <= MAX_AUTOMATIC_RETRIES; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.apiBase}${path}`, {
          ...options,
          headers: {
            "content-type": "application/json",
            "x-abpn-device-id": this.deviceId,
            ...(options.headers ?? {}),
          },
        });

        if (response.ok) return response.status === 204 ? null : response.json();

        const details = await parseErrorResponse(response);
        const error = new SyncRequestError(
          `Sync request failed (${response.status}): ${details.message}`,
          { status: response.status, responseBody: details.body, localOnly: details.localOnly }
        );
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_AUTOMATIC_RETRIES) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof SyncRequestError && !RETRYABLE_STATUSES.has(error.status)) throw error;
        lastError = error;
        if (attempt === MAX_AUTOMATIC_RETRIES) break;
      }

      await sleep(retryDelay(attempt));
    }

    if (lastError instanceof SyncRequestError) throw lastError;
    throw new SyncRequestError(`Sync request failed after ${MAX_AUTOMATIC_RETRIES} retries: ${lastError?.message || "network error"}`, {
      localOnly: true,
    });
  }

  async pushPending({ batchSize = DEFAULT_BATCH_SIZE } = {}) {
    const safeBatchSize = Math.max(1, Math.min(DEFAULT_BATCH_SIZE, Number(batchSize) || DEFAULT_BATCH_SIZE));
    const allPending = await getAllRecords(STORES.OUTBOX);
    const latestByEntity = new Map();
    for (const item of allPending) {
      const key = `${item.entityType}:${item.entityKey}`;
      const current = latestByEntity.get(key);
      const itemRevision = Number(item.payload?.revision || 0);
      const currentRevision = Number(current?.payload?.revision || 0);
      if (!current || itemRevision > currentRevision || (
        itemRevision === currentRevision && String(item.createdAt) > String(current.createdAt)
      )) latestByEntity.set(key, item);
    }
    const priority = { practiceSet: 0, practiceSetAnswer: 1, questionProgress: 2 };
    const compacted = [...latestByEntity.values()].sort((a, b) => {
      const entityOrder = (priority[a.entityType] ?? 9) - (priority[b.entityType] ?? 9);
      return entityOrder || String(a.createdAt).localeCompare(String(b.createdAt));
    });
    const keepIds = new Set(compacted.map((item) => item.id));
    await Promise.all(allPending.filter((item) => !keepIds.has(item.id)).map((item) => deleteRecord(STORES.OUTBOX, item.id)));
    const pending = compacted.slice(0, safeBatchSize);

    if (pending.length === 0) return { pushed: 0, pending: 0, conflicts: [] };

    const result = await this.request("/api/sync/push", {
      method: "POST",
      body: JSON.stringify({ changes: pending }),
    });

    const acceptedIds = new Set(result.acceptedIds ?? []);
    const resolvedConflictIds = new Set((result.conflicts ?? [])
      .filter((conflict) => conflict.remoteWins)
      .map((conflict) => conflict.id));
    await Promise.all(
      pending
        .filter((item) => acceptedIds.has(item.id) || resolvedConflictIds.has(item.id))
        .map((item) => deleteRecord(STORES.OUTBOX, item.id))
    );
    return {
      pushed: acceptedIds.size,
      pending: Math.max(0, compacted.length - acceptedIds.size - resolvedConflictIds.size),
      conflicts: result.conflicts ?? [],
    };
  }

  async applyRemoteRecord(storeName, key, incoming) {
    const local = await getRecord(storeName, key);
    if (local) {
      const localRevision = Number(local.revision || 0);
      const incomingRevision = Number(incoming.revision || 0);
      const localTime = Date.parse(local.updatedAt || 0) || 0;
      const incomingTime = Date.parse(incoming.updatedAt || 0) || 0;
      if (localRevision > incomingRevision || (localRevision === incomingRevision && localTime >= incomingTime)) return false;
    }
    await putRecord(storeName, incoming);
    return true;
  }

  async pullRemote({ cursor = null } = {}) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const result = await this.request(`/api/sync/pull${query}`, { method: "GET" });

    for (const change of result.changes ?? []) {
      if (change.entityType === "questionProgress" && change.operation === "upsert") {
        await this.applyRemoteRecord(STORES.PROGRESS, [change.payload.bankId, change.payload.questionId], change.payload);
      }
      if (change.entityType === "practiceSet" && change.operation === "upsert") {
        await this.applyRemoteRecord(STORES.SETS, change.payload.id, change.payload);
      }
      if (change.entityType === "practiceSetAnswer" && change.operation === "upsert") {
        await this.applyRemoteRecord(STORES.ANSWERS, [change.payload.setId, change.payload.questionId], change.payload);
      }
    }

    if (result.nextCursor) {
      await putRecord(STORES.META, { key: "syncCursor", value: result.nextCursor });
    }
    return result;
  }

  async synchronize({ background = false, force = false } = {}) {
    const state = await getSyncState();
    if (state.suspended) {
      return {
        status: "suspended",
        localOnly: true,
        reason: state.suspensionReason || "three-consecutive-failures",
        state,
      };
    }

    const pending = await getAllRecords(STORES.OUTBOX);
    const lastAttemptTime = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0;
    if (background && !force) {
      if (pending.length === 0) {
        return { status: "skipped", localOnly: true, reason: "no-meaningful-local-changes", state };
      }
      if (lastAttemptTime && Date.now() - lastAttemptTime < MIN_BACKGROUND_INTERVAL_MS) {
        return { status: "skipped", localOnly: true, reason: "background-interval", state };
      }
    }

    const attemptAt = new Date().toISOString();
    await saveSyncState({ lastAttemptAt: attemptAt });

    try {
      const cursorRecord = await getRecord(STORES.META, "syncCursor");
      let pushed = 0;
      let pendingCount = 0;
      const conflicts = [];
      for (let batch = 0; batch < 5; batch += 1) {
        const result = await this.pushPending();
        pushed += result.pushed;
        pendingCount = result.pending;
        conflicts.push(...(result.conflicts ?? []));
        if (!pendingCount) break;
      }
      const pull = await this.pullRemote({ cursor: cursorRecord?.value ?? null });
      const nextState = await saveSyncState({
        mode: "cloud-ready",
        suspended: false,
        suspensionReason: null,
        consecutiveFailures: 0,
        lastSuccessAt: new Date().toISOString(),
      });
      return {
        status: "success",
        localOnly: false,
        pushed,
        pending: pendingCount,
        conflicts,
        pulled: (pull.changes ?? []).length,
        nextCursor: pull.nextCursor ?? null,
        state: nextState,
      };
    } catch (error) {
      const failures = Number(state.consecutiveFailures || 0) + 1;
      const serverReason = error?.responseBody?.reason || null;
      const suspended = Boolean(error?.localOnly || serverReason || failures >= FAILURE_SUSPENSION_THRESHOLD);
      const nextState = await saveSyncState({
        mode: "local-only",
        suspended,
        suspensionReason: suspended ? (serverReason || error.message || "three-consecutive-failures") : null,
        consecutiveFailures: failures,
      });
      error.syncState = nextState;
      throw error;
    }
  }
}

export const SYNC_CLIENT_LIMITS = Object.freeze({
  batchSize: DEFAULT_BATCH_SIZE,
  maximumAutomaticRetries: MAX_AUTOMATIC_RETRIES,
  minimumBackgroundIntervalMs: MIN_BACKGROUND_INTERVAL_MS,
  failureSuspensionThreshold: FAILURE_SUSPENSION_THRESHOLD,
});
