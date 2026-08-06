import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Google Drive recovery is server-only, restricted, and never exposes credentials to browser assets", async () => {
  const [adapter, worker, browser, storage, production] = await Promise.all([
    read("src/google-drive-recovery-api.js"),
    read("src/worker.js"),
    read("public/backup-controller.js"),
    read("src/client/storage.js"),
    read("wrangler.toml"),
  ]);
  assert.match(adapter, /GOOGLE_DRIVE_REFRESH_TOKEN/);
  assert.match(adapter, /GOOGLE_DRIVE_RECOVERY_FOLDER_ID/);
  assert.match(adapter, /appProperties.*abpnRecovery/s);
  assert.match(adapter, /one-per-day-for-three-days/);
  assert.match(worker, /handleGoogleDriveRecoveryRequest/);
  assert.doesNotMatch(browser, /GOOGLE_DRIVE_(CLIENT|REFRESH|FOLDER)/);
  assert.doesNotMatch(storage, /googleapis\.com|oauth2\.googleapis\.com/);
  assert.doesNotMatch(production, /GOOGLE_DRIVE_CLIENT_SECRET|GOOGLE_DRIVE_REFRESH_TOKEN/);
});

test("local storage uses separate bank-bound progress keys", async () => {
  const storage = await read("src/client/storage.js");
  assert.match(storage, /keyPath:\s*\["bankId",\s*"questionId"\]/);
  assert.match(storage, /syncOutbox/);
  assert.match(storage, /snapshots/);
  assert.match(storage, /updatePracticeSet/);
  assert.match(storage, /updatePracticeSetAnswer/);
  assert.match(storage, /id: `\$\{entityType\}:\$\{entityKey\}`/);
});

test("phase 1 weakness analytics remain local, derived, and content-free", async () => {
  const [analytics, app] = await Promise.all([
    read("src/client/weakness-analytics.js"),
    read("public/app.js"),
  ]);
  assert.match(analytics, /limited-current-state/);
  assert.match(analytics, /priorityScore/);
  assert.doesNotMatch(analytics, /fetch\s*\(/);
  assert.doesNotMatch(analytics, /selectedAnswer|correctLetter|question\.question/);
  assert.match(app, /LOCAL-ONLY · LIMITED EVIDENCE/);
});

test("assistant weakness access is private, explicitly enabled, permissioned until revoked, separately deletable, and audited", async () => {
  const [api, controller, staging, production, migration, deletionMigration] = await Promise.all([
    read("src/assistant-weakness-api.js"),
    read("src/browser/assistant-weakness-controller.js"),
    read("wrangler.staging.toml"),
    read("wrangler.toml"),
    read("migrations/0007_assistant_weakness_staging.sql"),
    read("migrations/0008_assistant_weakness_delete_count.sql"),
  ]);
  assert.match(api, /\["staging", "production"\]\.includes\(env\.APP_ENV\)/);
  assert.match(api, /UNTIL_REVOKED_AT/);
  assert.match(api, /retention: "until-revoked"/);
  assert.match(api, /Explicit assistant-insights permission is required/);
  assert.match(api, /DELETE FROM assistant_weakness_snapshots/);
  assert.match(api, /delete_count = delete_count \+ 1/);
  assert.match(api, /snapshot-accessed/);
  assert.match(controller, /On until you revoke it/);
  assert.match(controller, /deleteWeaknessAggregateBtn/);
  assert.match(staging, /ASSISTANT_WEAKNESS_ENABLED\s*=\s*"true"/);
  assert.match(production, /APP_ENV\s*=\s*"production"/);
  assert.match(production, /ASSISTANT_WEAKNESS_ENABLED\s*=\s*"true"/);
  assert.match(migration, /assistant_weakness_permissions/);
  assert.match(migration, /assistant_weakness_snapshots/);
  assert.match(migration, /assistant_weakness_audit/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.match(deletionMigration, /ADD COLUMN delete_count/);
  assert.doesNotMatch(deletionMigration, /\bDROP\b/i);
});

test("dependency installation is locked and the audited HTTP client is patched", async () => {
  const [packageJson, packageLock, validationWorkflow] = await Promise.all([
    read("package.json"),
    read("package-lock.json"),
    read(".github/workflows/validate.yml"),
  ]);
  assert.match(packageJson, /"undici"\s*:\s*"7\.29\.0"/);
  assert.match(packageLock, /"node_modules\/undici"/);
  assert.match(packageLock, /"version"\s*:\s*"7\.29\.0"/);
  assert.match(validationWorkflow, /run:\s*npm ci --silent/);
  assert.doesNotMatch(validationWorkflow, /run:\s*npm install --silent/);
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

test("all user-facing banks use one protected persistent Deck Library", async () => {
  const [worker, api, sourceProxy, importer, generatedManifest, browserClient, bootstrap, migration, bootstrapMigration] = await Promise.all([
    read("src/worker.js"),
    read("src/deck-library-api.js"),
    read("src/starter-deck-source.js"),
    read("scripts/import-approved-banks.mjs"),
    read("public/banks/generated/ks-psychiatry-core.manifest.json"),
    read("public/client/deck-library.js"),
    read("public/bootstrap.js"),
    read("migrations/0004_cloud_deck_library.sql"),
    read("migrations/0006_deck_library_bootstrap.sql"),
  ]);
  assert.match(worker, /handleDeckLibraryRequest/);
  assert.match(api, /\/api\/decks/);
  assert.match(api, /MAX_DECK_PACKAGE_BYTES/);
  assert.match(api, /deck_package_chunks/);
  assert.match(api, /deck_library_state/);
  assert.match(api, /shared immutable revision protection contract/);
  assert.match(sourceProxy, /raw\.githubusercontent\.com\/dancingremote\/ks-study-guide\/ddfcba21/);
  assert.match(sourceProxy, /redirect: "error"/);
  assert.match(importer, /repository: 'dancingremote\/ks-study-guide'/);
  const ksManifest = JSON.parse(generatedManifest);
  assert.equal(ksManifest.repository, "dancingremote/ks-study-guide");
  assert.equal(ksManifest.commit, "ddfcba21e97973f77c08311400d05310a4ea1ee3");
  assert.equal(ksManifest.expectedGitBlobSha, "f4180d69a4a6bbd8a7f764bb88e7f2f404f7431f");
  assert.equal(ksManifest.questionCount, 602);
  assert.match(importer, /repository: 'dancingremote\/spiegel-test-prep'/);
  assert.match(importer, /expectedQuestionCount: 1060/);
  assert.match(browserClient, /publishCloudDeckPackage/);
  assert.match(browserClient, /refreshCloudDeckLibrary/);
  assert.match(browserClient, /getCloudDeckBootstrapState/);
  assert.match(browserClient, /setCloudDeckBootstrapState/);
  assert.match(browserClient, /pendingDeckUpload/);
  assert.match(bootstrap, /flushPendingCloudDeckUploads/);
  assert.match(bootstrap, /installSeedQuestionBanks/);
  assert.match(bootstrap, /refreshCloudDeckLibrary/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS deck_packages/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS deck_package_chunks/);
  assert.match(bootstrapMigration, /CREATE TABLE IF NOT EXISTS deck_library_state/);
});

test("system validation remains local-only after redundant header selector removal", async () => {
  const app = await read("src/browser/app.js");
  assert.match(app, /\['127\.0\.0\.1', 'localhost'\]\.includes/);
  assert.match(app, /resolveUserActiveDeck\(banks, selected, 'ks-psychiatry-core', allowSystemValidation\)/);
  assert.doesNotMatch(app, /id="bankSelect"/);
  assert.doesNotMatch(app, /Manage Deck Library/);
});

test("fresh staging and proposed production use the same approved two-deck catalog", async () => {
  const catalog = await read("public/banks/catalog.js");
  assert.match(catalog, /KS_SEED_BANK/);
  assert.match(catalog, /SPIEGEL_SEED_BANK/);
  assert.match(catalog, /QUESTION_BANKS = \[KS_SEED_BANK, SPIEGEL_SEED_BANK, VALIDATION_BANK\]/);
});

test("optional assistant status cannot block core dashboard controls", async () => {
  const app = await read("src/browser/app.js");
  const controlBinding = app.indexOf("document.getElementById('startBtn').onclick = startSet");
  const assistantBinding = app.indexOf("void attachAssistantWeaknessControls");
  assert.ok(controlBinding > -1 && assistantBinding > controlBinding);
  assert.match(app, /const assistantSection = document\.getElementById\('assistantInsightsSection'\)/);
});

test("browser deployment assets have one deterministic source and no runtime patch chain", async () => {
  const [packageJson, builder] = await Promise.all([
    read("package.json"),
    read("scripts/build-browser-assets.mjs"),
  ]);
  assert.match(packageJson, /"build:check"/);
  assert.match(packageJson, /"build:idempotence"/);
  assert.match(packageJson, /build-browser-assets\.mjs --verify-idempotent/);
  assert.doesNotMatch(packageJson, /patch-[a-z0-9-]+\.mjs/);
  assert.match(builder, /src\/browser/);
  assert.match(builder, /src\/client/);
  assert.match(builder, /Generated browser assets are stale/);
  assert.match(builder, /not idempotent/);
});

test("startup import remains disabled until its file handler is attached", async () => {
  const [html, bridge, controller] = await Promise.all([
    read("src/browser/index.html"),
    read("src/browser/import-button-bridge.js"),
    read("src/browser/question-bank-controller.js"),
  ]);
  assert.match(html, /id="importBankBtn"[\s\S]*?disabled/);
  assert.match(bridge, /button\.disabled = true/);
  assert.match(controller, /button\.disabled = false/);
  assert.match(controller, /importInput\.addEventListener\("change"/);
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

test("one parallel staging stack is production-equivalent but write-isolated", async () => {
  const [production, staging, worker, lifecycle, bootstrap] = await Promise.all([
    read("wrangler.toml"),
    read("wrangler.staging.toml"),
    read("src/worker.js"),
    read("src/client/staging-lifecycle.js"),
    read("src/browser/bootstrap.js"),
  ]);
  assert.match(staging, /name\s*=\s*"abpn-study-cloudflare-staging"/);
  assert.match(staging, /database_name\s*=\s*"abpn-study-db-staging"/);
  assert.match(staging, /APP_ENV\s*=\s*"staging"/);
  assert.match(staging, /STUDY_USER_ID\s*=\s*"staging-user"/);
  assert.match(staging, /STAGING_DISPOSABLE_ENABLED\s*=\s*"true"/);
  assert.match(staging, /STAGING_SESSION_TTL_SECONDS\s*=\s*"14400"/);
  assert.doesNotMatch(staging, /356b5061-81c2-4327-bdec-27127e03319d/);
  assert.doesNotMatch(production, /STAGING_DISPOSABLE_ENABLED/);
  assert.match(worker, /Disposable session cleanup is available only in isolated staging/);
  assert.match(worker, /DELETE FROM deck_package_heads WHERE user_id/);
  assert.match(worker, /DELETE FROM users WHERE id/);
  assert.match(lifecycle, /\/api\/health/);
  assert.match(lifecycle, /\/api\/staging\/session/);
  assert.match(lifecycle, /deleteStudyDatabase/);
  assert.match(bootstrap, /await ensureStagingSession\(\)/);
  assert.match(bootstrap, /importLiveBackupIntoStaging/);
  assert.match(bootstrap, /Live backup import was rejected; staging remains usable/);
  const syncController = await read("src/browser/sync-controller.js");
  assert.match(syncController, /sessionStorage\.getItem\(STAGING_SESSION_KEY\)/);
});
