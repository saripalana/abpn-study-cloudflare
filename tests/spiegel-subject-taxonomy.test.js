import test from "node:test";
import assert from "node:assert/strict";
import { KS_PSYCHIATRY_BANK } from "../public/banks/generated/ks-psychiatry-core.js";
import { SPIEGEL_TEST_PREP_BANK } from "../public/banks/generated/spiegel-test-prep.js";

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
