import { buildContentFreeWeaknessAggregate } from "./client/weakness-analytics.js";
import { getAllRecords, STORES } from "./client/storage.js";
import { ensureStagingSession } from "./client/staging-lifecycle.js";

await ensureStagingSession();

const deviceId = localStorage.getItem("abpn-study:device-id") || crypto.randomUUID();
localStorage.setItem("abpn-study:device-id", deviceId);

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

async function progressForBank(bankId) {
  const rows = await getAllRecords(STORES.PROGRESS);
  return new Map(rows.filter((row) => row.bankId === bankId).map((row) => [row.questionId, row]));
}

function statusText(status) {
  if (!status.enabled) {
    return status.snapshotPresent
      ? `Off · aggregate stored but inaccessible · ${status.deleteCount} deletion(s)`
      : `Off · no aggregate stored · ${status.deleteCount} deletion(s)`;
  }
  return `On until you revoke it · ${status.publishCount} share(s) · ${status.accessCount} access(es) · ${status.deleteCount} deletion(s)`;
}

export async function attachAssistantWeaknessControls({ root, bank }) {
  const section = root?.querySelector?.("#assistantInsightsSection");
  if (!section) return;
  const permission = section.querySelector("#assistantInsightsPermission");
  const share = section.querySelector("#shareWeaknessBtn");
  const verify = section.querySelector("#verifyWeaknessAccessBtn");
  const revoke = section.querySelector("#revokeWeaknessBtn");
  const deleteAggregate = section.querySelector("#deleteWeaknessAggregateBtn");
  const statusNode = section.querySelector("#assistantInsightsStatus");

  let status;
  try {
    status = await request("/api/assistant/weakness/permission");
  } catch (error) {
    // A missing route means this staging-only capability is intentionally absent
    // (for example, in production). Transient staging failures remain visible.
    if (error.status === 404) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    permission.disabled = true;
    share.disabled = true;
    verify.disabled = true;
    revoke.disabled = true;
    deleteAggregate.disabled = true;
    statusNode.textContent = `Assistant access is temporarily unavailable: ${error.message}`;
    return;
  }
  section.hidden = false;

  const render = () => {
    permission.checked = status.enabled;
    share.disabled = !status.enabled;
    verify.disabled = !status.enabled || status.publishCount < 1;
    revoke.disabled = !status.enabled;
    deleteAggregate.disabled = !status.snapshotPresent;
    statusNode.textContent = statusText(status);
  };
  render();

  permission.addEventListener("change", async () => {
    permission.disabled = true;
    try {
      status = await request("/api/assistant/weakness/permission", {
        method: "PUT",
        body: JSON.stringify({ enabled: permission.checked }),
      });
      render();
    } catch (error) {
      permission.checked = status.enabled;
      statusNode.textContent = error.message;
    } finally {
      permission.disabled = false;
    }
  });

  share.addEventListener("click", async () => {
    share.disabled = true;
    try {
      const aggregate = buildContentFreeWeaknessAggregate(bank, await progressForBank(bank.id));
      await request("/api/assistant/weakness/snapshot", { method: "POST", body: JSON.stringify(aggregate) });
      status = await request("/api/assistant/weakness/permission");
      render();
      statusNode.textContent = `Shared content-free summary · ${statusText(status)}`;
    } catch (error) {
      statusNode.textContent = error.message;
    } finally {
      share.disabled = !status.enabled;
    }
  });

  verify.addEventListener("click", async () => {
    verify.disabled = true;
    try {
      const result = await request("/api/assistant/weakness/snapshot");
      if (result.aggregate?.schemaVersion !== 1) throw new Error("Assistant summary verification failed");
      status = await request("/api/assistant/weakness/permission");
      render();
      statusNode.textContent = `Access verified without question content · ${statusText(status)}`;
    } catch (error) {
      statusNode.textContent = error.message;
    } finally {
      verify.disabled = !status.enabled || status.publishCount < 1;
    }
  });

  revoke.addEventListener("click", async () => {
    permission.checked = false;
    permission.dispatchEvent(new Event("change"));
  });

  deleteAggregate.addEventListener("click", async () => {
    deleteAggregate.disabled = true;
    try {
      await request("/api/assistant/weakness/snapshot", { method: "DELETE" });
      status = await request("/api/assistant/weakness/permission");
      render();
      statusNode.textContent = `Shared aggregate deleted · ${statusText(status)}`;
    } catch (error) {
      statusNode.textContent = error.message;
    } finally {
      deleteAggregate.disabled = !status.snapshotPresent;
    }
  });
}
