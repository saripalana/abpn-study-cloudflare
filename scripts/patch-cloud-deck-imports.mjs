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
);

await patch("public/question-bank-controller.js", (source) => {
  if (!source.includes('import { publishCloudDeckPackage } from "./client/deck-library.js";')) {
    source = source.replace(
      'import { STORES, getRecord, putRecord, recordsByIndex } from "./client/storage.js";',
      'import { publishCloudDeckPackage } from "./client/deck-library.js";\nimport { STORES, getRecord, putRecord, recordsByIndex } from "./client/storage.js";',
    );
  }
  source = source.replace(
    "Question content is stored locally in its own versioned package store. Progress and completed tests remain in separate stores.",
    "The deck is saved to your protected Cloudflare Deck Library and cached locally for offline study. Progress and completed tests remain separate by deck.",
  );
  const installNeedle = "    const result = await installQuestionBankPackage(prepared, { reservedIds: protectedBankIds() });";
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
  if (source.includes(alertNeedle) && !source.includes("cloudPublication.queued ?")) {
    source = source.replace(
      alertNeedle,
      "      `${result.bank.questions.length} questions`,\n      cloudPublication.queued ? \"Saved locally and queued for Cloudflare when connectivity is restored.\" : \"Saved in your protected Cloudflare Deck Library and cached locally.\",\n      \"The original K&S package and all other decks were left unchanged.\",";
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
  source = source.replace(
    "Question content is stored locally in its own versioned package store. Progress and completed tests remain separate.",
    "The deck is saved to your protected Cloudflare Deck Library and cached locally for offline study. Progress and completed tests remain separate by deck.",
  );
  const installNeedle = "  const result = await installQuestionBankPackage(prepared, { reservedIds: protectedBankIds() });";
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
  if (source.includes(alertNeedle) && !source.includes("cloudPublication.queued ?")) {
    source = source.replace(
      alertNeedle,
      "    `${result.bank.questions.length} questions`,\n    cloudPublication.queued ? \"Saved locally and queued for Cloudflare when connectivity is restored.\" : \"Saved in your protected Cloudflare Deck Library and cached locally.\",\n    convertedFromLegacy ? \"The legacy Spiegel format was converted locally before being stored as this deck.\" : null,";
    );
  }
  return source;
});
