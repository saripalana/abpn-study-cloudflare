// Handoff labels must reflect exact lineage, not merely a newer output date.
import test from "node:test";
import assert from "node:assert/strict";
import { studyCoachHandoff } from "../src/client/study-coach-handoff.js";

const pkg = "2026-09-06T01:00:00.000Z";
const ready = { enabled: true, exchangeEnabled: true, latestPackage: { exportedAt: pkg },
  latestOutput: { generatedAt: "2026-09-06T02:00:00.000Z", sourcePackageGeneratedAt: pkg } };
test("coach handoff covers off, absent, waiting, ready, installed and stale lineage", () => {
  assert.match(studyCoachHandoff({}), /Turn on/);
  assert.match(studyCoachHandoff({ enabled: true, exchangeEnabled: true }), /No verified/);
  assert.match(studyCoachHandoff({ ...ready, latestOutput: null }), /awaiting analysis/);
  assert.match(studyCoachHandoff(ready), /New coach output ready/);
  assert.match(studyCoachHandoff(ready, ready.latestOutput), /output installed/);
  assert.match(studyCoachHandoff({ ...ready, latestOutput: { ...ready.latestOutput, sourcePackageGeneratedAt: "old" } }), /awaiting analysis/);
  assert.match(studyCoachHandoff({ ...ready, latestPackage: { exportedAt: "new" } }, ready.latestOutput), /awaiting analysis/);
});
