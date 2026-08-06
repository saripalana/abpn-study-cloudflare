import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  analyzeQuestionBankUpdate,
  downloadQuestionBankPackage,
  exportInstalledQuestionBankPackage,
  installQuestionBankPackage,
  parseQuestionBankPackageFile,
} from "./client/question-bank-import.js";
import { publishCloudDeckPackage } from "./client/deck-library.js";
import { STORES, getRecord, putRecord, recordsByIndex } from "./client/storage.js";

const app = document.getElementById("app");
const importInput = document.getElementById("bankImportInput");
const SELECTED_BANK_KEY = "abpn-study:selected-bank";
let attaching = false;
let importBusy = false;
let metadataSignature = null;

const protectedBankIds = () => QUESTION_BANKS.filter((bank) => bank.protected).map((bank) => bank.id);
const bankDefinition = (id) => QUESTION_BANKS.find((bank) => bank.id === id) || null;

function sectionByHeading(text) {
  return [...app.querySelectorAll("h3")]
    .find((heading) => heading.textContent?.trim() === text)
    ?.closest("section") ?? null;
}

function activeBankId() {
  return app.dataset.activeBankId || localStorage.getItem(SELECTED_BANK_KEY);
}

function classificationLabel(bank) {
  if (bank.sourceType === "application-seed") return "Application-supplied Deck Library package";
  if (bank.sourceType === "system-validation") return "Built-in system validation bank";
  if (bank.contentClass === "assistant-supplemental") return "Assistant-created supplemental bank";
  return "User-imported source question bank";
}

function ensureImportControl() {
  const current = document.getElementById("importBankBtn");
  if (!current) return null;

  let button = current;
  if (!(current instanceof HTMLButtonElement)) {
    button = document.createElement("button");
    button.id = "importBankBtn";
    button.className = current.className || "secondary";
    button.textContent = current.textContent?.trim() || "Import question bank";
    current.replaceWith(button);
  }

  button.type = "button";
  button.className ||= "secondary";
  button.removeAttribute("for");
  button.removeAttribute("role");
  button.removeAttribute("tabindex");
  button.setAttribute("aria-controls", importInput.id);
  button.setAttribute("aria-haspopup", "dialog");
  button.onclick = null;
  button.disabled = false;
  return button;
}

function reportPickerFailure(error) {
  console.error("Question-bank file picker could not open", error);
  alert([
    "The question-bank file picker could not open.",
    "",
    "Refresh the page once and try Import question bank again.",
    "Your existing question banks and study progress were not changed.",
  ].join("\n"));
}

function openImportPicker() {
  if (importBusy) return;
  importInput.value = "";

  try {
    // Direct click is supported by both Chromium and WebKit when it occurs
    // synchronously inside the user's button or keyboard activation.
    importInput.click();
    return;
  } catch (primaryError) {
    try {
      if (typeof importInput.showPicker === "function") {
        importInput.showPicker();
        return;
      }
    } catch (fallbackError) {
      reportPickerFailure(fallbackError || primaryError);
      return;
    }
    reportPickerFailure(primaryError);
  }
}

// Capture the action before the dashboard's former placeholder onclick handler can
// run. The listener survives every dashboard redraw because it is delegated from
// the stable app container.
app.addEventListener("click", (event) => {
  const control = event.target instanceof Element ? event.target.closest("#importBankBtn") : null;
  if (!control || !app.contains(control)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openImportPicker();
}, true);

app.addEventListener("keydown", (event) => {
  const control = event.target instanceof Element ? event.target.closest("#importBankBtn") : null;
  if (!control || !app.contains(control) || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openImportPicker();
}, true);

async function seedBankMetadata() {
  const signature = QUESTION_BANKS
    .map((bank) => `${bank.id}:${bank.version || "1"}:${bank.checksum || "built-in"}:${bank.questions?.length || 0}`)
    .join("|");
  if (signature === metadataSignature) return;

  const now = new Date().toISOString();
  await Promise.all(QUESTION_BANKS.map((bank) => putRecord(STORES.BANKS, {
    id: bank.id,
    title: bank.title,
    shortTitle: bank.shortTitle || bank.title,
    description: bank.description || "",
    version: bank.version || "1",
    questionCount: bank.questions?.length || 0,
    sourceType: bank.sourceType || "repository-protected",
    contentClass: bank.contentClass || "source-material",
    sourceLabel: bank.sourceLabel || "",
    protected: Boolean(bank.protected),
    checksum: bank.checksum || null,
    importedAt: bank.importedAt || null,
    updatedAt: now,
  })));
  metadataSignature = signature;
}

async function importPackage(file) {
  if (importBusy || !file) return;
  importBusy = true;
  try {
    const prepared = await parseQuestionBankPackageFile(file, { reservedIds: protectedBankIds() });
    const incoming = prepared.bank;
    const [existing, progress, sets] = await Promise.all([
      getRecord(STORES.BANK_CONTENT, incoming.id),
      recordsByIndex(STORES.PROGRESS, "byBank", incoming.id),
      recordsByIndex(STORES.SETS, "byBank", incoming.id),
    ]);
    const analysis = analyzeQuestionBankUpdate(existing, incoming, {
      hasStudyData: progress.length > 0 || sets.length > 0,
    });

    if (analysis.status === "unchanged") {
      alert(`${incoming.title} version ${incoming.version} is already installed with identical content.`);
      return;
    }

    const action = analysis.status === "new" ? "Import" : "Update";
    const classification = classificationLabel(incoming);
    const details = [
      `${action} this question bank?`,
      "",
      `Name: ${incoming.title}`,
      `Bank id: ${incoming.id}`,
      `Version: ${incoming.version}`,
      `Questions: ${incoming.questions.length}`,
      `Classification: ${classification}`,
      incoming.sourceLabel ? `Source label: ${incoming.sourceLabel}` : null,
      analysis.status === "update" ? `New questions added: ${analysis.addedQuestions}` : null,
      "",
      incoming.contentClass === "assistant-supplemental"
        ? "This material will remain separate from source question banks and will be labeled as assistant supplemental content."
        : "This source package will be installed through the same versioned Deck Library used by every other question bank.",
      "The deck is saved to your protected Cloudflare Deck Library and cached locally for offline study. Progress and completed tests remain separate by deck.",
    ].filter(Boolean).join("\n");

    if (!confirm(details)) return;

    const cloudPublication = await publishCloudDeckPackage(prepared);
    const result = await installQuestionBankPackage(prepared, { reservedIds: protectedBankIds() });
    localStorage.setItem(SELECTED_BANK_KEY, result.bank.id);
    alert([
      result.status === "new" ? "Deck added to your library successfully." : "Deck updated in your library successfully.",
      `${result.bank.title} · version ${result.bank.version}`,
      `${result.bank.questions.length} questions`,
      cloudPublication.queued ? "Saved locally and queued for Cloudflare when connectivity is restored." : "Saved in your protected Cloudflare Deck Library and cached locally.",
      "All other Deck Library packages were left unchanged.",
    ].join("\n"));
    location.reload();
  } catch (error) {
    console.error("Question-bank import failed", error);
    alert(`Question bank was not imported: ${error.message}`);
  } finally {
    importBusy = false;
    importInput.value = "";
  }
}

async function downloadActivePackage(bankId) {
  try {
    const packageData = await exportInstalledQuestionBankPackage(bankId);
    downloadQuestionBankPackage(packageData);
  } catch (error) {
    alert(`Question-bank package could not be downloaded: ${error.message}`);
  }
}

function appendOriginNote(hero, bank) {
  if (!hero || hero.querySelector(".bank-origin-note")) return;
  const note = document.createElement("p");
  note.className = "bank-origin-note";

  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = classificationLabel(bank);
  note.append(pill);

  if (bank.sourceLabel) {
    note.append(document.createTextNode(" "));
    const source = document.createElement("span");
    source.className = "muted";
    source.textContent = bank.sourceLabel;
    note.append(source);
  }
  hero.append(note);
}

async function attachControls() {
  // This must run before the asynchronous metadata work so a newly rendered
  // button is repaired even while another attachment pass is still active.
  ensureImportControl();
  if (attaching) return;
  attaching = true;
  try {
    await seedBankMetadata();
    ensureImportControl();
    const bankId = activeBankId();
    const bank = bankDefinition(bankId);
    if (!bank) return;

    appendOriginNote(app.querySelector(".hero > div:first-child"), bank);

    const protection = sectionByHeading("Data protection");
    const actions = protection?.querySelector("#deckManagementActions");
    const installed = bank.contentClass !== "system-validation" && await getRecord(STORES.BANK_CONTENT, bank.id);
    if (actions && installed && !actions.querySelector("#downloadBankPackageBtn")) {
      const button = document.createElement("button");
      button.id = "downloadBankPackageBtn";
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Download bank package";
      button.addEventListener("click", () => downloadActivePackage(bank.id));
      actions.append(button);
    }

    if (protection && !protection.querySelector(".question-bank-separation-note")) {
      const note = document.createElement("p");
      note.className = "question-bank-separation-note muted";
      note.textContent = "Question-bank packages are versioned separately from progress, completed tests, and portable study backups.";
      protection.append(note);
    }
  } finally {
    attaching = false;
  }
}

importInput.addEventListener("change", () => {
  const [file] = importInput.files || [];
  void importPackage(file);
});

const observer = new MutationObserver(() => void attachControls());
observer.observe(app, { childList: true, subtree: true });
void attachControls();
