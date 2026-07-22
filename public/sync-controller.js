import { SyncClient, getSyncState } from "./client/sync.js";

const syncButton = document.getElementById("syncBtn");
const syncStatus = document.getElementById("syncStatus");
const deviceId = localStorage.getItem("abpn-study:device-id") || crypto.randomUUID();
localStorage.setItem("abpn-study:device-id", deviceId);

const client = new SyncClient({ deviceId });

function showStatus(text, detail = text) {
  syncStatus.textContent = text;
  syncStatus.title = detail;
  syncStatus.setAttribute("aria-label", detail);
}

async function renderStoredSyncState() {
  const state = await getSyncState();
  if (state.suspended) {
    showStatus("Local only · sync paused", `Cloud synchronization is paused: ${state.suspensionReason || "safety shutdown"}. Local study data remains available.`);
    return;
  }
  if (state.lastSuccessAt) {
    showStatus("Cloud ready", `Last successful synchronization: ${new Date(state.lastSuccessAt).toLocaleString()}`);
    return;
  }
  showStatus("Local only", "Progress is saved locally. Cloud synchronization has not completed yet.");
}

syncButton.onclick = async () => {
  syncButton.disabled = true;
  showStatus("Syncing…", "Checking the protected Cloudflare synchronization service.");
  try {
    const result = await client.synchronize();
    if (result.status === "suspended") {
      showStatus("Local only · sync paused", `Cloud synchronization is paused: ${result.reason}. Local study data remains available.`);
    } else if (result.status === "skipped") {
      showStatus("Local only", "No cloud operation was needed. Local study data remains available.");
    } else {
      const conflicts = result.conflicts?.length || 0;
      showStatus(
        conflicts ? "Synced · review needed" : "Cloud ready",
        `${result.pushed || 0} local change(s) uploaded, ${result.pulled || 0} remote change(s) received, ${result.pending || 0} still waiting, ${conflicts} conflict(s).`
      );
    }
  } catch (error) {
    const state = error.syncState || await getSyncState();
    if (state.suspended) {
      showStatus("Local only · sync paused", `Cloud synchronization was paused after a safety failure: ${state.suspensionReason || error.message}. Local study data is safe.`);
    } else {
      showStatus("Sync failed · local data safe", error.message || "Cloud synchronization failed. Local study data remains available.");
    }
  } finally {
    syncButton.disabled = false;
  }
};

void renderStoredSyncState();
