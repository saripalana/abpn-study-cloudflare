import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  createPortableBackup,
  downloadPortableBackup,
  parsePortableBackupFile,
  restorePortableBackup,
} from "./client/backup.js";

const app = document.getElementById("app");

function knownQuestionIdsByBank() {
  return Object.fromEntries(
    QUESTION_BANKS.map((bank) => [bank.id, bank.questions.map((question) => question.id)])
  );
}

const importInput = document.createElement("input");
importInput.type = "file";
importInput.accept = "application/json,.json";
importInput.hidden = true;
importInput.id = "portableBackupImportInput";
document.body.append(importInput);

function findDataProtectionActions() {
  for (const heading of app.querySelectorAll("h3")) {
    if (heading.textContent?.trim() === "Data protection") {
      return heading.closest("section")?.querySelector(".actions") ?? null;
    }
  }
  return null;
}

function restoreConfirmation(backup) {
  const counts = backup.manifest ?? {};
  return [
    "Restore this ABPN Study backup?",
    "",
    `Created: ${new Date(backup.createdAt).toLocaleString()}`,
    `Progress records: ${counts.progress ?? backup.data.progress.length}`,
    `Practice sets: ${counts.practiceSets ?? backup.data.practiceSets.length}`,
    `Answers: ${counts.practiceSetAnswers ?? backup.data.practiceSetAnswers.length}`,
    "",
    "The restore merges records instead of clearing your device. Newer local records are kept. A recovery snapshot is created before any imported record is written. Deck content is not imported or replaced.",
  ].join("\n");
}

async function exportBackup(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing backup…";
  try {
    const backup = await createPortableBackup({ appVersion: "0.6.0" });
    downloadPortableBackup(backup);
    button.textContent = "Backup downloaded";
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
  const backup = await parsePortableBackupFile(file);
  if (!confirm(restoreConfirmation(backup))) return;
  const result = await restorePortableBackup(backup, { knownQuestionIdsByBank: knownQuestionIdsByBank() });
  alert([
    "Restore completed safely.",
    `Imported records: ${result.imported}`,
    `Newer local records preserved: ${result.keptNewerLocal}`,
    `Unknown-deck records skipped: ${result.skippedUnknownBank}`,
    `Unknown-question records skipped: ${result.skippedUnknownQuestion}`,
    `Practice sets quarantined for invalid references: ${result.quarantinedSets}`,
    "A pre-restore recovery snapshot was created.",
  ].join("\n"));
  location.reload();
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

function attachBackupControls() {
  const actions = findDataProtectionActions();
  if (!actions || actions.querySelector("#exportBackupBtn")) return;

  const exportButton = document.createElement("button");
  exportButton.id = "exportBackupBtn";
  exportButton.className = "secondary";
  exportButton.type = "button";
  exportButton.textContent = "Download backup";
  exportButton.addEventListener("click", () => exportBackup(exportButton));

  const restoreButton = document.createElement("button");
  restoreButton.id = "restoreBackupBtn";
  restoreButton.className = "secondary";
  restoreButton.type = "button";
  restoreButton.textContent = "Restore backup";
  restoreButton.addEventListener("click", () => importInput.click());

  actions.append(exportButton, restoreButton);
}

const observer = new MutationObserver(attachBackupControls);
observer.observe(app, { childList: true, subtree: true });
attachBackupControls();
