import { SYNC_CLIENT_LIMITS, SyncClient, clearSyncSuspension, getSyncState } from "./client/sync.js";
import { ensureStagingSession, STAGING_SESSION_KEY } from "./client/staging-lifecycle.js";

// Module scripts may load concurrently when bootstrap uses top-level await.
// Reuse the same preparation promise before reading the per-session device ID.
await ensureStagingSession();

const syncButton = document.getElementById("syncBtn");
const syncStatus = document.getElementById("syncStatus");
// Staging tabs must retain their own isolated identity even when a newer tab
// rotates the shared localStorage device id. Production has no session id and
// continues to use the durable local device id.
const deviceId = sessionStorage.getItem(STAGING_SESSION_KEY)
  || localStorage.getItem("abpn-study:device-id")
  || crypto.randomUUID();
localStorage.setItem("abpn-study:device-id", deviceId);

const client = new SyncClient({ deviceId });
let syncing = false;
let staleStagingSession = false;

function showStatus(text, detail = text) {
  syncStatus.textContent = text;
  syncStatus.title = detail;
  syncStatus.setAttribute("aria-label", detail);
}

function showStaleStagingState(reason) {
  staleStagingSession = true;
  syncButton.textContent = "Restart staging sync";
  showStatus(
    "Local only · sync paused",
    `This staging window was replaced by a newer one. Select Restart staging sync to make this window active. ${reason ? `${reason}. ` : ""}Local study data is safe.`,
  );
}

async function renderStoredSyncState() {
  const state = await getSyncState();
  if (state.suspended) {
    if (String(state.suspensionReason || "").includes("Staging session is no longer active")) {
      showStaleStagingState(state.suspensionReason);
      return;
    }
    showStatus("Local only · sync paused", `Cloud synchronization is paused: ${state.suspensionReason || "safety shutdown"}. Local study data remains available.`);
    return;
  }
  if (state.lastSuccessAt) {
    showStatus("Cloud ready", `Last successful synchronization: ${new Date(state.lastSuccessAt).toLocaleString()}`);
    return;
  }
  showStatus("Local only", "Progress is saved locally. Cloud synchronization has not completed yet.");
}

async function runSync({ background = false } = {}) {
  if (syncing) return { status: "already-running" };
  syncing = true;
  syncButton.disabled = true;
  if (!background) showStatus("Syncing…", "Checking the protected Cloudflare synchronization service.");
  try {
    if (!background) await clearSyncSuspension();
    const result = await client.synchronize({ background, force: !background });
    if (result.status === "suspended") {
      showStatus("Local only · sync paused", `Cloud synchronization is paused: ${result.reason}. Local study data remains available.`);
    } else if (result.status === "skipped") {
      showStatus("Local only", "No cloud operation was needed. Local study data remains available.");
    } else {
      staleStagingSession = false;
      syncButton.textContent = "Sync";
      const conflicts = result.conflicts?.length || 0;
      showStatus(
        conflicts ? "Synced · review needed" : "Cloud ready",
        `${result.pushed || 0} local change(s) uploaded, ${result.pulled || 0} remote change(s) received, ${result.pending || 0} still waiting, ${conflicts} conflict(s).`
      );
    }
    return result;
  } catch (error) {
    if (error?.responseBody?.staleSession) {
      showStaleStagingState(error.message);
      return { status: "stale-session", error };
    }
    const state = error.syncState || await getSyncState();
    if (state.suspended) {
      showStatus("Local only · sync paused", `Cloud synchronization was paused after a safety failure: ${state.suspensionReason || error.message}. Local study data is safe.`);
    } else {
      showStatus("Sync failed · local data safe", error.message || "Cloud synchronization failed. Local study data remains available.");
    }
    return { status: "failed", error };
  } finally {
    syncing = false;
    syncButton.disabled = false;
  }
}

syncButton.onclick = () => {
  if (staleStagingSession) {
    sessionStorage.removeItem(STAGING_SESSION_KEY);
    location.reload();
    return;
  }
  void runSync();
};
window.addEventListener("online", () => void runSync({ background: true }), { passive: true });
setInterval(() => void runSync({ background: true }), SYNC_CLIENT_LIMITS.minimumBackgroundIntervalMs);

void renderStoredSyncState();

// Recovery shadowing must capture the state after the opening cloud merge, not
// race it. Bootstrap awaits this one bounded, failure-safe synchronization
// before it attaches the backup controller.
export const initialSyncReady = runSync({ background: true });
