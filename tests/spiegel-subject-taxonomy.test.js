import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { REVIEWED_SPIEGEL_SUBJECTS, reviewedSpiegelSubject } from "../src/client/spiegel-reviewed-subjects.js";
import { KS_PSYCHIATRY_BANK } from "../public/banks/generated/ks-psychiatry-core.js";
import { SPIEGEL_TEST_PREP_BANK } from "../public/banks/generated/spiegel-test-prep.js";

test("reviewed subject corrections reach the generated bank without altering content or ordering", () => {
  const questions = new Map(SPIEGEL_TEST_PREP_BANK.questions.map((q) => [q.id, q]));
  for (const [id, subject] of Object.entries(REVIEWED_SPIEGEL_SUBJECTS)) {
    assert.equal(questions.get(id)?.subjectTitle, subject, id);
    assert.equal(reviewedSpiegelSubject(id, "unreviewed-source"), null);
  }
  // Pre-correction digest covers every field except subjectTitle, including IDs,
  // choices, keys, explanations and source test/vignette ordering. No source text
  // is stored in this regression test.
  const digest = createHash("sha256").update(JSON.stringify(
    SPIEGEL_TEST_PREP_BANK.questions.map(({ subjectTitle, ...rest }) => rest),
  )).digest("hex");
  assert.equal(digest, "fe1f1e091af30a4f2b773acd5b59b1297d3fedfd268ca0eea61b5dc9bd668553");
});

test("every Spiegel question uses an established K&S clinical subject", () => {
  const ksSubjects = new Set(KS_PSYCHIATRY_BANK.questions.map((question) => question.chapterTitle));
  assert.equal(SPIEGEL_TEST_PREP_BANK.questions.length, 1060);
  assert.ok(SPIEGEL_TEST_PREP_BANK.questions.every((question) => ksSubjects.has(question.subjectTitle)));
  assert.equal(SPIEGEL_TEST_PREP_BANK.questions.filter((question) => !question.subjectTitle).length, 0);
});

test("Spiegel classification provides broad subject coverage without changing question ids", () => {
  const subjects = new Set(SPIEGEL_TEST_PREP_BANK.questions.map((question) => question.subjectTitle));
  const ids = new Set(SPIEGEL_TEST_PREP_BANK.questions.map((question) => question.id));
  assert.ok(subjects.size >= 30);
  assert.equal(ids.size, 1060);
});
