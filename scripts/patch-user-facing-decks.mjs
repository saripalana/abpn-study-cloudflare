import { readFile, writeFile } from "node:fs/promises";

const appPath = new URL("../public/app.js", import.meta.url);
const patchMarker = "// ABPN_USER_FACING_DECKS_PATCH_V1";
let source = await readFile(appPath, "utf8");

if (source.includes(patchMarker)) process.exit(0);

function replaceRequired(search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not apply ${label}; expected app.js source was not found.`);
  source = source.replace(search, replacement);
}

replaceRequired(
  "import { QUESTION_BANKS } from './banks/catalog.js';",
  "import { QUESTION_BANKS } from './banks/catalog.js';\nimport { deckOptionHiddenAttribute, isUserSelectableDeck, practiceSetDeckLabel, resolveUserActiveDeck } from './client/deck-display.js';\n\n" + patchMarker,
  "user-facing deck imports",
);

replaceRequired(
  [
    "    const selected = localStorage.getItem(SELECTED_BANK_KEY);",
    "    activeBank = banks.find((bank) => bank.id === selected)",
    "      || banks.find((bank) => bank.id === 'ks-psychiatry-core')",
    "      || banks[0];",
  ].join("\n"),
  [
    "    const selected = localStorage.getItem(SELECTED_BANK_KEY);",
    "    const allowSystemValidation = sessionStorage.getItem('abpn-study:allow-system-validation') === 'true';",
    "    activeBank = resolveUserActiveDeck(banks, selected, 'ks-psychiatry-core', allowSystemValidation);",
    "    if (!activeBank) throw new Error('No normal study decks are available.');",
    "    localStorage.setItem(SELECTED_BANK_KEY, activeBank.id);",
  ].join("\n"),
  "safe active-deck selection",
);

replaceRequired(
  [
    "async function selectBank(bankId) {",
    "  activeBank = banks.find((bank) => bank.id === bankId) || activeBank;",
    "  localStorage.setItem(SELECTED_BANK_KEY, activeBank.id);",
    "  activeSet = await loadActiveSet(activeBank.id);",
    "  await renderDashboard();",
    "}",
  ].join("\n"),
  [
    "async function selectBank(bankId) {",
    "  activeBank = banks.find((bank) => bank.id === bankId) || activeBank;",
    "  if (isUserSelectableDeck(activeBank)) {",
    "    sessionStorage.removeItem('abpn-study:allow-system-validation');",
    "  } else {",
    "    sessionStorage.setItem('abpn-study:allow-system-validation', 'true');",
    "  }",
    "  localStorage.setItem(SELECTED_BANK_KEY, activeBank.id);",
    "  activeSet = await loadActiveSet(activeBank.id);",
    "  await renderDashboard();",
    "}",
  ].join("\n"),
  "test-addressable hidden validation selection",
);

replaceRequired(
  "          ${banks.map((bank) => `<option value=\"${esc(bank.id)}\" ${bank.id === activeBank.id ? 'selected' : ''}>${esc(bank.title)} (${bank.questions.length})</option>`).join('')}",
  "          ${banks.map((bank) => `<option value=\"${esc(bank.id)}\"${deckOptionHiddenAttribute(bank)} ${bank.id === activeBank.id ? 'selected' : ''}>${esc(bank.title)} (${bank.questions.length})</option>`).join('')}",
  "hidden validation deck option",
);

replaceRequired(
  [
    "        <small>${formatDateTime(record.completedAt || record.updatedAt)} · ${record.timed ? 'Timed' : 'Untimed'}</small>",
    "        <small>${result.answered} answered · ${result.omitted} omitted · ${result.incorrect} incorrect · ${formatSeconds(averageTimeMs)} average/question</small>",
  ].join("\n"),
  [
    "        <small><strong>Decks:</strong> ${esc(practiceSetDeckLabel(banks, record))}</small>",
    "        <small>${formatDateTime(record.completedAt || record.updatedAt)} · ${record.timed ? 'Timed' : 'Untimed'}</small>",
    "        <small>${result.answered} answered · ${result.omitted} omitted · ${result.incorrect} incorrect · ${formatSeconds(averageTimeMs)} average/question</small>",
  ].join("\n"),
  "completed-test deck labels",
);

await writeFile(appPath, source, "utf8");
