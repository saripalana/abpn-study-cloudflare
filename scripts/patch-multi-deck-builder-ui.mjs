import { readFile, writeFile } from "node:fs/promises";

const appPath = new URL("../public/app.js", import.meta.url);
const patchMarker = "// ABPN_MULTI_DECK_BUILDER_UI_PATCH_V1";
let source = await readFile(appPath, "utf8");

if (source.includes(patchMarker)) process.exit(0);

function replaceRequired(search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not apply ${label}; expected app.js source was not found.`);
  source = source.replace(search, replacement);
}

replaceRequired(
  "} from './client/study-engine.js';",
  "} from './client/study-engine.js';\nimport { bindMultiDeckSelector, multiDeckSelectorMarkup } from './client/multi-deck-builder-ui.js';\nimport { DECK_SCOPE_CURRENT, normalizeDeckScopeSettings } from './client/multi-deck-builder.js';\n\n" + patchMarker,
  "multi-deck builder imports",
);

replaceRequired(
  "const BUILDER_SETTINGS_PREFIX = 'abpn-study:builder-settings:';",
  "const BUILDER_SETTINGS_PREFIX = 'abpn-study:builder-settings:';\nconst MULTI_DECK_BUILDER_KEY = 'abpn-study:multi-deck-builder';",
  "multi-deck builder storage key",
);

replaceRequired(
  "function selectedSubjectCategories() {",
  `function loadMultiDeckBuilderSettings(activeBankId) {
  let saved = { scope: DECK_SCOPE_CURRENT, selectedBankIds: [activeBankId] };
  try {
    const parsed = JSON.parse(localStorage.getItem(MULTI_DECK_BUILDER_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch {
    // Invalid local settings fall back to the current deck.
  }
  return normalizeDeckScopeSettings({ decks: banks, activeBankId, saved });
}

function selectedSubjectCategories() {`,
  "multi-deck builder settings loader",
);

replaceRequired(
  "  const builder = loadBuilderSettings(activeBank, categories.map((category) => category.title));",
  "  const builder = loadBuilderSettings(activeBank, categories.map((category) => category.title));\n  const multiDeckBuilder = loadMultiDeckBuilderSettings(activeBank.id);",
  "multi-deck builder dashboard state",
);

replaceRequired(
  "          <h3>Create practice set</h3>\n          <div class=\"form-grid\">",
  "          <h3>Create practice set</h3>\n          ${multiDeckSelectorMarkup({ decks: banks, activeBankId: activeBank.id, settings: multiDeckBuilder })}\n          <div class=\"form-grid\">",
  "multi-deck selector markup",
);

replaceRequired(
  "  let preferredCount = builder.count;",
  "  let preferredCount = builder.count;",
  "multi-deck selector binding anchor",
);

replaceRequired(
  "  document.getElementById('selectAllSubjectsBtn').onclick = () => {",
  `  bindMultiDeckSelector(app, {
    decks: banks,
    activeBankId: activeBank.id,
    settings: multiDeckBuilder,
    onChange: (settings) => {
      localStorage.setItem(MULTI_DECK_BUILDER_KEY, JSON.stringify({ schemaVersion: 1, ...settings }));
      const combined = settings.scope !== DECK_SCOPE_CURRENT;
      startButton.textContent = combined ? 'Combined-deck runtime pending validation' : 'Start randomized set';
      startButton.disabled = combined;
      if (combined) {
        eligibleCount.textContent = 'Combined-deck selection is configured. Starting the set will be enabled after source-aware question rendering passes validation.';
        eligibleCount.dataset.empty = 'true';
      } else {
        updateBuilderAvailability();
      }
    },
  });

  document.getElementById('selectAllSubjectsBtn').onclick = () => {`,
  "multi-deck selector binding",
);

await writeFile(appPath, source, "utf8");
