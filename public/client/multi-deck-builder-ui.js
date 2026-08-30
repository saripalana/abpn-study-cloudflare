import {
  DECK_SCOPE_ALL,
  DECK_SCOPE_COACH,
  DECK_SCOPE_CURRENT,
  DECK_SCOPE_CUSTOM,
  deckScopeSummary,
  normalizeDeckScopeSettings,
  normalStudyDecks,
} from "./multi-deck-builder.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character]));

export function multiDeckSelectorMarkup({ decks, activeBankId, settings } = {}) {
  const available = normalStudyDecks(decks);
  const normalized = normalizeDeckScopeSettings({ decks, activeBankId, saved: settings });
  const selected = new Set(normalized.selectedBankIds);
  const customHidden = normalized.scope !== DECK_SCOPE_CUSTOM ? " hidden" : "";

  return `
    <div class="field multi-deck-scope-field">
      <label for="deckScopeSelect">Practice from</label>
      <select id="deckScopeSelect">
        <option value="${DECK_SCOPE_CURRENT}" ${normalized.scope === DECK_SCOPE_CURRENT ? "selected" : ""}>Current deck</option>
        <option value="${DECK_SCOPE_ALL}" ${normalized.scope === DECK_SCOPE_ALL ? "selected" : ""}>All study decks</option>
        <option value="${DECK_SCOPE_COACH}" ${normalized.scope === DECK_SCOPE_COACH ? "selected" : ""}>Coach decks</option>
        <option value="${DECK_SCOPE_CUSTOM}" ${normalized.scope === DECK_SCOPE_CUSTOM ? "selected" : ""}>Choose specific decks</option>
      </select>
    </div>
    <details id="deckPicker" class="subject-picker deck-picker"${customHidden}>
      <summary>
        <span>Decks</span>
        <span id="deckScopeSummary" class="subject-summary">${escapeHtml(deckScopeSummary({ decks, activeBankId, settings: normalized }))}</span>
      </summary>
      <div class="subject-picker-body">
        <div class="deck-toolbar">
          <button id="selectAllDecksBtn" class="secondary" type="button">Select all</button>
          <button id="clearDecksBtn" class="secondary" type="button">Clear</button>
        </div>
        <div class="subject-options deck-options">
          ${available.map((deck, index) => `
            <label class="deck-option" for="practice-deck-${index}" style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:.75rem;min-height:44px;padding:.65rem .75rem;">
              <input id="practice-deck-${index}" name="practiceDeckFilter" type="checkbox" value="${escapeHtml(deck.id)}" ${selected.has(deck.id) ? "checked" : ""}>
              <span>${escapeHtml(deck.title)}</span>
              <small>${Number(deck.questions?.length || 0)}</small>
            </label>
          `).join("")}
        </div>
      </div>
    </details>
    <p id="deckScopeAvailability" class="builder-availability">${escapeHtml(deckScopeSummary({ decks, activeBankId, settings: normalized }))}</p>
  `;
}

export function readMultiDeckSelector(root, { decks, activeBankId } = {}) {
  const scope = root?.querySelector?.("#deckScopeSelect")?.value || DECK_SCOPE_CURRENT;
  const selectedBankIds = [...(root?.querySelectorAll?.('input[name="practiceDeckFilter"]:checked') || [])]
    .map((input) => input.value);
  return normalizeDeckScopeSettings({
    decks,
    activeBankId,
    saved: { scope, selectedBankIds },
  });
}

export function bindMultiDeckSelector(root, { decks, activeBankId, settings, onChange } = {}) {
  const select = root?.querySelector?.("#deckScopeSelect");
  const picker = root?.querySelector?.("#deckPicker");
  const inputs = [...(root?.querySelectorAll?.('input[name="practiceDeckFilter"]') || [])];
  const selectAll = root?.querySelector?.("#selectAllDecksBtn");
  const clear = root?.querySelector?.("#clearDecksBtn");
  const summary = root?.querySelector?.("#deckScopeSummary");
  const availability = root?.querySelector?.("#deckScopeAvailability");
  if (!select || !picker) return () => normalizeDeckScopeSettings({ decks, activeBankId, saved: settings });

  const update = () => {
    const value = readMultiDeckSelector(root, { decks, activeBankId });
    picker.hidden = value.scope !== DECK_SCOPE_CUSTOM;
    const text = deckScopeSummary({ decks, activeBankId, settings: value });
    if (summary) summary.textContent = text;
    if (availability) availability.textContent = text;
    onChange?.(value);
    return value;
  };

  select.addEventListener("change", update);
  inputs.forEach((input) => input.addEventListener("change", update));
  selectAll?.addEventListener("click", () => {
    inputs.forEach((input) => { input.checked = true; });
    update();
  });
  clear?.addEventListener("click", () => {
    inputs.forEach((input) => { input.checked = false; });
    update();
  });
  update();
  return update;
}
