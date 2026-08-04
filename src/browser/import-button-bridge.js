(() => {
  const app = document.getElementById("app");
  const input = document.getElementById("bankImportInput");
  if (!app || !input) return;

  function normalizeControl() {
    const button = document.getElementById("importBankBtn");
    if (!(button instanceof HTMLButtonElement)) return null;
    if (button.type !== "button") button.type = "button";
    if (button.textContent !== "Import from file") button.textContent = "Import from file";
    if (button.getAttribute("aria-controls") !== input.id) {
      button.setAttribute("aria-controls", input.id);
    }
    if (button.getAttribute("aria-haspopup") !== "dialog") {
      button.setAttribute("aria-haspopup", "dialog");
    }
    return button;
  }

  function ensureStartupControl() {
    if (document.getElementById("importBankBtn")) return;
    const loadingCard = app.querySelector(".loading-card");
    if (!(loadingCard instanceof HTMLElement)) return;

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.setAttribute("data-startup-import", "true");

    const button = document.createElement("button");
    button.id = "importBankBtn";
    button.className = "secondary";
    button.type = "button";
    button.textContent = "Import from file";
    button.setAttribute("aria-controls", input.id);
    button.setAttribute("aria-haspopup", "dialog");
    // The file input change handler is installed by question-bank-controller.
    // Keep startup import unavailable until that controller explicitly enables
    // the currently rendered button, preventing a chosen file from being lost.
    button.disabled = true;

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "You can choose a saved question-bank file while the deck library finishes loading.";

    actions.append(button);
    loadingCard.append(note, actions);
  }

  function openPicker() {
    input.value = "";
    try {
      input.click();
    } catch (error) {
      console.error("Deck import picker could not open", error);
      window.alert([
        "The deck file picker could not open.",
        "",
        "Refresh the page once and try again.",
        "Your decks and study progress were not changed.",
      ].join("\n"));
    }
  }

  // Register immediately, before asynchronous module initialization. This is the
  // single delegated activation path for both the startup and dashboard controls.
  app.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("#importBankBtn")
      : null;
    if (!button || !app.contains(button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPicker();
  }, true);

  // The dashboard is rendered repeatedly. Normalize each newly rendered control.
  // Only write when a value differs so the observer cannot retrigger itself forever.
  const observer = new MutationObserver(() => {
    ensureStartupControl();
    normalizeControl();
  });
  observer.observe(app, { childList: true, subtree: true });
  ensureStartupControl();
  normalizeControl();

  // Native buttons already translate Enter/Space into click. No competing
  // keydown handler is needed.
  window.__ABPN_IMPORT_BUTTON_BRIDGE__ = Object.freeze({ ready: true });
})();
