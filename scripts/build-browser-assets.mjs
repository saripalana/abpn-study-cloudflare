import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Browser assets have one editable source. Files under public/ are deployment
// outputs and must be regenerated through this script rather than hand-edited.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoots = [
  { source: "src/browser", target: "public", extensions: new Set([".html", ".css", ".js"]) },
  { source: "src/client", target: "public/client", extensions: new Set([".js"]) },
];

async function assetManifest() {
  const assets = [];
  for (const entry of sourceRoots) {
    const names = (await readdir(path.join(root, entry.source), { withFileTypes: true }))
      .filter((item) => item.isFile() && entry.extensions.has(path.extname(item.name)))
      .map((item) => item.name)
      .sort();
    for (const name of names) {
      assets.push({
        source: path.join(root, entry.source, name),
        target: path.join(root, entry.target, name),
        label: `${entry.source}/${name} -> ${entry.target}/${name}`,
      });
    }
  }
  return assets;
}

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function compare(asset) {
  const source = await readFile(asset.source);
  let target = null;
  try {
    target = await readFile(asset.target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { ...asset, source, matches: target != null && source.equals(target) };
}

async function synchronize({ checkOnly = false } = {}) {
  const comparisons = await Promise.all((await assetManifest()).map(compare));
  const drift = comparisons.filter((asset) => !asset.matches);
  if (checkOnly && drift.length) {
    throw new Error(`Generated browser assets are stale:\n${drift.map((asset) => `- ${asset.label}`).join("\n")}`);
  }
  for (const asset of drift) {
    await mkdir(path.dirname(asset.target), { recursive: true });
    await writeFile(asset.target, asset.source);
  }
  return { changed: drift.map((asset) => asset.label) };
}

async function hashes() {
  return Object.fromEntries(await Promise.all((await assetManifest()).map(async (asset) => [
    asset.label,
    digest(await readFile(asset.target)),
  ])));
}

const mode = process.argv[2] ?? "--write";
if (!["--write", "--check", "--verify-idempotent"].includes(mode)) {
  throw new Error(`Unsupported browser-asset build mode: ${mode}`);
}

if (mode === "--check") {
  await synchronize({ checkOnly: true });
  console.log("Browser source and deployment assets match.");
} else if (mode === "--verify-idempotent") {
  await synchronize();
  const first = await hashes();
  const secondPass = await synchronize();
  const second = await hashes();
  if (secondPass.changed.length || JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("Browser-asset generation is not idempotent.");
  }
  console.log("Browser assets are deterministic and idempotent.");
} else {
  const result = await synchronize();
  console.log(result.changed.length
    ? `Generated ${result.changed.length} browser asset(s).`
    : "Browser assets already match canonical source.");
}
