import test from "node:test";
import assert from "node:assert/strict";
import {
  daysUntilExam,
  examCountdownText,
  normalizeExamDate,
  timeUntilExam,
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
  assert.deepEqual(timeUntilExam("2026-08-10", now), {
    milliseconds: 6 * 86_400_000 + 60_000,
    days: 6,
    hours: 0,
    minutes: 1,
    sameLocalDay: false,
  });
  assert.equal(examCountdownText("2026-08-10", now), "6d 0h 1m");
});
