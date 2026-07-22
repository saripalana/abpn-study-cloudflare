import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transform) {
  const url = new URL(`../${path}`, import.meta.url);
  const source = await readFile(url, "utf8");
  const next = transform(source);
  if (next !== source) await writeFile(url, next, "utf8");
}

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
  if (!source.includes("await publishCloudDeckPackage(prepared);")) {
    if (!source.includes(installNeedle)) throw new Error("Could not patch file import cloud publication.");
    source = source.replace(
      installNeedle,
      "    await publishCloudDeckPackage(prepared);\n" + installNeedle,
    );
  }
  source = source.replace(
    "Question bank imported successfully.",
    "Deck added to your library successfully.",
  ).replace(
    "Question bank updated successfully.",
    "Deck updated in your library successfully.",
  );
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
  if (!source.includes("await publishCloudDeckPackage(prepared);")) {
    if (!source.includes(installNeedle)) throw new Error("Could not patch GitHub import cloud publication.");
    source = source.replace(
      installNeedle,
      "  setStatus(\"Saving the deck to your protected Cloudflare library…\");\n  await publishCloudDeckPackage(prepared);\n" + installNeedle,
    );
  }
  source = source.replace(
    "Question bank imported from GitHub.",
    "Deck added to your library from GitHub.",
  ).replace(
    "Question bank updated from GitHub.",
    "Deck updated in your library from GitHub.",
  );
  return source;
});
