import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../public/client/starter-decks.js", import.meta.url);
const source = await readFile(path, "utf8");
const next = source.replace(
  /const KS_SOURCE_URL = `https:\/\/raw\.githubusercontent\.com\/\$\{KS_STARTER_SOURCE\.repository\}\/\$\{KS_STARTER_SOURCE\.commit\}\/\$\{KS_STARTER_SOURCE\.path\}`;/,
  'const KS_SOURCE_URL = "/api/deck-sources/ks-psychiatry-core";',
);
if (!next.includes('const KS_SOURCE_URL = "/api/deck-sources/ks-psychiatry-core";')) {
  throw new Error("Could not route the K&S starter source through the protected Worker.");
}
if (next !== source) await writeFile(path, next, "utf8");
