import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transform) {
  const url = new URL(`../${path}`, import.meta.url);
  const source = await readFile(url, "utf8");
  const next = transform(source);
  if (next !== source) await writeFile(url, next, "utf8");
}

await patch("public/app.js", (source) => source
  .replace("ACTIVE QUESTION BANK", "ACTIVE DECK")
  .replace("<strong>Question bank</strong>", "<strong>Deck</strong>")
  .replace("Question-bank packages are versioned separately", "Deck packages are versioned separately")
  .replace("      || banks.find((bank) => bank.id === 'ks-psychiatry-core')\n", "")
  .replace(
    "The protected K&S package and validation bank are loaded independently so future banks can be added without mixing progress.",
    "Every deck is loaded from the same protected Deck Library and keeps independent progress, history, and analytics.",
  )
  .replace("Import question bank", "Add deck from file")
);

await patch("public/data-management-controller.js", (source) => source
  .replaceAll("question bank", "deck")
  .replaceAll("Question-bank", "Deck")
  .replaceAll("other banks", "other decks")
  .replace("Reset current bank", "Reset current deck")
  .replace("selected question bank", "selected deck")
);

await patch("public/question-bank-controller.js", (source) => {
  if (!source.includes('import { publishCloudDeckPackage } from "./client/deck-library.js";')) {
    source = source.replace(
      'import { STORES, getRecord, putRecord, recordsByIndex } from "./client/storage.js";',
      'import { publishCloudDeckPackage } from "./client/deck-library.js";\nimport { STORES, getRecord, putRecord, recordsByIndex } from "./client/storage.js";',
    );
  }
  source = source
    .replace(/const protectedBankIds = \(\) =>[^;]+;\n/, "")
    .replaceAll("parseQuestionBankPackageFile(file, { reservedIds: protectedBankIds() })", "parseQuestionBankPackageFile(file)")
    .replaceAll("installQuestionBankPackage(prepared, { reservedIds: protectedBankIds() })", "installQuestionBankPackage(prepared)")
    .replace('if (bank.sourceType === "repository-protected") return "Protected source question bank";\n', "")
    .replace('if (bank.sourceType === "system-validation") return "Built-in system validation bank";\n', "")
    .replace('return "User-imported source question bank";', 'return "Source deck";')
    .replace('button.textContent = current.textContent?.trim() || "Import question bank";', 'button.textContent = current.textContent?.trim() || "Add deck from file";')
    .replace("Refresh the page once and try Import question bank again.", "Refresh the page once and try Add deck from file again.")
    .replace("Your existing question banks and study progress were not changed.", "Your existing decks and study progress were not changed.")
    .replace("Question content is stored locally in its own versioned package store. Progress and completed tests remain in separate stores.",
      "The deck is saved to your protected Cloudflare Deck Library and cached locally for offline study. Progress and completed tests remain separate by deck.")
    .replace("This material will remain separate from K&S, the validation bank, and assistant supplemental content.",
      "This material will remain separate from every other deck.")
    .replace('sourceType: bank.sourceType || "repository-protected",', 'sourceType: bank.sourceType || "user-imported",')
    .replace("const imported = !bank.protected && await getRecord(STORES.BANK_CONTENT, bank.id);", "const imported = await getRecord(STORES.BANK_CONTENT, bank.id);")
    .replace("Download bank package", "Download deck package")
    .replace("Question-bank packages are versioned separately from progress, completed tests, and portable study backups.",
      "Deck packages are versioned separately from progress, completed tests, and portable study backups.");

  const installNeedle = "    const result = await installQuestionBankPackage(prepared);";
  if (!source.includes("const cloudPublication = await publishCloudDeckPackage(prepared);")) {
    if (!source.includes(installNeedle)) throw new Error("Could not patch file import cloud publication.");
    source = source.replace(
      installNeedle,
      "    const cloudPublication = await publishCloudDeckPackage(prepared);\n" + installNeedle,
    );
  }
  source = source.replace(
    "Question bank imported successfully.",
    "Deck added to your library successfully.",
  ).replace(
    "Question bank updated successfully.",
    "Deck updated in your library successfully.",
  );
  const alertNeedle = "      `${result.bank.questions.length} questions`,\n      \"The original K&S package and all other banks were left unchanged.\",";
  if (source.includes(alertNeedle)) {
    source = source.replace(
      alertNeedle,
      '      `${result.bank.questions.length} questions`,\n      cloudPublication.queued ? "Saved locally and queued for Cloudflare when connectivity is restored." : "Saved in your protected Cloudflare Deck Library and cached locally.",\n      "All other decks were left unchanged.",',
    );
  }
  return source;
});

await patch("public/github-question-bank-controller.js", (source) => {
  if (!source.includes('import { publishCloudDeckPackage } from "./client/deck-library.js";')) {
    source = source.replace(
      'import { fetchGithubQuestionBankFile } from "./client/github-question-bank-source.js";',
      'import { publishCloudDeckPackage } from "./client/deck-library.js";\nimport { fetchGithubQuestionBankFile } from "./client/github-question-bank-source.js";',
    );
  }
  source = source
    .replace(/const protectedBankIds = \(\) =>[^;]+;\n/, "")
    .replaceAll("parseQuestionBankPackageFile(file, { reservedIds: protectedBankIds() })", "parseQuestionBankPackageFile(file)")
    .replaceAll("installQuestionBankPackage(prepared, { reservedIds: protectedBankIds() })", "installQuestionBankPackage(prepared)")
    .replace("Import from GitHub", "Add deck from GitHub")
    .replace("Question content is stored locally in its own versioned package store. Progress and completed tests remain separate.",
      "The deck is saved to your protected Cloudflare Deck Library and cached locally for offline study. Progress and completed tests remain separate by deck.")
    .replace("This material will remain separate from K&S, the validation bank, and assistant supplemental content.",
      "This material will remain separate from every other deck.")
    .replace("K&S and all other question banks were left unchanged.", "All other decks were left unchanged.");

  const installNeedle = "  const result = await installQuestionBankPackage(prepared);";
  if (!source.includes("const cloudPublication = await publishCloudDeckPackage(prepared);")) {
    if (!source.includes(installNeedle)) throw new Error("Could not patch GitHub import cloud publication.");
    source = source.replace(
      installNeedle,
      "  setStatus(\"Saving the deck to your protected Cloudflare library…\");\n  const cloudPublication = await publishCloudDeckPackage(prepared);\n" + installNeedle,
    );
  }
  source = source.replace(
    "Question bank imported from GitHub.",
    "Deck added to your library from GitHub.",
  ).replace(
    "Question bank updated from GitHub.",
    "Deck updated in your library from GitHub.",
  );
  const alertNeedle = "    `${result.bank.questions.length} questions`,\n    convertedFromLegacy ? \"The legacy Spiegel format was converted locally; its source content was not copied into this repository.\" : null,";
  if (source.includes(alertNeedle)) {
    source = source.replace(
      alertNeedle,
      '    `${result.bank.questions.length} questions`,\n    cloudPublication.queued ? "Saved locally and queued for Cloudflare when connectivity is restored." : "Saved in your protected Cloudflare Deck Library and cached locally.",\n    convertedFromLegacy ? "The legacy Spiegel format was converted locally before being stored as this deck." : null,',
    );
  }
  return source;
});
