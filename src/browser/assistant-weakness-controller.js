import { buildStudyCoachDataset } from "./client/weakness-analytics.js";
import { getAllRecords, STORES } from "./client/storage.js";
import { ensureStagingSession } from "./client/staging-lifecycle.js";

await ensureStagingSession();

const CONSENT_VERSION = 2;
const deviceId = localStorage.getItem("abpn-study:device-id") || crypto.randomUUID();
localStorage.setItem("abpn-study:device-id", deviceId);

let currentBanks = [];
let permissionEnabled = false;
let refreshTimer = null;
let refreshInFlight = null;

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-abpn-device-id": deviceId, ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function buildCurrentDataset() {
  const [progress, sets, answers] = await Promise.all([
    getAllRecords(STORES.PROGRESS),
    getAllRecords(STORES.SETS),
    getAllRecords(STORES.ANSWERS),
  ]);
  return buildStudyCoachDataset(currentBanks, progress, {}, { sets, answers });
}

async function publishCurrentDataset() {
  if (!permissionEnabled || !currentBanks.length) return null;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const dataset = await buildCurrentDataset();
    await request("/api/assistant/study-coach/snapshot", { method: "POST", body: JSON.stringify(dataset) });
    return request("/api/assistant/study-coach/permission");
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/** Debounced automatic refresh used after answers, flags, and completed sets. */
export function scheduleStudyCoachRefresh({ banks } = {}) {
  if (banks?.length) currentBanks = banks;
  if (!permissionEnabled) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void publishCurrentDataset().then(() => {
      localStorage.removeItem("abpn-study:study-coach-last-error");
    }).catch((error) => {
      // Automatic refresh must never interrupt studying. Retain only a short
      // diagnostic string so the visible status can surface a real failure.
      localStorage.setItem("abpn-study:study-coach-last-error", String(error?.message || "Refresh failed").slice(0, 300));
    });
  }, 750);
}

function formatTimestamp(value) {
  if (!value) return "not shared yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "unknown";
}

function statusText(status) {
  const refreshError = localStorage.getItem("abpn-study:study-coach-last-error");
  const suffix = refreshError ? ` · last automatic refresh failed: ${refreshError}` : "";
  if (!status.enabled) {
    return status.snapshotPresent
      ? `Off · shared study data stored but inaccessible · ${status.deleteCount} deletion(s)`
      : `Off · no shared study data · ${status.deleteCount} deletion(s)`;
  }
  return `On until revoked · last update ${formatTimestamp(status.lastPublishedAt)} · ${status.publishCount} refresh(es) · ${status.accessCount} access(es) · ${status.deleteCount} deletion(s)${suffix}`;
}

export async function attachAssistantWeaknessControls({ root, banks }) {
  currentBanks = banks || currentBanks;
  const section = root?.matches?.("#studyCoachSection") ? root : root?.querySelector?.("#studyCoachSection");
  if (!section) return;
  const permission = section.querySelector("#studyCoachPermission");
  const refresh = section.querySelector("#refreshStudyCoachBtn");
  const verify = section.querySelector("#verifyStudyCoachAccessBtn");
  const revoke = section.querySelector("#revokeStudyCoachBtn");
  const deleteData = section.querySelector("#deleteStudyCoachDataBtn");
  const statusNode = section.querySelector("#studyCoachStatus");

  let status;
  try {
    status = await request("/api/assistant/study-coach/permission");
  } catch (error) {
    if (error.status === 404) { section.hidden = true; return; }
    section.hidden = false;
    for (const control of [permission, refresh, verify, revoke, deleteData]) control.disabled = true;
    statusNode.textContent = `Study Coach access is temporarily unavailable: ${error.message}`;
    return;
  }
  section.hidden = false;

  const render = () => {
    permissionEnabled = Boolean(status.enabled);
    permission.checked = permissionEnabled;
    refresh.disabled = !permissionEnabled;
    verify.disabled = !permissionEnabled || !status.snapshotPresent;
    revoke.disabled = !permissionEnabled;
    deleteData.disabled = !status.snapshotPresent;
    statusNode.textContent = statusText(status);
  };
  render();

  permission.addEventListener("change", async () => {
    permission.disabled = true;
    try {
      status = await request("/api/assistant/study-coach/permission", {
        method: "PUT",
        body: JSON.stringify({ enabled: permission.checked, consentVersion: CONSENT_VERSION }),
      });
      permissionEnabled = status.enabled;
      if (status.enabled) status = await publishCurrentDataset();
      render();
    } catch (error) {
      permission.checked = status.enabled;
      statusNode.textContent = error.message;
    } finally {
      permission.disabled = false;
    }
  });

  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    try {
      status = await publishCurrentDataset();
      render();
      statusNode.textContent = `Study Coach data refreshed · ${statusText(status)}`;
    } catch (error) {
      statusNode.textContent = error.message;
    } finally {
      refresh.disabled = !status.enabled;
    }
  });

  verify.addEventListener("click", async () => {
    verify.disabled = true;
    try {
      const result = await request("/api/assistant/study-coach/snapshot");
      if (result.aggregate?.schemaVersion !== 2 || result.aggregate?.consentVersion !== CONSENT_VERSION) {
        throw new Error("Study Coach data verification failed");
      }
      status = await request("/api/assistant/study-coach/permission");
      render();
      statusNode.textContent = `Study Coach access verified · ${statusText(status)}`;
    } catch (error) {
      statusNode.textContent = error.message;
    } finally {
      verify.disabled = !status.enabled || !status.snapshotPresent;
    }
  });

  revoke.addEventListener("click", async () => {
    permission.checked = false;
    permission.dispatchEvent(new Event("change"));
  });

  deleteData.addEventListener("click", async () => {
    deleteData.disabled = true;
    try {
      await request("/api/assistant/study-coach/snapshot", { method: "DELETE" });
      status = await request("/api/assistant/study-coach/permission");
      render();
      statusNode.textContent = `Shared Study Coach data deleted · ${statusText(status)}`;
    } catch (error) {
      statusNode.textContent = error.message;
    } finally {
      deleteData.disabled = !status.snapshotPresent;
    }
  });

  // Repair an enabled session that predates automatic refreshing.
  if (status.enabled && !status.snapshotPresent) {
    try { status = await publishCurrentDataset(); render(); } catch (error) { statusNode.textContent = error.message; }
  }
}
