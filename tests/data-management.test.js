import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("browser and source data-management engines remain identical", async () => {
  const [source, browser] = await Promise.all([
    read("src/client/data-management.js"),
    read("public/client/data-management.js"),
  ]);
  assert.equal(browser, source);
});

test("destructive operations are scoped and snapshot-first", async () => {
  const source = await read("src/client/data-management.js");
  assert.match(source, /snapshotForAction\(`before-\$\{type\}`/);
  assert.match(source, /snapshotForAction\("before-reset-question-bank"/);
  assert.match(source, /record\.bankId === bankId/);
  assert.match(source, /set\.bankId === context\.bankId/);
  assert.match(source, /preferIncomingProgress/);
  assert.match(source, /preferIncomingTimestamp/);
  assert.doesNotMatch(source, /objectStore\(STORES\.BANKS\)\.clear/);
  assert.doesNotMatch(source, /objectStore\(STORES\.SNAPSHOTS\)\.clear/);
  assert.doesNotMatch(source, /indexedDB\.deleteDatabase/);
});

test("reset requires a typed second confirmation and explains its scope", async () => {
  const controller = await read("public/data-management-controller.js");
  assert.match(controller, /Type RESET to confirm/);
  assert.match(controller, /typed !== "RESET"/);
  assert.match(controller, /Question-bank content, other banks, downloaded backups, and Cloudflare data will not be deleted/);
  assert.match(controller, /Cumulative question performance and category analytics will not be recalculated or erased/);
  assert.match(controller, /Undo last deletion\/reset/);
});

test("the application loads data management controls without enabling cloud sync", async () => {
  const [index, wrangler] = await Promise.all([
    read("public/index.html"),
    read("wrangler.toml"),
  ]);
  assert.match(index, /data-management-controller\.js/);
  assert.match(index, /data-management\.css/);
  assert.match(wrangler, /CLOUD_SYNC_ENABLED\s*=\s*"false"/);
});
