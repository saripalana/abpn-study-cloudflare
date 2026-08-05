import {
  createRecoveryBundle,
  downloadRecoveryBundle,
  parseRecoveryBundleFile,
  restoreRecoveryBundle,
  validateRecoveryBundle,
} from "./client/recovery-bundle.js";

const app = document.getElementById("app");
const importInput = document.createElement("input");
importInput.type = "file";
importInput.accept = "application/json,.json";
importInput.hidden = true;
importInput.id = "portableBackupImportInput";
document.body.append(importInput);

function restoreConfirmation(backup) {
  const counts = backup.manifest ?? {};
  return [
    "Merge this complete ABPN Study recovery backup?",
    "",
    `Created: ${new Date(backup.createdAt).toLocaleString()}`,
    `Question banks: ${counts.bankContent ?? backup.data.bankContent.length}`,
    `Progress records: ${counts.progress ?? backup.data.progress.length}`,
    `Tests: ${counts.practiceSets ?? backup.data.practiceSets.length}`,
    `Answers: ${counts.practiceSetAnswers ?? backup.data.practiceSetAnswers.length}`,
    "",
    "The restore is non-destructive: missing and newer records are added, newer current work is preserved, and a safety snapshot is created first.",
  ].join("\n");
}

async function exportBackup(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing backup…";
  try {
    const backup = await createRecoveryBundle({ appVersion: "1.0.0" });
    await downloadRecoveryBundle(backup);
    button.textContent = "Complete backup downloaded";
  } catch (error) {
    alert(`Backup could not be created: ${error.message}`);
    button.textContent = original;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = original;
    }, 1_200);
  }
}

async function restoreFromFile(file) {
  const backup = await parseRecoveryBundleFile(file);
  if (!confirm(restoreConfirmation(backup))) return;
  const result = await restoreRecoveryBundle(backup);
  alert([
    "Restore completed safely.",
    `Imported records: ${result.imported}`,
    `Current records preserved: ${result.keptCurrent}`,
    `Missing settings restored: ${result.settingsImported}`,
    "A pre-restore recovery snapshot was created.",
  ].join("\n"));
  // Defer reload so Safari can finish the IndexedDB transaction and alert task.
  setTimeout(() => location.reload(), 0);
}

importInput.addEventListener("change", async () => {
  const [file] = importInput.files ?? [];
  importInput.value = "";
  if (!file) return;
  try {
    await restoreFromFile(file);
  } catch (error) {
    alert(`Backup could not be restored: ${error.message}`);
  }
});

function deviceId() {
  return localStorage.getItem("abpn-study:device-id") || "unknown-device";
}

async function cloudRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-abpn-device-id": deviceId(), ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Cloudflare recovery request failed (${response.status}).`);
  }
  return response;
}

async function saveCloudflare(button, status) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Backing up…";
  try {
    const bundle = await createRecoveryBundle({ appVersion: "1.0.0" });
    const response = await cloudRequest("/api/recovery/cloudflare", { method: "PUT", body: JSON.stringify(bundle) });
    const result = await response.json();
    status.textContent = `Last complete backup: ${new Date(result.createdAt).toLocaleString()} · Cloudflare · verified`;
  } catch (error) {
    status.textContent = `Cloudflare backup failed safely: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function restoreCloudflare(button, status) {
  button.disabled = true;
  try {
    const response = await cloudRequest("/api/recovery/cloudflare/latest");
    const backup = await validateRecoveryBundle(await response.json());
    if (!confirm(restoreConfirmation(backup))) return;
    const result = await restoreRecoveryBundle(backup);
    status.textContent = `Restored safely: ${result.imported} records added or updated; current newer work preserved.`;
    setTimeout(() => location.reload(), 0);
  } catch (error) {
    status.textContent = `Cloudflare restore failed safely: ${error.message}`;
  } finally { button.disabled = false; }
}

async function saveGoogleDrive(button, status) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Backing up…";
  try {
    const bundle = await createRecoveryBundle({ appVersion: "1.0.0" });
    const response = await cloudRequest("/api/recovery/google-drive", { method: "PUT", body: JSON.stringify(bundle) });
    const result = await response.json();
    status.textContent = `Last complete backup: ${new Date(result.createdAt).toLocaleString()} · dedicated Google Drive folder · verified`;
  } catch (error) { status.textContent = `Google Drive backup failed safely: ${error.message}`; }
  finally { button.disabled = false; button.textContent = original; }
}

async function restoreGoogleDrive(button, status) {
  button.disabled = true;
  try {
    const response = await cloudRequest("/api/recovery/google-drive/latest");
    const backup = await validateRecoveryBundle(await response.json());
    if (!confirm(restoreConfirmation(backup))) return;
    const result = await restoreRecoveryBundle(backup);
    status.textContent = `Restored safely: ${result.imported} records added or updated; current newer work preserved.`;
    setTimeout(() => location.reload(), 0);
  } catch (error) { status.textContent = `Google Drive restore failed safely: ${error.message}`; }
  finally { button.disabled = false; }
}

function destinationCard({ title, destination, detail, statusText, actions, className = "" }) {
  const card = document.createElement("article");
  card.className = `recovery-card ${className}`.trim();
  card.innerHTML = `<div class="recovery-card-heading"><h4>${title}</h4><span class="pill">${destination}</span></div><p>${detail}</p><p class="recovery-status muted">${statusText}</p><div class="actions"></div>`;
  const actionRow = card.querySelector(".actions");
  for (const action of actions) actionRow.append(action);
  return card;
}

function button(id, label, handler, { disabled = false, title = "" } = {}) {
  const control = document.createElement("button");
  control.id = id;
  control.className = "secondary";
  control.type = "button";
  control.textContent = label;
  control.disabled = disabled;
  control.title = title;
  if (handler) control.addEventListener("click", handler);
  return control;
}

async function refreshCloudStatus(status) {
  try {
    const response = await cloudRequest("/api/recovery/cloudflare");
    const { backups } = await response.json();
    status.textContent = backups.length
      ? `Last complete backup: ${new Date(backups[0].createdAt).toLocaleString()} · verified · one per day retained for 3 days`
      : "No Cloudflare recovery backup yet.";
  } catch (error) { status.textContent = `Cloudflare status unavailable: ${error.message}`; }
}

function attachBackupControls() {
  const container = document.getElementById("recoveryDestinations");
  if (!container || container.dataset.ready === "true") return;
  container.dataset.ready = "true";

  const cloudSave = button("cloudflareCompleteBackupBtn", "Back up everything to Cloudflare", null);
  const cloudRestore = button("restoreCloudflareBackupBtn", "Restore latest Cloudflare backup", null);
  const cloudCard = destinationCard({
    title: "Cloudflare recovery",
    destination: "Protected cloud",
    detail: "Complete study workspace: decks, progress, flags, answers, active and completed tests, settings, and recovery metadata.",
    statusText: "Checking Cloudflare backup status…",
    actions: [cloudSave, cloudRestore],
  });
  const cloudStatus = cloudCard.querySelector(".recovery-status");
  cloudSave.onclick = () => saveCloudflare(cloudSave, cloudStatus);
  cloudRestore.onclick = () => restoreCloudflare(cloudRestore, cloudStatus);

  const driveSave = button("googleDriveCompleteBackupBtn", "Back up everything to Google Drive", null, { disabled: true });
  const driveRestore = button("restoreGoogleDriveBackupBtn", "Restore latest Google Drive backup", null, { disabled: true });
  const driveCard = destinationCard({
    title: "Google Drive recovery",
    destination: "Google Drive",
    detail: "A second complete cloud copy in the dedicated ABPN recovery folder. It never includes passwords or access tokens.",
    statusText: "Not connected. One-time restricted Google Drive authorization is required.",
    actions: [driveSave, driveRestore],
    className: "recovery-card-pending",
  });
  const driveStatus = driveCard.querySelector(".recovery-status");
  driveSave.onclick = () => saveGoogleDrive(driveSave, driveStatus);
  driveRestore.onclick = () => restoreGoogleDrive(driveRestore, driveStatus);

  const downloadButton = button("exportBackupBtn", "Download complete backup", null);
  downloadButton.onclick = () => exportBackup(downloadButton);
  const restoreButton = button("restoreBackupBtn", "Restore downloaded backup", () => importInput.click());
  const deviceCard = destinationCard({
    title: "Download or restore",
    destination: "Your device",
    detail: "One complete portable file for independent recovery. Save it wherever you choose; restore merges safely and preserves newer work.",
    statusText: "File destination: your browser’s Downloads folder.",
    actions: [downloadButton, restoreButton],
  });

  container.append(cloudCard, driveCard, deviceCard);
  void refreshCloudStatus(cloudStatus);
  void cloudRequest("/api/recovery/google-drive").then(async (response) => {
    const result = await response.json();
    if (!result.configured) return;
    driveSave.disabled = false;
    driveRestore.disabled = !result.backups?.length;
    driveCard.classList.remove("recovery-card-pending");
    driveStatus.textContent = result.backups?.length
      ? `Last complete backup: ${new Date(result.backups[0].createdAt).toLocaleString()} · one per day retained for 3 days`
      : "Connected to the dedicated ABPN recovery folder. No complete backup yet.";
  }).catch((error) => { driveStatus.textContent = `Google Drive status unavailable: ${error.message}`; });
}

const observer = new MutationObserver(attachBackupControls);
observer.observe(app, { childList: true, subtree: true });
attachBackupControls();
