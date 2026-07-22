import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function exists(path) {
  try {
    await read(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("Cloudflare version contains no Google service dependencies", async () => {
  const files = await Promise.all([
    read("src/access-worker.js"),
    read("src/worker.js"),
    read("src/client/storage.js"),
    read("src/client/sync.js"),
    read("wrangler.toml"),
  ]);
  const combined = files.join("\n").toLowerCase();
  for (const forbidden of [
    "googleapis.com",
    "accounts.google.com",
    "gapi.",
    "google drive",
    "drive.file",
    "oauth2",
  ]) {
    assert.equal(combined.includes(forbidden), false, `Unexpected Google dependency: ${forbidden}`);
  }
});

test("local storage uses separate deck-bound progress keys", async () => {
  const storage = await read("src/client/storage.js");
  assert.match(storage, /keyPath:\s*\["bankId",\s*"questionId"\]/);
  assert.match(storage, /syncOutbox/);
  assert.match(storage, /snapshots/);
  assert.match(storage, /updatePracticeSet/);
  assert.match(storage, /updatePracticeSetAnswer/);
  assert.match(storage, /id: `\$\{entityType\}:\$\{entityKey\}`/);
});

test("worker exposes health and bidirectional sync endpoints behind release controls", async () => {
  const worker = await read("src/worker.js");
  assert.match(worker, /\/api\/health/);
  assert.match(worker, /\/api\/sync\/push/);
  assert.match(worker, /\/api\/sync\/pull/);
  assert.match(worker, /STUDY_USER_ID/);
  assert.match(worker, /x-abpn-device-id/);
  assert.match(worker, /APP_RELEASE_MODE/);
  assert.match(worker, /CLOUD_SYNC_ENABLED/);
  assert.match(worker, /requireSyncReady/);
  assert.match(worker, /upsertPracticeSet/);
  assert.match(worker, /upsertPracticeSetAnswer/);
  assert.match(worker, /ensureQuestionBank/);
});

test("K&S and every other deck use the same protected persistent library", async () => {
  const [worker, api, browserClient, starterDecks, bootstrap, migration, stateMigration, catalog, packageJson] = await Promise.all([
    read("src/worker.js"),
    read("src/deck-library-api.js"),
    read("public/client/deck-library.js"),
    read("public/client/starter-decks.js"),
    read("public/bootstrap.js"),
    read("migrations/0004_cloud_deck_library.sql"),
    read("migrations/0005_unified_deck_bootstrap.sql"),
    read("public/banks/catalog.js"),
    read("package.json"),
  ]);
  assert.match(worker, /handleDeckLibraryRequest/);
  assert.match(api, /\/api\/decks/);
  assert.match(api, /\/api\/decks\/bootstrap/);
  assert.match(api, /MAX_DECK_PACKAGE_BYTES/);
  assert.match(api, /deck_package_chunks/);
  assert.doesNotMatch(api, /Protected built-in decks/);
  assert.match(browserClient, /publishCloudDeckPackage/);
  assert.match(browserClient, /refreshCloudDeckLibrary/);
  assert.match(browserClient, /pendingDeckUpload/);
  assert.doesNotMatch(browserClient, /reservedIds/);
  assert.match(starterDecks, /ks-psychiatry-core/);
  assert.match(starterDecks, /sourceType:\s*"user-imported"/);
  assert.match(starterDecks, /publishCloudDeckPackage/);
  assert.match(starterDecks, /installQuestionBankPackage/);
  assert.match(bootstrap, /ensureUnifiedStarterDecks/);
  assert.match(bootstrap, /refreshCloudDeckLibrary/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS deck_packages/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS deck_package_chunks/);
  assert.match(stateMigration, /CREATE TABLE IF NOT EXISTS deck_library_state/);
  assert.match(catalog, /QUESTION_BANKS = \[\]/);
  assert.equal(await exists("public/banks/generated/ks-psychiatry-core.js"), false);
  assert.equal(await exists("public/banks/generated/ks-psychiatry-core.manifest.json"), false);
  assert.match(packageJson, /patch-deck-library-worker\.mjs/);
  assert.match(packageJson, /patch-cloud-deck-imports\.mjs/);
});

test("Cloudflare Access JWT validation is the outer request gateway", async () => {
  const [accessWorker, wrangler, packageJson] = await Promise.all([
    read("src/access-worker.js"),
    read("wrangler.toml"),
    read("package.json"),
  ]);

  assert.match(wrangler, /main\s*=\s*"src\/access-worker\.js"/);
  assert.match(wrangler, /ACCESS_JWT_REQUIRED\s*=\s*"true"/);
  assert.match(wrangler, /ACCESS_TEAM_DOMAIN\s*=\s*"https:\/\/[^\"]+\.cloudflareaccess\.com"/);
  assert.match(wrangler, /ACCESS_POLICY_AUD\s*=\s*"[a-f0-9]+"/);
  assert.match(accessWorker, /cf-access-jwt-assertion/i);
  assert.match(accessWorker, /createRemoteJWKSet/);
  assert.match(accessWorker, /jwtVerify/);
  assert.match(accessWorker, /audience/);
  assert.match(accessWorker, /issuer/);
  assert.match(packageJson, /"jose"\s*:\s*"6\.2\.3"/);
});

test("verified D1 remains bound while protected cloud synchronization is enabled", async () => {
  const wrangler = await read("wrangler.toml");
  assert.match(wrangler, /run_worker_first\s*=\s*true/);
  assert.match(wrangler, /\[\[d1_databases\]\]/);
  assert.match(wrangler, /binding\s*=\s*"DB"/);
  assert.match(wrangler, /database_name\s*=\s*"abpn-study-db"/);
  assert.match(wrangler, /database_id\s*=\s*"356b5061-81c2-4327-bdec-27127e03319d"/);
  assert.match(wrangler, /migrations_dir\s*=\s*"\.\/migrations"/);
  assert.match(wrangler, /APP_RELEASE_MODE\s*=\s*"full"/);
  assert.match(wrangler, /CLOUD_SYNC_ENABLED\s*=\s*"true"/);
  assert.match(wrangler, /ACCESS_JWT_REQUIRED\s*=\s*"true"/);
  assert.doesNotMatch(wrangler, /00000000-0000-0000-0000-000000000000/);
});
