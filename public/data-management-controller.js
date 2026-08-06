import {
  deleteSavedSet,
  getLastDestructiveAction,
  latestActiveSet,
  resetQuestionBankData,
  undoLastDestructiveAction,
} from "./client/data-management.js";

const app = document.getElementById("app");
const SUPPRESS_ACTIVE_AUTOSAVE_KEY = "abpn-study:suppress-active-autosave";
let attaching = false;

window.addEventListener("beforeunload", (event) => {
  if (sessionStorage.getItem(SUPPRESS_ACTIVE_AUTOSAVE_KEY) !== "true") return;
  sessionStorage.removeItem(SUPPRESS_ACTIVE_AUTOSAVE_KEY);
  event.stopImmediatePropagation();
}, { capture: true });

function reloadAfterDestructiveAction() {
  sessionStorage.setItem(SUPPRESS_ACTIVE_AUTOSAVE_KEY, "true");
  location.reload();
}

function selectedBank() {
  const id = app.dataset.activeBankId;
  if (!id) return null;
  return {
    id,
    label: app.dataset.activeBankLabel || id,
  };
}

function sectionByHeading(text) {
  return [...app.querySelectorAll("h3")]
    .find((heading) => heading.textContent?.trim() === text)
    ?.closest("section") ?? null;
}

function describeAction(action) {
  const type = action?.context?.type;
  const label = action?.context?.label || "saved study data";
  if (type === "reset-bank") return `reset of ${label}`;
  if (type === "discard-active-set") return `discarded active set in ${label}`;
  return `deleted completed test in ${label}`;
}

async function discardActiveSet(bank) {
  const set = await latestActiveSet(bank.id);
  if (!set) {
    alert("No active set was found for this deck.");
    location.reload();
    return;
  }

  const confirmed = confirm([
    `Discard the active set for ${bank.label}?`,
    "",
    "The saved set and its answers will be removed from Resume active set.",
    "Question progress already recorded in Tutor mode will remain in cumulative analytics.",
    "A recovery snapshot will be created first, and this action can be undone from Data protection.",
  ].join("\n"));
  if (!confirmed) return;

  await deleteSavedSet({
    setId: set.id,
    bankId: bank.id,
    label: bank.label,
    type: "discard-active-set",
  });
  alert("The active set was discarded safely. Use Undo last deletion/reset in Data protection to restore it.");
  reloadAfterDestructiveAction();
}

async function deleteCompletedTest(button, bank) {
  const article = button.closest(".history-item");
  const setId = button.dataset.setId;
  const description = article?.querySelector(".history-details")?.innerText?.trim() || "this completed test";
  const confirmed = confirm([
    "Delete this completed test from History / Previous tests?",
    "",
    description,
    "",
    "The saved test and its per-question answers will be removed.",
    "Cumulative question performance and category analytics will not be recalculated or erased.",
    "A recovery snapshot will be created first, and this action can be undone from Data protection.",
  ].join("\n"));
  if (!confirmed) return;

  await deleteSavedSet({
    setId,
    bankId: bank.id,
    label: bank.label,
    type: "delete-completed-set",
  });
  alert("The completed test was deleted from History. Use Undo last deletion/reset in Data protection to restore it.");
  reloadAfterDestructiveAction();
}

async function resetCurrentBank(bank) {
  const firstConfirmation = confirm([
    `Reset all local study data for ${bank.label}?`,
    "",
    "This will remove this bank's:",
    "• question progress and flags",
    "• active and completed sets",
    "• saved answers",
    "• category analytics",
    "• pending local synchronization entries",
    "",
    "Deck content, other decks, downloaded backups, and Cloudflare data will not be deleted.",
    "A recovery snapshot will be created first.",
  ].join("\n"));
  if (!firstConfirmation) return;

  const typed = prompt(`Type RESET to confirm resetting ${bank.label}.`);
  if (typed !== "RESET") {
    alert("Reset cancelled. No study data was changed.");
    return;
  }

  const { summary } = await resetQuestionBankData({ bankId: bank.id, label: bank.label });
  alert([
    `${bank.label} was reset locally.`,
    `Progress records removed: ${summary.deletedProgress}`,
    `Saved sets removed: ${summary.deletedSets}`,
    `Saved answers removed: ${summary.deletedAnswers}`,
    "Use Undo last deletion/reset in Data protection to restore the snapshot.",
  ].join("\n"));
  reloadAfterDestructiveAction();
}

async function undoLastAction(action) {
  const confirmed = confirm([
    `Undo the last ${describeAction(action)}?`,
    "",
    `Snapshot created: ${new Date(action.createdAt).toLocaleString()}`,
    "The saved records will be merged back without overwriting newer local records.",
  ].join("\n"));
  if (!confirmed) return;

  const result = await undoLastDestructiveAction();
  alert([
    "The last deletion/reset was restored.",
    `Progress records restored: ${result.restoredProgress}`,
    `Saved sets restored: ${result.restoredSets}`,
    `Saved answers restored: ${result.restoredAnswers}`,
  ].join("\n"));
  location.reload();
}

async function attachControls() {
  if (attaching) return;
  attaching = true;
  try {
    const bank = selectedBank();
    if (!bank) return;

    const resumeSection = sectionByHeading("Resume active set");
    const resumeActions = resumeSection?.querySelector(".actions");
    if (resumeActions && !resumeActions.querySelector("#discardActiveSetBtn")) {
      const button = document.createElement("button");
      button.id = "discardActiveSetBtn";
      button.className = "danger";
      button.type = "button";
      button.textContent = "Discard active set";
      button.addEventListener("click", () => discardActiveSet(bank).catch(showError));
      resumeActions.append(button);
    }

    for (const article of app.querySelectorAll(".history-item")) {
      const review = article.querySelector(".review-history-btn");
      if (!review) continue;
      let actions = article.querySelector(".history-actions");
      if (!actions) {
        actions = document.createElement("div");
        actions.className = "history-actions";
        review.replaceWith(actions);
        actions.append(review);
      }
      if (!actions.querySelector(".delete-history-btn")) {
        const button = document.createElement("button");
        button.className = "danger delete-history-btn";
        button.type = "button";
        button.dataset.setId = review.dataset.setId;
        button.textContent = "Delete test";
        button.addEventListener("click", () => deleteCompletedTest(button, bank).catch(showError));
        actions.append(button);
      }
    }

    const protectionSection = sectionByHeading("Data protection");
    const protectionActions = protectionSection?.querySelector("#deckManagementActions");
    if (protectionActions && !protectionActions.querySelector("#resetBankBtn")) {
      const resetButton = document.createElement("button");
      resetButton.id = "resetBankBtn";
      resetButton.className = "danger";
      resetButton.type = "button";
      resetButton.textContent = "Reset current deck";
      resetButton.addEventListener("click", () => resetCurrentBank(bank).catch(showError));
      protectionActions.append(resetButton);
    }

    const action = await getLastDestructiveAction();
    const existingUndo = protectionActions?.querySelector("#undoDestructiveActionBtn");
    if (action && protectionActions && !existingUndo) {
      const undoButton = document.createElement("button");
      undoButton.id = "undoDestructiveActionBtn";
      undoButton.className = "secondary undo-action";
      undoButton.type = "button";
      undoButton.textContent = "Undo last deletion/reset";
      undoButton.title = describeAction(action);
      undoButton.addEventListener("click", () => undoLastAction(action).catch(showError));
      protectionActions.append(undoButton);
    } else if (!action && existingUndo) {
      existingUndo.remove();
    }

    if (protectionSection && !protectionSection.querySelector(".data-management-note")) {
      const note = document.createElement("p");
      note.className = "data-management-note muted";
      note.textContent = "Destructive actions are limited to the selected deck and create a recovery snapshot before deletion.";
      protectionSection.append(note);
    }
  } finally {
    attaching = false;
  }
}

function showError(error) {
  console.error("Data management action failed", error);
  alert(`The requested action could not be completed: ${error.message}`);
}

const observer = new MutationObserver(() => void attachControls());
observer.observe(app, { childList: true, subtree: true });
void attachControls();
