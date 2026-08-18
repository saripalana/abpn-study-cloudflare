import { buildStudyCoachDataset } from "./client/weakness-analytics.js";
import { getAllRecords, STORES } from "./client/storage.js";
import { ensureStagingSession } from "./client/staging-lifecycle.js";
import {
  clearStudyCoachOutput,
  createCurrentStudyCoachPackage,
  downloadStudyCoachPackage,
  loadStudyCoachOutput,
  parseStudyCoachOutputFile,
  saveStudyCoachOutput,
  validateStudyCoachOutput,
} from "./client/study-coach-package.js";

await ensureStagingSession();

const CONSENT_VERSION = 2;
const deviceId = localStorage.getItem("abpn-study:device-id") || crypto.randomUUID();
localStorage.setItem("abpn-study:device-id", deviceId);

let currentBanks = [];
let permissionEnabled = false;
let refreshTimer = null;
let refreshInFlight = null;
const outputImportInput = document.createElement("input");
outputImportInput.type = "file";
outputImportInput.accept = "application/json,.json";
outputImportInput.hidden = true;
outputImportInput.id = "studyCoachOutputImportInput";
document.body.append(outputImportInput);

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

function formatExchangeFile(file) {
  if (!file) return "none";
  return `${formatTimestamp(file.createdAt)} · ${Math.max(0, Math.round(Number(file.byteCount || 0) / 1024))} KB`;
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

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCoachOutput(outputNode, output) {
  if (!outputNode) return;
  if (!output) {
    outputNode.innerHTML = '<div class="empty">No Study Coach output imported yet.</div>';
    return;
  }
  outputNode.innerHTML = `
    <div class="coach-output-card">
      <div class="coach-output-header">
        <div>
          <div class="eyebrow" style="color:var(--blue)">LOCAL COACH OUTPUT</div>
          <h4>Imported coaching plan</h4>
          <p class="muted">Generated ${esc(formatTimestamp(output.generatedAt))}${output.sourcePackageGeneratedAt ? ` · from package ${esc(formatTimestamp(output.sourcePackageGeneratedAt))}` : ''}</p>
        </div>
      </div>
      <p>${esc(output.summary)}</p>
      ${output.progressMetrics.length ? `<div class="coach-metric-grid">${output.progressMetrics.map((metric) => `
        <div class="stat">
          <strong>${esc(metric.value)}</strong>
          <span>${esc(metric.label)}</span>
          ${metric.detail ? `<small>${esc(metric.detail)}</small>` : ""}
        </div>
      `).join("")}</div>` : ""}
      ${output.focusAreas.length ? `<div class="coach-output-block"><h5>Focus areas</h5><ul>${output.focusAreas.map((area) => `
        <li><strong>${esc(area.title)}</strong>: ${esc(area.rationale)}${area.recommendedQuestionCount ? ` (${area.recommendedQuestionCount} question target)` : ""}${area.questionRefs.length ? ` · ${area.questionRefs.length} linked question reference(s)` : ""}</li>
      `).join("")}</ul></div>` : ""}
      ${output.recommendedSets.length ? `<div class="coach-output-block"><h5>Recommended sets</h5><ul>${output.recommendedSets.map((set) => `
        <li><strong>${esc(set.title)}</strong>: ${esc(set.objective)} · ${set.questionCount} question(s) · ${esc(set.mode)} · ${set.timed ? "timed" : "untimed"}${set.instructions ? `<div class="muted">${esc(set.instructions)}</div>` : ""}${set.questionRefs.length ? `<div class="muted">${set.questionRefs.length} linked question reference(s)</div>` : ""}</li>
      `).join("")}</ul></div>` : ""}
      ${output.studyActions.length ? `<div class="coach-output-block"><h5>Study actions</h5><ul>${output.studyActions.map((action) => `<li>${esc(action)}</li>`).join("")}</ul></div>` : ""}
      ${output.notes.length ? `<div class="coach-output-block"><h5>Notes</h5><ul>${output.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul></div>` : ""}
    </div>
  `;
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
  const packageStatusNode = section.querySelector("#studyCoachPackageStatus");
  const exportPackage = section.querySelector("#exportStudyCoachPackageBtn");
  const publishPackage = section.querySelector("#publishStudyCoachPackageBtn");
  const pullOutput = section.querySelector("#pullStudyCoachOutputBtn");
  const importOutput = section.querySelector("#importStudyCoachOutputBtn");
  const clearOutput = section.querySelector("#clearStudyCoachOutputBtn");
  const outputNode = section.querySelector("#studyCoachOutput");
  let currentOutput = await loadStudyCoachOutput();
  renderCoachOutput(outputNode, currentOutput);
  let exchangeConfigured = false;

  const applyImportedOutput = async (output, message) => {
    currentOutput = output;
    await saveStudyCoachOutput(currentOutput);
    renderCoachOutput(outputNode, currentOutput);
    packageStatusNode.textContent = message;
  };

  exportPackage?.addEventListener("click", async () => {
    exportPackage.disabled = true;
    try {
      const pkg = await createCurrentStudyCoachPackage({ banks: currentBanks, appVersion: "1.0.0" });
      downloadStudyCoachPackage(pkg);
      packageStatusNode.textContent = `Full Study Coach package downloaded: ${formatTimestamp(pkg.exportedAt)} · includes full question references, progress, tests, and answers.`;
    } catch (error) {
      packageStatusNode.textContent = `Study Coach package export failed: ${error.message}`;
    } finally {
      exportPackage.disabled = false;
    }
  });

  publishPackage?.addEventListener("click", async () => {
    if (!exchangeConfigured) return;
    publishPackage.disabled = true;
    try {
      const pkg = await createCurrentStudyCoachPackage({ banks: currentBanks, appVersion: "1.0.0" });
      const result = await request("/api/study-coach/google-drive/package", {
        method: "PUT",
        body: JSON.stringify(pkg),
      });
      packageStatusNode.textContent = `Study Coach package published to Google Drive: ${formatTimestamp(result.file?.createdAt)} · ${result.file?.questionCount || 0} question(s) across ${result.file?.bankCount || 0} deck(s).`;
    } catch (error) {
      packageStatusNode.textContent = `Google Drive package publish failed: ${error.message}`;
    } finally {
      publishPackage.disabled = false;
    }
  });

  pullOutput?.addEventListener("click", async () => {
    if (!exchangeConfigured) return;
    pullOutput.disabled = true;
    try {
      const result = await request("/api/study-coach/google-drive/output/latest");
      const output = validateStudyCoachOutput(result.output);
      await applyImportedOutput(output, `Latest Study Coach output pulled from Google Drive: ${formatTimestamp(result.file?.createdAt)}.`);
    } catch (error) {
      packageStatusNode.textContent = `Google Drive coach-output pull failed: ${error.message}`;
    } finally {
      pullOutput.disabled = false;
    }
  });

  let status = {
    enabled: false,
    snapshotPresent: false,
    publishCount: 0,
    accessCount: 0,
    deleteCount: 0,
    lastPublishedAt: null,
  };
  let sharingUnavailableError = "";

  const render = () => {
    permissionEnabled = Boolean(status.enabled);
    permission.checked = permissionEnabled;
    refresh.disabled = !permissionEnabled;
    verify.disabled = !permissionEnabled || !status.snapshotPresent;
    revoke.disabled = !permissionEnabled;
    deleteData.disabled = !status.snapshotPresent;
    statusNode.textContent = sharingUnavailableError ? `Study Coach access is temporarily unavailable: ${sharingUnavailableError}` : statusText(status);
  };
  render();

  importOutput?.addEventListener("click", () => outputImportInput.click());
  clearOutput?.addEventListener("click", async () => {
    clearOutput.disabled = true;
    try {
      await clearStudyCoachOutput();
      currentOutput = null;
      renderCoachOutput(outputNode, currentOutput);
      packageStatusNode.textContent = "Imported Study Coach output cleared from this browser.";
    } finally {
      clearOutput.disabled = false;
    }
  });

  permission.addEventListener("change", async () => {
    if (sharingUnavailableError) {
      permission.checked = false;
      return;
    }
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

  try {
    const exchange = await request("/api/study-coach/google-drive");
    exchangeConfigured = Boolean(exchange.configured);
    if (publishPackage) publishPackage.disabled = !exchangeConfigured;
    if (pullOutput) pullOutput.disabled = !exchangeConfigured;
    if (exchange.configured) {
      packageStatusNode.textContent = `Google Drive exchange ready · latest package ${formatExchangeFile(exchange.latestPackage)} · latest output ${formatExchangeFile(exchange.latestOutput)}.`;
    } else {
      packageStatusNode.textContent = "Google Drive exchange is not configured. Local package download/import remains available.";
    }
  } catch (error) {
    exchangeConfigured = false;
    if (publishPackage) publishPackage.disabled = true;
    if (pullOutput) pullOutput.disabled = true;
    packageStatusNode.textContent = `Google Drive exchange status could not be read: ${error.message}`;
  }

  try {
    status = await request("/api/assistant/study-coach/permission");
  } catch (error) {
    if (error.status === 404) { section.hidden = true; return; }
    sharingUnavailableError = error.message;
    for (const control of [permission, refresh, verify, revoke, deleteData]) control.disabled = true;
    render();
    return;
  }
  section.hidden = false;
  sharingUnavailableError = "";
  render();

  // Repair an enabled session that predates automatic refreshing.
  if (status.enabled && !status.snapshotPresent) {
    try { status = await publishCurrentDataset(); render(); } catch (error) { statusNode.textContent = error.message; }
  }

  outputImportInput.onchange = async () => {
    const [file] = outputImportInput.files ?? [];
    outputImportInput.value = "";
    if (!file) return;
    try {
      const output = await parseStudyCoachOutputFile(file);
      await applyImportedOutput(output, `Study Coach output imported: ${formatTimestamp(output.generatedAt)}.`);
    } catch (error) {
      packageStatusNode.textContent = `Study Coach output import failed: ${error.message}`;
    }
  };
}
