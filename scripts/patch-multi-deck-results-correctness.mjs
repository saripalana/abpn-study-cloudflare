import { readFile, writeFile } from "node:fs/promises";

const appPath = new URL("../public/app.js", import.meta.url);
const patchMarker = "// ABPN_MULTI_DECK_RESULTS_CORRECTNESS_PATCH_V1";
let source = await readFile(appPath, "utf8");

if (source.includes(patchMarker)) process.exit(0);

function replaceRequired(search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Could not apply ${label}; expected app.js source was not found.`);
  }
  source = source.replace(search, replacement);
}

replaceRequired(
  "const result = calculateSessionResult(banks, normalized, answers, { hasAnswer: hasQuestionAnswer, isCorrect: isQuestionAnswerCorrect });",
  "const result = calculateSessionResult(banks, normalized, answers, { hasAnswer: hasQuestionAnswer });",
  "completed-history stored-answer scoring",
);

replaceRequired(
  "const result = calculateSessionResult(banks, activeSet, activeSet.answers, { hasAnswer: hasQuestionAnswer, isCorrect: isQuestionAnswerCorrect });",
  "const result = calculateSessionResult(banks, activeSet, activeSet.answers, { hasAnswer: hasQuestionAnswer });",
  "active-set stored-answer scoring",
);

source = source.replace(
  "// ABPN_MULTI_DECK_RUNTIME_APP_PATCH_V1",
  "// ABPN_MULTI_DECK_RUNTIME_APP_PATCH_V1\n" + patchMarker,
);

await writeFile(appPath, source, "utf8");
