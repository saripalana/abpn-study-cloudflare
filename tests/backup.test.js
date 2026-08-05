import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  backupFilename,
  choosePreferredRecord,
  validatePortableBackup,
} from "../src/client/backup.js";
import { STORES } from "../src/client/storage.js";

const validBackup = () => ({
  format: BACKUP_FORMAT,
  schemaVersion: BACKUP_SCHEMA_VERSION,
  createdAt: "2026-07-21T12:00:00.000Z",
  questionContentIncluded: false,
  deviceSpecificSyncStateIncluded: false,
  data: {
    banks: [{ id: "validation-bank", title: "Validation Bank", updatedAt: "2026-07-21T12:00:00.000Z" }],
    progress: [{ bankId: "validation-bank", questionId: "validation-1", revision: 2, updatedAt: "2026-07-21T12:00:00.000Z" }],
    practiceSets: [{ id: "set-1", bankId: "validation-bank", questionIds: ["validation-1"], updatedAt: "2026-07-21T12:00:00.000Z" }],
    practiceSetAnswers: [{ setId: "set-1", questionId: "validation-1", updatedAt: "2026-07-21T12:00:00.000Z" }],
    snapshots: [{ id: "snapshot-1", createdAt: "2026-07-21T12:00:00.000Z", data: { banks: [], progress: [], sets: [], answers: [] } }],
  },
});

test("portable backup validates local records without question content", () => {
  const backup = validBackup();
  assert.equal(validatePortableBackup(backup), backup);
  assert.equal(backupFilename(backup.createdAt), "abpn-study-backup-2026-07-21T12-00-00-000Z.json");
});

test("portable backup rejects embedded question-bank content at any depth", () => {
  const backup = validBackup();
  backup.data.snapshots[0].data.questions = [{ id: "not-portable" }];
  assert.throws(() => validatePortableBackup(backup), /question-bank content/i);
});

test("portable backup rejects duplicate compound record keys", () => {
  const backup = validBackup();
  backup.data.progress.push({ ...backup.data.progress[0] });
  assert.throws(() => validatePortableBackup(backup), /duplicate record key/i);
});

test("progress restore prefers higher revision before timestamps", () => {
  const local = { bankId: "validation-bank", questionId: "validation-1", revision: 5, updatedAt: "2026-07-20T00:00:00.000Z" };
  const olderRevision = { ...local, revision: 4, updatedAt: "2026-07-22T00:00:00.000Z" };
  const newerRevision = { ...local, revision: 6, updatedAt: "2026-07-19T00:00:00.000Z" };
  assert.equal(choosePreferredRecord(STORES.PROGRESS, local, olderRevision), local);
  assert.equal(choosePreferredRecord(STORES.PROGRESS, local, newerRevision), newerRevision);
});

test("equal-revision progress and practice records prefer the later update", () => {
  const local = { id: "set-1", revision: 2, updatedAt: "2026-07-20T00:00:00.000Z" };
  const incoming = { ...local, updatedAt: "2026-07-21T00:00:00.000Z" };
  assert.equal(choosePreferredRecord(STORES.SETS, local, incoming), incoming);

  const localProgress = { bankId: "validation-bank", questionId: "validation-1", revision: 2, updatedAt: local.updatedAt };
  const incomingProgress = { ...localProgress, updatedAt: incoming.updatedAt };
  assert.equal(choosePreferredRecord(STORES.PROGRESS, localProgress, incomingProgress), incomingProgress);
});

test("browser and source backup implementations remain identical", async () => {
  const [source, browser] = await Promise.all([
    readFile(new URL("../src/client/backup.js", import.meta.url), "utf8"),
    readFile(new URL("../public/client/backup.js", import.meta.url), "utf8"),
  ]);
  assert.equal(browser, source);
});

test("complete recovery controller includes decks, integrity validation, safe merge, and deferred Safari reload", async () => {
  const controller = await readFile(new URL("../public/backup-controller.js", import.meta.url), "utf8");
  const contract = await readFile(new URL("../public/client/recovery-bundle.js", import.meta.url), "utf8");
  assert.match(contract, /\[STORES\.BANK_CONTENT\]: "bankContent"/);
  assert.match(contract, /\[STORES\.BANK_REVISIONS\]: "bankRevisions"/);
  assert.match(contract, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(contract, /newer records replace older ones/);
  assert.doesNotMatch(contract, /STORES\.OUTBOX.*:/);
  assert.match(controller, /validateRecoveryBundle/);
  assert.match(controller, /setTimeout\(\(\) => location\.reload\(\), 0\)/);
});

test("a successful first Google Drive backup immediately enables restore", async () => {
  const controller = await readFile(new URL("../src/browser/backup-controller.js", import.meta.url), "utf8");
  assert.match(controller, /async function saveGoogleDrive\(button, restoreButton, status\)/);
  assert.match(controller, /status\.textContent = `Last complete backup:[\s\S]*?restoreButton\.disabled = false;/);
  assert.match(controller, /saveGoogleDrive\(driveSave, driveRestore, driveStatus\)/);
});

test("a successful device backup records and displays its download time", async () => {
  const controller = await readFile(new URL("../src/browser/backup-controller.js", import.meta.url), "utf8");
  assert.match(controller, /LAST_DEVICE_BACKUP_AT_KEY = "abpn-study:last-device-backup-at"/);
  assert.match(controller, /async function exportBackup\(button, status\)/);
  assert.match(controller, /localStorage\.setItem\(LAST_DEVICE_BACKUP_AT_KEY, downloadedAt\)/);
  assert.match(controller, /Last complete backup downloaded:/);
  assert.match(controller, /exportBackup\(downloadButton, deviceStatus\)/);
});
