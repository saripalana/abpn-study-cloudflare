// Phase 1 weakness analytics are deliberately pure and local-only. The output
// contains derived domain aggregates, never question text or answer content.
const DEFAULT_OPTIONS = Object.freeze({
  minimumEvidenceQuestions: 5,
  masteryAccuracy: 0.75,
  masterySpeedRatio: 1.25,
  recentWindowDays: 30,
});

const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));

function validDateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Builds a deterministic, limited-evidence snapshot from existing progress.
 * Current correctness is one state per question, so the score must not be
 * interpreted as attempt history, a repeated-miss streak, or a prediction.
 */
export function buildWeaknessSnapshot(bank, progress, suppliedOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  const nowMs = validDateMs(options.now) ?? Date.now();
  const minimumEvidence = Math.max(1, Number(options.minimumEvidenceQuestions) || DEFAULT_OPTIONS.minimumEvidenceQuestions);
  const usedRecords = [...progress.values()].filter((record) => Number(record?.timesUsed || 0) > 0);
  const totalAttempts = usedRecords.reduce((sum, record) => sum + Number(record.timesUsed || 0), 0);
  const totalTimeMs = usedRecords.reduce((sum, record) => sum + Math.max(0, Number(record.totalTimeMs || 0)), 0);
  const baselineTimeMs = totalAttempts ? totalTimeMs / totalAttempts : null;
  const groups = new Map();

  for (const question of bank.questions) {
    const title = String(question.subjectTitle || question.chapterTitle || 'Uncategorized');
    const row = groups.get(title) || {
      title,
      totalQuestions: 0,
      usedQuestions: 0,
      currentCorrect: 0,
      attempts: 0,
      totalTimeMs: 0,
      mostRecentMs: null,
    };
    row.totalQuestions += 1;

    const record = progress.get(question.id);
    const attempts = Number(record?.timesUsed || 0);
    if (attempts > 0) {
      row.usedQuestions += 1;
      row.attempts += attempts;
      row.totalTimeMs += Math.max(0, Number(record.totalTimeMs || 0));
      if (record.isCorrect === true) row.currentCorrect += 1;
      const lastUsedMs = validDateMs(record.lastUsedAt);
      if (lastUsedMs != null) row.mostRecentMs = Math.max(row.mostRecentMs ?? lastUsedMs, lastUsedMs);
    }
    groups.set(title, row);
  }

  const domains = [...groups.values()].map((row) => {
    // A Beta(1,1) prior keeps very small samples from displaying false certainty.
    const smoothedAccuracy = (row.currentCorrect + 1) / (row.usedQuestions + 2);
    const averageTimeMs = row.attempts ? row.totalTimeMs / row.attempts : null;
    const speedRatio = baselineTimeMs && averageTimeMs != null ? averageTimeMs / baselineTimeMs : null;
    const speedExcess = speedRatio == null ? 0 : clamp(speedRatio - 1);
    const daysSinceUse = row.mostRecentMs == null ? null : Math.max(0, (nowMs - row.mostRecentMs) / 86_400_000);
    const recency = daysSinceUse == null ? 0 : clamp(1 - daysSinceUse / options.recentWindowDays);
    const evidenceWeight = clamp(row.usedQuestions / minimumEvidence);
    const evidence = row.usedQuestions === 0 ? 'none' : row.usedQuestions < minimumEvidence ? 'limited' : 'adequate';

    // Accuracy leads; speed and recency are diagnostic modifiers. Evidence
    // weighting prevents a single question from dominating the priority list.
    const rawPriority = 0.75 * (1 - smoothedAccuracy) + 0.15 * speedExcess + 0.10 * recency;
    const priorityScore = row.usedQuestions ? Math.round(100 * rawPriority * (0.5 + 0.5 * evidenceWeight)) : null;
    const mastered = evidence === 'adequate'
      && smoothedAccuracy >= options.masteryAccuracy
      && (speedRatio == null || speedRatio <= options.masterySpeedRatio);

    return {
      title: row.title,
      totalQuestions: row.totalQuestions,
      usedQuestions: row.usedQuestions,
      attempts: row.attempts,
      smoothedAccuracy,
      averageTimeMs,
      speedRatio,
      daysSinceUse,
      evidence,
      priorityScore,
      mastered,
    };
  }).sort((a, b) => (b.priorityScore ?? -1) - (a.priorityScore ?? -1) || a.title.localeCompare(b.title));

  const adequateDomains = domains.filter((domain) => domain.evidence === 'adequate').length;
  const masteredDomains = domains.filter((domain) => domain.mastered).length;
  return {
    schemaVersion: 1,
    evidenceModel: 'limited-current-state',
    baselineTimeMs,
    domains,
    evidenceCoverage: domains.length ? adequateDomains / domains.length : null,
    masteryCoverage: domains.length ? masteredDomains / domains.length : null,
  };
}

/**
 * Produces the only payload that may cross the assistant-insights boundary.
 * The allowlist is intentional: callers cannot accidentally serialize the
 * source bank, question identifiers, answers, rationales, notes, or attempts.
 */
export function buildContentFreeWeaknessAggregate(bank, progress, suppliedOptions = {}) {
  const snapshot = buildWeaknessSnapshot(bank, progress, suppliedOptions);
  return {
    schemaVersion: 1,
    generatedAt: new Date(suppliedOptions.now || Date.now()).toISOString(),
    evidenceModel: snapshot.evidenceModel,
    deck: {
      id: String(bank.id || "unknown").slice(0, 100),
      title: String(bank.title || "Study deck").slice(0, 200),
    },
    summary: {
      evidenceCoverage: snapshot.evidenceCoverage,
      masteryCoverage: snapshot.masteryCoverage,
    },
    domains: snapshot.domains.map((domain) => ({
      title: domain.title,
      totalQuestions: domain.totalQuestions,
      usedQuestions: domain.usedQuestions,
      attempts: domain.attempts,
      accuracy: domain.smoothedAccuracy,
      averageTimeMs: domain.averageTimeMs,
      evidence: domain.evidence,
      priorityScore: domain.priorityScore,
      mastered: domain.mastered,
    })),
  };
}
