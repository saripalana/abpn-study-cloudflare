import { QUESTION_BANKS } from "./banks/catalog.js";
import { loadInstalledQuestionBanks } from "./client/question-bank-import.js";

const app = document.getElementById("app");

try {
  const definitions = await loadInstalledQuestionBanks(QUESTION_BANKS);
  QUESTION_BANKS.splice(0, QUESTION_BANKS.length, ...definitions);
  await import("./app.js");
} catch (error) {
  console.error("Question-bank bootstrap failed", error);
  app.innerHTML = `
    <section class="card">
      <h2>Question banks could not be loaded</h2>
      <p class="notice">${String(error.message || error).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[character]))}</p>
      <p class="muted">Protected built-in content has not been changed. Restore or re-import the affected local package before continuing.</p>
    </section>`;
}
