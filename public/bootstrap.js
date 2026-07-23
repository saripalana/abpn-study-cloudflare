import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  flushPendingCloudDeckUploads,
  promoteLocallyInstalledDecks,
  refreshCloudDeckLibrary,
} from "./client/deck-library.js";
import { loadInstalledQuestionBanks } from "./client/question-bank-import.js";

const app = document.getElementById("app");
const CLOUD_STARTUP_TIMEOUT_MS = 5_000;

function withStartupTimeout(operation, timeoutMs = CLOUD_STARTUP_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Cloud deck startup timed out.")), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
}

try {
  const reservedIds = QUESTION_BANKS.filter((bank) => bank.protected).map((bank) => bank.id);
  try {
    await withStartupTimeout((async () => {
      await flushPendingCloudDeckUploads();
      await promoteLocallyInstalledDecks({ reservedIds });
      await refreshCloudDeckLibrary({ reservedIds });
    })());
  } catch (error) {
    console.warn("Cloud deck library is unavailable; continuing with bundled and locally cached decks.", error);
  }
  const definitions = await loadInstalledQuestionBanks(QUESTION_BANKS);
  QUESTION_BANKS.splice(0, QUESTION_BANKS.length, ...definitions);
  await import("./app.js");
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
