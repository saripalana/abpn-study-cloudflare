import { STORES, deleteRecord, getAllRecords, getRecord, putRecord } from "./storage.js";

const DEFAULT_BATCH_SIZE = 5;
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
  constructor({ apiBase = "", deviceId, fetchImpl = fetch } = {}) {
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
    const pending = (await getAllRecords(STORES.OUTBOX))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, safeBatchSize);

    if (pending.length === 0) return { pushed: 0, pending: 0 };

    const result = await this.request("/api/sync/push", {
      method: "POST",
      body: JSON.stringify({ changes: pending }),
    });

    const acceptedIds = new Set(result.acceptedIds ?? []);
    await Promise.all(
      pending
        .filter((item) => acceptedIds.has(item.id))
        .map((item) => deleteRecord(STORES.OUTBOX, item.id))
    );
    return {
      pushed: acceptedIds.size,
      pending: Math.max(0, pending.length - acceptedIds.size),
      conflicts: result.conflicts ?? [],
    };
  }

  async pullRemote({ cursor = null } = {}) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const result = await this.request(`/api/sync/pull${query}`, { method: "GET" });

    for (const change of result.changes ?? []) {
      if (change.entityType === "questionProgress" && change.operation === "upsert") {
        await putRecord(STORES.PROGRESS, change.payload);
      }
      if (change.entityType === "practiceSet" && change.operation === "upsert") {
        await putRecord(STORES.SETS, change.payload);
      }
      if (change.entityType === "practiceSetAnswer" && change.operation === "upsert") {
        await putRecord(STORES.ANSWERS, change.payload);
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
      const push = await this.pushPending();
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
        pushed: push.pushed,
        conflicts: push.conflicts,
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
