import { QUESTION_BANKS } from "./banks/catalog.js";
import {
  flushPendingCloudDeckUploads,
  promoteLocallyInstalledDecks,
  refreshCloudDeckLibrary,
} from "./client/deck-library.js";
import { ensureUnifiedStarterDecks } from "./client/starter-decks.js";
import { loadInstalledQuestionBanks } from "./client/question-bank-import.js";

const app = document.getElementById("app");

try {
  try {
    await flushPendingCloudDeckUploads();
  } catch (error) {
    console.warn("Pending deck uploads could not be flushed yet.", error);
  }

  try {
    await ensureUnifiedStarterDecks();
  } catch (error) {
    console.warn("Initial decks could not be prepared completely.", error);
  }

  try {
    await promoteLocallyInstalledDecks();
  } catch (error) {
    console.warn("Locally cached decks could not be promoted yet.", error);
  }

  try {
    await refreshCloudDeckLibrary();
  } catch (error) {
    console.warn("Cloud deck library is unavailable; continuing with locally cached decks.", error);
  }

  const definitions = await loadInstalledQuestionBanks();
  if (!definitions.length) {
    throw new Error("No decks are available. Reconnect and reload, or add a deck from a file or GitHub address.");
  }
  QUESTION_BANKS.splice(0, QUESTION_BANKS.length, ...definitions);
  await import("./app.js");
} catch (error) {
  console.error("Deck bootstrap failed", error);
  app.innerHTML = `
    <section class="card">
      <h2>Decks could not be loaded</h2>
      <p class="notice">${String(error.message || error).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[character]))}</p>
      <p class="muted">Your locally saved progress has not been changed.</p>
    </section>`;
}
