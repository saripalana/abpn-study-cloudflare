import { readFile, writeFile } from "node:fs/promises";

const workerPath = new URL("../src/worker.js", import.meta.url);
const marker = "// ABPN_CLOUD_DECK_LIBRARY_V1";
let source = await readFile(workerPath, "utf8");

if (source.includes(marker)) process.exit(0);

const importNeedle = "const json = (data, status = 200, extraHeaders = {}) =>";
if (!source.includes(importNeedle)) throw new Error("Could not find Worker JSON helper for deck-library patch.");
source = source.replace(
  importNeedle,
  `import { handleDeckLibraryRequest } from "./deck-library-api.js";\n\n${marker}\n${importNeedle}`,
);

const routeNeedle = `async function routeApi(request, env) {\n  const url = new URL(request.url);\n\n`;
if (!source.includes(routeNeedle)) throw new Error("Could not find Worker API router for deck-library patch.");
source = source.replace(
  routeNeedle,
  `async function routeApi(request, env) {\n  const url = new URL(request.url);\n\n  const deckResponse = await handleDeckLibraryRequest(request, env, {\n    json,\n    requireSyncReady,\n    requireContext,\n    reserveUsage,\n    ensureUserAndDevice,\n  });\n  if (deckResponse) return deckResponse;\n\n`,
);

await writeFile(workerPath, source, "utf8");
