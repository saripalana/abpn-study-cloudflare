import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeWeaknessAggregate } from "../src/assistant-weakness-api.js";

const valid = {
  schemaVersion: 1,
  generatedAt: "2026-08-04T12:00:00.000Z",
  evidenceModel: "limited-current-state",
  deck: { id: "ks", title: "K&S" },
  summary: { evidenceCoverage: 0.5, masteryCoverage: 0.25 },
  domains: [{
    title: "Mood",
    totalQuestions: 20,
    usedQuestions: 10,
    attempts: 14,
    accuracy: 0.6,
    averageTimeMs: 40000,
    evidence: "adequate",
    priorityScore: 62,
    mastered: false,
  }],
};

test("server rebuilds assistant aggregates from a strict allowlist", () => {
  const sanitized = sanitizeWeaknessAggregate({
    ...valid,
    question: "must disappear",
    selectedAnswer: "A",
    domains: [{ ...valid.domains[0], rationale: "must disappear", questionIds: ["q1"] }],
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /must disappear|selectedAnswer|questionIds|rationale/);
  assert.deepEqual(sanitized, valid);
});

test("server rejects malformed, oversized, or out-of-range aggregate input", () => {
  assert.throws(() => sanitizeWeaknessAggregate({ ...valid, schemaVersion: 2 }), /schema/);
  assert.throws(() => sanitizeWeaknessAggregate({ ...valid, domains: Array.from({ length: 101 }, () => valid.domains[0]) }), /schema/);
  assert.throws(() => sanitizeWeaknessAggregate({ ...valid, summary: { ...valid.summary, evidenceCoverage: 2 } }), /evidenceCoverage/);
});
