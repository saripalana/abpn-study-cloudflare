import { buildStudyCoachDataset } from "./client/weakness-analytics.js";
import { getAllRecords, STORES } from "./client/storage.js";
import { ensureStagingSession } from "./client/staging-lifecycle.js";
import {
  assertNoProtectedQuestionCopies,
  clearStudyCoachOutput,
  createCurrentStudyCoachPackage,
  downloadStudyCoachPackage,
  loadStudyCoachOutput,
  loadStudyCoachOutputHistory,
  parseStudyCoachOutputFile,
  prepareStudyCoachOutput,
  protectedStudyCoachBanks,
  saveStudyCoachOutput,
} from "./client/study-coach-package.js";
import { installQuestionBankPackagesAtomically, loadInstalledQuestionBanks } from "./client/question-bank-import.js";
import {
  buildStudyCoachDeckLibraryUpdate,
  STUDY_COACH_BANK_ID,
} from "./client/study-coach-deck-library.js";
import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  banksForOverallMetrics,
  includeStudyCoachInOverallMetrics,
  studyRecordsForBanks,
} from "./client/study-coach-metrics-scope.js";

await ensureStagingSession();

const CONSENT_VERSION = 2;
const EXCHANGE_CONSENT_VERSION = 1;
const deviceId = localStorage.getItem("abpn-study:device-id") || crypto.randomUUID();
localStorage.setItem("abpn-study:device-id", deviceId);

let currentBanks = [];
let permissionEnabled = false;
let refreshTimer = null;
let refreshInFlight = null;
let outputFileAction = "import";
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
  const metricBanks = banksForOverallMetrics(currentBanks, includeStudyCoachInOverallMetrics());
  const metricState = studyRecordsForBanks({ banks: metricBanks, progress, sets, answers });
  return buildStudyCoachDataset(metricBanks, metricState.progress, {}, {
    sets: metricState.sets,
    answers: metricState.answers,
  });
}

function currentPackageBanks() {
  return banksForOverallMetrics(currentBanks, includeStudyCoachInOverallMetrics());
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
  const sharedDataPresent = Boolean(status.snapshotPresent || status.packagePresent || status.outputPresent);
  if (!status.enabled) {
    return sharedDataPresent
      ? `Off · shared study data stored but inaccessible · ${status.deleteCount} deletion(s)`
      : `Off · no shared study data · ${status.deleteCount} deletion(s)`;
  }
  if (!status.exchangeEnabled) {
    return `Analysis sharing remains on, but full-package exchange requires fresh approval · ${status.deleteCount} deletion(s)${suffix}`;
  }
  return `On until revoked · last update ${formatTimestamp(status.lastPublishedAt)} · ${status.publishCount} refresh(es) · ${status.accessCount} snapshot access(es) · ${status.exchangePublishCount || 0} exchange publish(es) · ${status.exchangeAccessCount || 0} exchange access(es) · ${status.deleteCount} deletion(s)${suffix}`;
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
      ${output.generatedDecks?.length ? `<div class="coach-output-block"><h5>Generated question sets</h5><ul>${output.generatedDecks.map((deck) => `
        <li><strong>${esc(deck.title)}</strong>${deck.objective ? `: ${esc(deck.objective)}` : ""}<div class="muted">${deck.questionCount} question(s) · added to the next numbered Study Coach test</div></li>
      `).join("")}</ul></div>` : ""}
      ${output.studyActions.length ? `<div class="coach-output-block"><h5>Study actions</h5><ul>${output.studyActions.map((action) => `<li>${esc(action)}</li>`).join("")}</ul></div>` : ""}
      ${output.notes.length ? `<div class="coach-output-block"><h5>Notes</h5><ul>${output.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul></div>` : ""}
    </div>
  `;
}

async function installGeneratedDecks(output) {
  const generatedDecks = Array.isArray(output?.generatedDecks) ? output.generatedDecks : [];
  if (!generatedDecks.length) return [];
  const protectedBanks = protectedStudyCoachBanks(currentBanks);
  await assertNoProtectedQuestionCopies(generatedDecks, protectedBanks);
  const reservedIds = protectedBanks.map((bank) => bank.id);
  const existingBank = currentBanks.find((bank) => bank.id === STUDY_COACH_BANK_ID) || null;
  const update = buildStudyCoachDeckLibraryUpdate({
    existingBank,
    generatedDecks,
    generatedAt: output.generatedAt,
  });
  if (!update.changed) return [];
  const [installed] = await installQuestionBankPackagesAtomically([update.package], { reservedIds });
  return [{
    title: update.testTitle,
    bankId: installed.bank.id,
    questionCount: update.addedQuestions,
    totalQuestionCount: installed.bank.questions.length,
    status: installed.status,
  }];
}

async function refreshCoachDeckView() {
  const systemValidationFixtures = QUESTION_BANKS.filter((bank) => bank.contentClass === "system-validation");
  const installedBanks = await loadInstalledQuestionBanks(systemValidationFixtures);
  QUESTION_BANKS.splice(0, QUESTION_BANKS.length, ...installedBanks);
  const { refreshApplication } = await import("./app.js");
  await refreshApplication();
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
  const archivePackage = section.querySelector("#archiveStudyCoachPackageBtn");
  const publishOutput = section.querySelector("#publishStudyCoachOutputBtn");
  const pullOutput = section.querySelector("#pullStudyCoachOutputBtn");
  const importOutput = section.querySelector("#importStudyCoachOutputBtn");
  const clearOutput = section.querySelector("#clearStudyCoachOutputBtn");
  const outputNode = section.querySelector("#studyCoachOutput");
  let currentOutput = await loadStudyCoachOutput();
  let outputHistory = await loadStudyCoachOutputHistory();
  const renderOutputs = () => {
    if (!outputNode) return;
    if (!currentOutput) {
      outputNode.innerHTML = '<div class="empty">No Study Coach output imported yet.</div>';
      return;
    }
    const previousOutputs = outputHistory
      .filter((entry) => entry?.generatedAt !== currentOutput.generatedAt)
      .slice(0, 5);
    renderCoachOutput(outputNode, currentOutput);
    if (!previousOutputs.length) return;
    outputNode.insertAdjacentHTML("beforeend", `
      <div class="coach-output-block" style="margin-top:1rem">
        <h5>Output history</h5>
        <ul>${previousOutputs.map((entry) => `
          <li>
            <strong>${esc(formatTimestamp(entry.generatedAt))}</strong>
            <span class="muted"> · ${esc(entry.summary)}</span>
            ${Array.isArray(entry.generatedDecks) && entry.generatedDecks.length ? `<div class="muted">${entry.generatedDecks.length} coach deck(s) carried in this output.</div>` : ""}
          </li>
        `).join("")}</ul>
      </div>
    `);
  };
  renderOutputs();
  let driveExchangeConfigured = false;

  const refreshDriveExchangeStatus = async () => {
    if (!permissionEnabled) {
      driveExchangeConfigured = false;
      if (archivePackage) archivePackage.disabled = true;
      packageStatusNode.textContent = "Approve Study Coach sharing before checking the restricted Google Drive exchange.";
      return;
    }
    try {
      const exchange = await request("/api/study-coach/google-drive");
      driveExchangeConfigured = Boolean(exchange.configured);
      if (archivePackage) archivePackage.disabled = !driveExchangeConfigured;
      packageStatusNode.textContent = exchange.configured
        ? `Cloudflare is the live Study Coach lane. Google Drive archive is ready · latest archive ${formatExchangeFile(exchange.latestPackage)} · latest drive output ${formatExchangeFile(exchange.latestOutput)}.`
        : "Cloudflare is the live Study Coach lane. Google Drive archive is not configured, but local package download and local coach-output import remain available.";
    } catch (error) {
      driveExchangeConfigured = false;
      if (archivePackage) archivePackage.disabled = true;
      packageStatusNode.textContent = `Cloudflare is the live Study Coach lane. Google Drive archive status could not be read: ${error.message}`;
    }
  };

  const applyImportedOutput = async (output, message) => {
    const installedDecks = await installGeneratedDecks(output);
    currentOutput = output;
    await saveStudyCoachOutput(currentOutput);
    outputHistory = await loadStudyCoachOutputHistory();
    renderOutputs();
    if (installedDecks.length) {
      await refreshCoachDeckView();
    }
    packageStatusNode.textContent = installedDecks.length
      ? `${message} Added ${installedDecks.map((deck) => `${deck.title} (${deck.questionCount} new; ${deck.totalQuestionCount} total)`).join(", ")} to the Study Coach Question Bank in the Deck Library.`
      : message;
  };

  exportPackage?.addEventListener("click", async () => {
    exportPackage.disabled = true;
    try {
      const pkg = await createCurrentStudyCoachPackage({ banks: currentPackageBanks(), appVersion: "1.0.0" });
      downloadStudyCoachPackage(pkg);
      packageStatusNode.textContent = `Full Study Coach package downloaded: ${formatTimestamp(pkg.exportedAt)} · includes full question references, progress, tests, and answers.`;
    } catch (error) {
      packageStatusNode.textContent = `Study Coach package export failed: ${error.message}`;
    } finally {
      exportPackage.disabled = false;
    }
  });

  publishPackage?.addEventListener("click", async () => {
    publishPackage.disabled = true;
    try {
      const pkg = await createCurrentStudyCoachPackage({ banks: currentPackageBanks(), appVersion: "1.0.0" });
      const result = await request("/api/assistant/study-coach/package", {
        method: "PUT",
        body: JSON.stringify(pkg),
      });
      status = await request("/api/assistant/study-coach/permission");
      render();
      packageStatusNode.textContent = `Study Coach package shared to Cloudflare: ${formatTimestamp(result.file?.createdAt)} · ${result.file?.questionCount || 0} question(s) across ${result.file?.bankCount || 0} deck(s).`;
    } catch (error) {
      packageStatusNode.textContent = `Cloudflare Study Coach package share failed: ${error.message}`;
    } finally {
      publishPackage.disabled = !permissionEnabled;
    }
  });

  archivePackage?.addEventListener("click", async () => {
    if (!driveExchangeConfigured) return;
    archivePackage.disabled = true;
    try {
      const pkg = await createCurrentStudyCoachPackage({ banks: currentPackageBanks(), appVersion: "1.0.0" });
      const result = await request("/api/study-coach/google-drive/package", {
        method: "PUT",
        body: JSON.stringify(pkg),
      });
      packageStatusNode.textContent = `Study Coach package archived to Google Drive: ${formatTimestamp(result.file?.createdAt)} · ${result.file?.questionCount || 0} question(s) across ${result.file?.bankCount || 0} deck(s).`;
    } catch (error) {
      packageStatusNode.textContent = `Google Drive package archive failed: ${error.message}`;
    } finally {
      archivePackage.disabled = !driveExchangeConfigured;
    }
  });

  publishOutput?.addEventListener("click", () => {
    outputFileAction = "publish";
    outputImportInput.click();
  });

  pullOutput?.addEventListener("click", async () => {
    pullOutput.disabled = true;
    try {
      const result = await request("/api/assistant/study-coach/output");
      const protectedBanks = protectedStudyCoachBanks(currentBanks);
      const preparedOutput = await prepareStudyCoachOutput(result.output, {
        reservedIds: protectedBanks.map((bank) => bank.id),
        protectedBanks,
      });
      status = await request("/api/assistant/study-coach/permission");
      render();
      await applyImportedOutput(preparedOutput, `Latest Study Coach output pulled from Cloudflare: ${formatTimestamp(result.file?.createdAt)}.`);
    } catch (error) {
      packageStatusNode.textContent = `Cloudflare coach-output pull failed: ${error.message}`;
    } finally {
      pullOutput.disabled = !permissionEnabled;
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
    permissionEnabled = Boolean(status.enabled && status.exchangeEnabled);
    permission.checked = permissionEnabled;
    refresh.disabled = !permissionEnabled;
    verify.disabled = !permissionEnabled || !status.snapshotPresent;
    revoke.disabled = !status.enabled;
    deleteData.disabled = !Boolean(status.snapshotPresent || status.packagePresent || status.outputPresent);
    if (publishPackage) publishPackage.disabled = !permissionEnabled;
    if (archivePackage) archivePackage.disabled = !permissionEnabled || !driveExchangeConfigured;
    if (publishOutput) publishOutput.disabled = !permissionEnabled;
    if (pullOutput) pullOutput.disabled = !permissionEnabled;
    statusNode.textContent = sharingUnavailableError ? `Study Coach access is temporarily unavailable: ${sharingUnavailableError}` : statusText(status);
  };
  render();

  importOutput?.addEventListener("click", () => {
    outputFileAction = "import";
    outputImportInput.click();
  });
  clearOutput?.addEventListener("click", async () => {
    clearOutput.disabled = true;
    try {
      await clearStudyCoachOutput();
      currentOutput = null;
      outputHistory = [];
      renderOutputs();
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
        body: JSON.stringify({
          enabled: permission.checked,
          consentVersion: CONSENT_VERSION,
          exchangeConsentVersion: permission.checked ? EXCHANGE_CONSENT_VERSION : 0,
        }),
      });
      permissionEnabled = Boolean(status.enabled && status.exchangeEnabled);
      if (status.enabled) status = await publishCurrentDataset();
      render();
      await refreshDriveExchangeStatus();
    } catch (error) {
      permission.checked = Boolean(status.enabled && status.exchangeEnabled);
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
      refresh.disabled = !Boolean(status.enabled && status.exchangeEnabled);
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
      verify.disabled = !Boolean(status.enabled && status.exchangeEnabled) || !status.snapshotPresent;
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
  await refreshDriveExchangeStatus();

  // Repair an enabled session that predates automatic refreshing.
  if (status.enabled && !status.snapshotPresent) {
    try { status = await publishCurrentDataset(); render(); } catch (error) { statusNode.textContent = error.message; }
  }

  outputImportInput.onchange = async () => {
    const [file] = outputImportInput.files ?? [];
    outputImportInput.value = "";
    if (!file) return;
    const selectedFileName = file.name || "selected file";
    try {
      const protectedBanks = protectedStudyCoachBanks(currentBanks);
      const output = await parseStudyCoachOutputFile(file, {
        reservedIds: protectedBanks.map((bank) => bank.id),
        protectedBanks,
      });
      if (outputFileAction === "publish") {
        if (publishOutput) publishOutput.disabled = true;
        const result = await request("/api/assistant/study-coach/output", {
          method: "PUT",
          body: JSON.stringify(output),
        });
        status = await request("/api/assistant/study-coach/permission");
        render();
        await applyImportedOutput(output, `Study Coach output published to Cloudflare from ${selectedFileName}: ${formatTimestamp(result.file?.createdAt)}.`);
      } else {
        await applyImportedOutput(output, `Study Coach output imported from ${selectedFileName}: ${formatTimestamp(output.generatedAt)}.`);
      }
    } catch (error) {
      const prefix = outputFileAction === "publish"
        ? "Study Coach output publish failed"
        : "Study Coach output import failed";
      packageStatusNode.textContent = `${prefix} for ${selectedFileName}: ${error.message}`;
    } finally {
      outputFileAction = "import";
      if (publishOutput) publishOutput.disabled = !permissionEnabled;
    }
  };
}
