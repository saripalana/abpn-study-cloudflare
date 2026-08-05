import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  flushPendingCloudDeckUploads,
  promoteLocallyInstalledDecks,
  refreshCloudDeckLibrary,
} from "./client/deck-library.js";
import { loadInstalledQuestionBanks } from "./client/question-bank-import.js";
import { installSeedQuestionBanks } from "./client/question-bank-import.js";
import { initExamCountdown } from "./client/exam-countdown.js";
import {
  ensureStagingSession,
  importLiveBackupIntoStaging,
} from "./client/staging-lifecycle.js";

const app = document.getElementById("app");
const BUILT_IN_QUESTION_BANKS = [...QUESTION_BANKS];
const SEED_QUESTION_BANKS = BUILT_IN_QUESTION_BANKS.filter((bank) => bank.contentClass !== "system-validation");
const SYSTEM_VALIDATION_FIXTURES = BUILT_IN_QUESTION_BANKS.filter((bank) => bank.contentClass === "system-validation");
const LOCAL_STARTUP_TIMEOUT_MS = 2_000;
const CLOUD_STARTUP_TIMEOUT_MS = 5_000;

// Local-only preferences must remain usable even when staging cleanup or its
// health check is slow. The staging gate still completes before decks or study
// state are loaded below.
initExamCountdown();
const stagingPreparation = await ensureStagingSession();

function withStartupTimeout(operation, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
}

async function loadAvailableDecks(timeoutMs = LOCAL_STARTUP_TIMEOUT_MS) {
  return withStartupTimeout(
    (async () => {
      await installSeedQuestionBanks(SEED_QUESTION_BANKS);
      return loadInstalledQuestionBanks(SYSTEM_VALIDATION_FIXTURES);
    })(),
    timeoutMs,
    "Local deck startup timed out.",
  );
}

function catalogSignature(definitions) {
  return definitions.map((bank) => `${bank.id}@${bank.version || ""}`).sort().join("|");
}

try {
  // Render the application first. Cloud synchronization must never prevent the
  // bundled/local study interface or the file-import control from appearing.
  try {
    const definitions = await loadAvailableDecks();
    QUESTION_BANKS.splice(0, QUESTION_BANKS.length, ...definitions);
  } catch (error) {
    console.warn("Local deck cache is unavailable; continuing with bundled decks.", error);
  }

  const startupCatalog = catalogSignature(QUESTION_BANKS);
  const { applicationReady, refreshApplication } = await import("./app.js");
  await applicationReady;

  // The working dashboard renders first. Only a brand-new disposable staging
  // session then imports the latest complete live backup and refreshes once.
  // Reloads retain that temporary session; closing it causes the next launch
  // to clear staging and import a fresh live copy again.
  if (stagingPreparation.importLiveBackup) {
    await importLiveBackupIntoStaging(stagingPreparation.sessionId);
    const copiedDefinitions = await loadAvailableDecks();
    QUESTION_BANKS.splice(0, QUESTION_BANKS.length, ...copiedDefinitions);
    await refreshApplication();
  }

  // Finish the one bounded cloud-catalog pass before attaching interactive
  // controllers. This prevents a late catalog refresh from racing a file
  // picker, answer, resume action, or backup while preserving the already
  // rendered local-first dashboard during an offline timeout.
  // Only the hidden system fixture is reserved. Every user-facing deck,
  // including application-supplied seeds, synchronizes through one library.
  const reservedIds = QUESTION_BANKS
    .filter((bank) => bank.contentClass === "system-validation")
    .map((bank) => bank.id);
  try {
    await withStartupTimeout((async () => {
      await flushPendingCloudDeckUploads();
      await promoteLocallyInstalledDecks({ reservedIds });
      await refreshCloudDeckLibrary({ reservedIds });
    })(), CLOUD_STARTUP_TIMEOUT_MS, "Cloud deck startup timed out.");
  } catch (error) {
    console.warn("Cloud deck library is unavailable; continuing with bundled and locally cached decks.", error);
  }

  try {
    const definitions = await loadAvailableDecks();
    const updatedCatalog = catalogSignature(definitions);
    QUESTION_BANKS.splice(0, QUESTION_BANKS.length, ...definitions);

    if (updatedCatalog !== startupCatalog) {
      await refreshApplication();
    }
  } catch (error) {
    console.warn("Updated deck catalog could not be loaded; current dashboard remains available.", error);
  }

  // Controllers load only after the dashboard and its bounded catalog refresh
  // are stable, so every visible control is attached to the current render.
  await import("./sync-controller.js");
  await import("./backup-controller.js");
  await import("./data-management-controller.js");
  await import("./question-bank-controller.js");
  await import("./github-question-bank-controller.js");
} catch (error) {
  console.error("Question-bank bootstrap failed", error);
  app.innerHTML = `
    <section class="card">
      <h2>Decks could not be loaded</h2>
      <p class="notice">${String(error.message || error).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[character]))}</p>
      <p class="muted">Protected built-in content has not been changed. Restore or re-add the affected deck before continuing.</p>
    </section>`;
}
