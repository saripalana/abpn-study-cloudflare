import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  analyzeQuestionBankUpdate,
  installQuestionBankPackage,
  parseQuestionBankPackageFile,
} from "./client/question-bank-import.js";
import { fetchGithubQuestionBankFile } from "./client/github-question-bank-source.js";
import { STORES, getRecord, recordsByIndex } from "./client/storage.js";

const app = document.getElementById("app");
const SELECTED_BANK_KEY = "abpn-study:selected-bank";
const LAST_GITHUB_ADDRESS_KEY = "abpn-study:last-github-bank-address";
let importBusy = false;

const protectedBankIds = () => QUESTION_BANKS
  .filter((bank) => bank.protected)
  .map((bank) => bank.id);

function sectionByHeading(text) {
  return [...app.querySelectorAll("h3")]
    .find((heading) => heading.textContent?.trim() === text)
    ?.closest("section") ?? null;
}

function classificationLabel(bank) {
  return bank.contentClass === "assistant-supplemental"
    ? "Assistant-created supplemental bank"
    : "User-imported source question bank";
}

function setStatus(message, type = "info") {
  const status = document.getElementById("githubBankImportStatus");
  if (!status) return;
  status.textContent = message;
  status.dataset.type = type;
}

async function installFetchedPackage(file, sourceUrl) {
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
    setStatus(`${incoming.title} version ${incoming.version} is already installed.`, "success");
    return;
  }

  const action = analysis.status === "new" ? "Import" : "Update";
  const details = [
    `${action} this question bank from GitHub?`,
    "",
    `Name: ${incoming.title}`,
    `Bank id: ${incoming.id}`,
    `Version: ${incoming.version}`,
    `Questions: ${incoming.questions.length}`,
    `Classification: ${classificationLabel(incoming)}`,
    incoming.sourceLabel ? `Source label: ${incoming.sourceLabel}` : null,
    analysis.status === "update" ? `New questions added: ${analysis.addedQuestions}` : null,
    `Resolved package: ${sourceUrl}`,
    "",
    incoming.contentClass === "assistant-supplemental"
      ? "This material will remain separate from source question banks and will be labeled as assistant supplemental content."
      : "This material will remain separate from K&S, the validation bank, and assistant supplemental content.",
    "Question content is stored locally in its own versioned package store. Progress and completed tests remain separate.",
  ].filter(Boolean).join("\n");

  if (!confirm(details)) {
    setStatus("GitHub import cancelled. No data changed.");
    return;
  }

  const result = await installQuestionBankPackage(prepared, { reservedIds: protectedBankIds() });
  localStorage.setItem(SELECTED_BANK_KEY, result.bank.id);
  alert([
    result.status === "new" ? "Question bank imported from GitHub." : "Question bank updated from GitHub.",
    `${result.bank.title} · version ${result.bank.version}`,
    `${result.bank.questions.length} questions`,
    "K&S and all other question banks were left unchanged.",
  ].join("\n"));
  location.reload();
}

async function importFromGithub() {
  if (importBusy) return;
  const input = document.getElementById("githubBankUrlInput");
  const button = document.getElementById("githubBankImportBtn");
  const address = String(input?.value || "").trim();
  if (!address) {
    setStatus("Paste a GitHub repository or JSON-file address first.", "error");
    input?.focus();
    return;
  }

  localStorage.setItem(LAST_GITHUB_ADDRESS_KEY, address);
  importBusy = true;
  if (button) button.disabled = true;
  setStatus("Checking GitHub for a compatible question-bank package…");

  try {
    const { file, sourceUrl } = await fetchGithubQuestionBankFile(address);
    setStatus("Package found. Validating its format and protected-bank rules…");
    await installFetchedPackage(file, sourceUrl);
  } catch (error) {
    console.error("GitHub question-bank import failed", error);
    setStatus(error?.message || "The GitHub question bank could not be imported.", "error");
  } finally {
    importBusy = false;
    if (button) button.disabled = false;
  }
}

function ensureGithubPanel() {
  const protection = sectionByHeading("Data protection");
  if (!protection || protection.querySelector("#githubBankImportPanel")) return;

  const panel = document.createElement("div");
  panel.id = "githubBankImportPanel";
  panel.className = "github-bank-import-panel";

  const heading = document.createElement("h4");
  heading.textContent = "Import from GitHub";

  const explanation = document.createElement("p");
  explanation.className = "muted";
  explanation.textContent = "Paste a direct GitHub JSON-file link or a repository address. Repository links look for abpn-question-bank.json, question-bank.json, or bank.json on the main or master branch.";

  const row = document.createElement("div");
  row.className = "github-bank-import-row";

  const input = document.createElement("input");
  input.id = "githubBankUrlInput";
  input.type = "url";
  input.inputMode = "url";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "https://github.com/owner/repository";
  input.setAttribute("aria-label", "GitHub question-bank address");
  input.value = localStorage.getItem(LAST_GITHUB_ADDRESS_KEY) || "";

  const button = document.createElement("button");
  button.id = "githubBankImportBtn";
  button.type = "button";
  button.className = "secondary";
  button.textContent = "Import from GitHub";
  button.addEventListener("click", () => void importFromGithub());

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void importFromGithub();
  });

  const help = document.createElement("p");
  help.className = "muted github-bank-import-help";
  help.textContent = "When a repository is not packaged yet, keep the address here and bring it back to ChatGPT so it can be reviewed and integrated safely.";

  const status = document.createElement("p");
  status.id = "githubBankImportStatus";
  status.className = "github-bank-import-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  row.append(input, button);
  panel.append(heading, explanation, row, help, status);
  protection.append(panel);
}

const observer = new MutationObserver(ensureGithubPanel);
observer.observe(app, { childList: true, subtree: true });
ensureGithubPanel();
