import { STORES, deleteRecord, getAllRecords, putRecord } from "./storage.js";

const DEFAULT_BATCH_SIZE = 100;

export class SyncClient {
  constructor({ apiBase = "", deviceId, fetchImpl = fetch } = {}) {
    if (!deviceId) throw new Error("deviceId is required");
    this.apiBase = apiBase.replace(/\/$/, "");
    this.deviceId = deviceId;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-abpn-device-id": this.deviceId,
        ...(options.headers ?? {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Sync request failed (${response.status}): ${text || response.statusText}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async pushPending({ batchSize = DEFAULT_BATCH_SIZE } = {}) {
    const pending = (await getAllRecords(STORES.OUTBOX))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, batchSize);

    if (pending.length === 0) return { pushed: 0 };

    const result = await this.request("/api/sync/push", {
      method: "POST",
      body: JSON.stringify({ changes: pending })
    });

    const acceptedIds = new Set(result.acceptedIds ?? pending.map((item) => item.id));
    await Promise.all(pending.filter((item) => acceptedIds.has(item.id)).map((item) => deleteRecord(STORES.OUTBOX, item.id)));
    return { pushed: acceptedIds.size, conflicts: result.conflicts ?? [] };
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

  async synchronize() {
    const push = await this.pushPending();
    const pull = await this.pullRemote();
    return {
      pushed: push.pushed,
      conflicts: push.conflicts,
      pulled: (pull.changes ?? []).length,
      nextCursor: pull.nextCursor ?? null
    };
  }
}
