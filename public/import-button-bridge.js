(() => {
  const app = document.getElementById("app");
  const input = document.getElementById("bankImportInput");
  if (!app || !input) return;

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
  // single delegated activation path for the dashboard import button.
  app.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("#importBankBtn")
      : null;
    if (!button || !app.contains(button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPicker();
  }, true);

  // Native buttons already translate Enter/Space into click. No competing
  // keydown handler is needed.
  window.__ABPN_IMPORT_BUTTON_BRIDGE__ = Object.freeze({ ready: true });
})();
