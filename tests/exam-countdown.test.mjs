import test from "node:test";
import assert from "node:assert/strict";
import {
  daysUntilExam,
  examCountdownText,
  normalizeExamDate,
} from "../src/client/exam-countdown.js";

test("validates calendar dates without guessing", () => {
  assert.equal(normalizeExamDate("2026-09-30"), "2026-09-30");
  assert.equal(normalizeExamDate("2026-02-30"), "");
  assert.equal(normalizeExamDate(""), "");
});

test("calculates the local calendar-day countdown", () => {
  const now = new Date(2026, 7, 3, 23, 59);
  assert.equal(daysUntilExam("2026-08-03", now), 0);
  assert.equal(daysUntilExam("2026-08-04", now), 1);
  assert.equal(examCountdownText("2026-08-10", now), "7 days");
});
