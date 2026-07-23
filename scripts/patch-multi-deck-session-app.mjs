import { readFile, writeFile } from "node:fs/promises";

const appPath = new URL("../public/app.js", import.meta.url);
const patchMarker = "// ABPN_MULTI_DECK_SESSION_APP_PATCH_V1";
let source = await readFile(appPath, "utf8");

if (source.includes(patchMarker)) process.exit(0);

function replaceRequired(search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not apply ${label}; expected app.js source was not found.`);
  source = source.replace(search, replacement);
}

replaceRequired(
  "import { DECK_SCOPE_CURRENT, normalizeDeckScopeSettings } from './client/multi-deck-builder.js';",
  "import { DECK_SCOPE_CURRENT, normalizeDeckScopeSettings } from './client/multi-deck-builder.js';\nimport { createPracticeSession, persistenceRecordForSession } from './client/multi-deck-app-session.js';\n\n" + patchMarker,
  "multi-deck app-session imports",
);

const startSetStart = source.indexOf("async function startSet() {");
const submissionStart = source.indexOf("function submissionConfirmation() {", startSetStart);
if (startSetStart < 0 || submissionStart < 0) {
  throw new Error("Could not locate startSet/saveActiveSet for multi-deck session integration.");
}

const replacement = `async function startSet() {
  if (activeSet && !activeSet.submitted && !confirm(
    'Replace the current active set?\\n\\nIts saved answers will remain in local history, but it will no longer be resumable.'
  )) return;

  if (activeSet && !activeSet.submitted) await saveActiveSet('abandoned');

  const categories = selectedSubjectCategories();
  if (!categories.length) return alert('Select at least one subject before starting a practice set.');

  const settings = loadMultiDeckBuilderSettings(activeBank.id);
  const pool = document.getElementById('poolSelect').value;
  const count = document.getElementById('countInput').value;
  const mode = document.getElementById('modeSelect').value;
  const timed = document.getElementById('timingSelect').value === 'timed';
  const categoriesByBank = new Map(banks.map((bank) => [bank.id, categories]));
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const session = await createPracticeSession({
    decks: banks,
    activeBank,
    settings,
    loadProgress: progressMap,
    pool,
    categoriesByBank,
    count,
    mode,
    timed,
    now,
    id,
    random: Math.random,
    createSingleDeckSet: async ({ activeBank: selectedBank, pool: selectedPool, count: requestedCount, mode: selectedMode, timed: isTimed, now: startedAt, id: setId, random }) => {
      const progress = await progressMap(selectedBank.id);
      const ids = chooseQuestionIds(selectedBank, progress, selectedPool, requestedCount, random, categories);
      if (!ids.length) return null;
      return {
        id: setId,
        bankId: selectedBank.id,
        questionIds: ids,
        index: 0,
        mode: selectedMode,
        timed: isTimed,
        remainingSeconds: isTimed ? Math.ceil(ids.length * 70.6) : 0,
        submitted: false,
        startedAt,
        completedAt: null,
      };
    },
  });

  if (!session) return alert('No questions are available in that pool for the selected decks.');

  activeSet = {
    ...session,
    answers: new Map(),
    submitted: false,
    completedAt: null,
  };
  await saveActiveSet();
  await renderQuestion();
}

async function saveActiveSet(status = activeSet?.submitted ? 'completed' : 'active') {
  if (!activeSet) return;
  const record = persistenceRecordForSession(activeSet);
  record.status = status;
  await updatePracticeSet({ deviceId, record });
}

`;

source = source.slice(0, startSetStart) + replacement + source.slice(submissionStart);
await writeFile(appPath, source, "utf8");
