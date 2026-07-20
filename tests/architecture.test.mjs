import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Cloudflare version contains no Google service dependencies", async () => {
  const files = await Promise.all([
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

test("local storage uses separate bank-bound progress keys", async () => {
  const storage = await read("src/client/storage.js");
  assert.match(storage, /keyPath:\s*\["bankId",\s*"questionId"\]/);
  assert.match(storage, /syncOutbox/);
  assert.match(storage, /snapshots/);
});

test("worker exposes health and bidirectional sync endpoints", async () => {
  const worker = await read("src/worker.js");
  assert.match(worker, /\/api\/health/);
  assert.match(worker, /\/api\/sync\/push/);
  assert.match(worker, /\/api\/sync\/pull/);
  assert.match(worker, /STUDY_USER_ID/);
  assert.match(worker, /x-abpn-device-id/);
});
