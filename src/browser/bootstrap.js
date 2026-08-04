import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  flushPendingCloudDeckUploads,
  promoteLocallyInstalledDecks,
  refreshCloudDeckLibrary,
} from "./client/deck-library.js";
import { loadInstalledQuestionBanks } from "./client/question-bank-import.js";
import { initExamCountdown } from "./client/exam-countdown.js";

const app = document.getElementById("app");
const LOCAL_STARTUP_TIMEOUT_MS = 2_000;
const CLOUD_STARTUP_TIMEOUT_MS = 5_000;
const CLOUD_CATALOG_RELOAD_KEY = "abpn-cloud-catalog-reload";

initExamCountdown();

function withStartupTimeout(operation, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
}

async function loadAvailableDecks(timeoutMs = LOCAL_STARTUP_TIMEOUT_MS) {
  return withStartupTimeout(
    loadInstalledQuestionBanks(QUESTION_BANKS),
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
  await import("./app.js");

  // Refresh cloud and locally installed decks after the dashboard is usable.
  void (async () => {
    const reservedIds = QUESTION_BANKS.filter((bank) => bank.protected).map((bank) => bank.id);
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

      // app.js builds its selector from the startup catalog. When a clean device
      // downloads a deck from Cloudflare after that render, reload exactly once
      // so the normal startup path includes the new peer deck like K&S.
      if (updatedCatalog !== startupCatalog) {
        const lastReloadedCatalog = sessionStorage.getItem(CLOUD_CATALOG_RELOAD_KEY);
        if (lastReloadedCatalog !== updatedCatalog) {
          sessionStorage.setItem(CLOUD_CATALOG_RELOAD_KEY, updatedCatalog);
          window.location.reload();
          return;
        }
      }

      sessionStorage.removeItem(CLOUD_CATALOG_RELOAD_KEY);
      window.dispatchEvent(new CustomEvent("abpn:deck-catalog-updated"));
    } catch (error) {
      console.warn("Updated deck catalog could not be loaded; current dashboard remains available.", error);
    }
  })();
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
