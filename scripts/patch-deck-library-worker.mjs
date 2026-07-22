import { readFile, writeFile } from "node:fs/promises";

const workerPath = new URL("../src/worker.js", import.meta.url);
let source = await readFile(workerPath, "utf8");

const importNeedle = "const json = (data, status = 200, extraHeaders = {}) =>";
if (!source.includes(importNeedle)) throw new Error("Could not find Worker JSON helper for deck-library patch.");

if (!source.includes('import { handleDeckLibraryRequest } from "./deck-library-api.js";')) {
  source = source.replace(
    importNeedle,
    `import { handleDeckLibraryRequest } from "./deck-library-api.js";\n\n${importNeedle}`,
  );
}
if (!source.includes('import { handleStarterDeckSourceRequest } from "./starter-deck-source.js";')) {
  source = source.replace(
    importNeedle,
    `import { handleStarterDeckSourceRequest } from "./starter-deck-source.js";\n\n${importNeedle}`,
  );
}

const routeNeedle = `async function routeApi(request, env) {\n  const url = new URL(request.url);\n\n`;
if (!source.includes(routeNeedle)) throw new Error("Could not find Worker API router for deck-library patch.");

if (!source.includes("const starterDeckSourceResponse = await handleStarterDeckSourceRequest")) {
  source = source.replace(
    routeNeedle,
    `async function routeApi(request, env) {\n  const url = new URL(request.url);\n\n  const starterDeckSourceResponse = await handleStarterDeckSourceRequest(request, env, {\n    json,\n    requireContext,\n  });\n  if (starterDeckSourceResponse) return starterDeckSourceResponse;\n\n`,
  );
}

if (!source.includes("const deckResponse = await handleDeckLibraryRequest")) {
  const starterRoute = `  if (starterDeckSourceResponse) return starterDeckSourceResponse;\n\n`;
  if (!source.includes(starterRoute)) throw new Error("Could not find starter deck source route insertion point.");
  source = source.replace(
    starterRoute,
    `${starterRoute}  const deckResponse = await handleDeckLibraryRequest(request, env, {\n    json,\n    requireSyncReady,\n    requireContext,\n    reserveUsage,\n    ensureUserAndDevice,\n  });\n  if (deckResponse) return deckResponse;\n\n`,
  );
}

await writeFile(workerPath, source, "utf8");
