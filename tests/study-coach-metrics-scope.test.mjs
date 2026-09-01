import assert from "node:assert/strict";
import test from "node:test";

import {
  INCLUDE_STUDY_COACH_METRICS_KEY,
  banksForOverallMetrics,
  includeStudyCoachInOverallMetrics,
  studyRecordsForBanks,
} from "../public/client/study-coach-metrics-scope.js";

const sourceBank = { id: "ks", contentClass: "source-material" };
const coachBank = { id: "coach", contentClass: "assistant-supplemental" };

test("Study Coach is excluded from overall metrics until the user includes it", () => {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
  };
  assert.equal(includeStudyCoachInOverallMetrics(localStorage), false);
  assert.deepEqual(banksForOverallMetrics([sourceBank, coachBank], false).map((bank) => bank.id), ["ks"]);

  storage.set(INCLUDE_STUDY_COACH_METRICS_KEY, "true");
  assert.equal(includeStudyCoachInOverallMetrics(localStorage), true);
  assert.deepEqual(banksForOverallMetrics([sourceBank, coachBank], true).map((bank) => bank.id), ["ks", "coach"]);
});

test("overall metric state excludes coach-only and mixed-deck test history consistently", () => {
  const result = studyRecordsForBanks({
    banks: [sourceBank],
    progress: [
      { bankId: "ks", questionId: "ks-1" },
      { bankId: "coach", questionId: "coach-1" },
    ],
    sets: [
      { id: "source-set", bankId: "ks" },
      { id: "coach-set", bankId: "coach" },
      { id: "mixed-set", selectedBankIds: ["ks", "coach"] },
    ],
    answers: [
      { setId: "source-set", questionId: "ks-1" },
      { setId: "coach-set", questionId: "coach-1" },
      { setId: "mixed-set", questionId: "ks::ks-1" },
    ],
  });

  assert.deepEqual(result.progress.map((row) => row.questionId), ["ks-1"]);
  assert.deepEqual(result.sets.map((set) => set.id), ["source-set"]);
  assert.deepEqual(result.answers.map((answer) => answer.setId), ["source-set"]);
});
