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

const MAX_COACHING_QUESTIONS = 200;
const MAX_COMPLETED_TESTS = 100;
// Leave headroom beneath the Worker's 2 MiB request limit for deck summaries
// and HTTP/JSON overhead. Relevant items are ranked before this cap is applied.
const MAX_COACHING_ITEM_BYTES = 1_500_000;

function completedTestSummaries(sets = [], answers = []) {
  const answersBySet = new Map();
  for (const answer of answers) {
    const rows = answersBySet.get(answer.setId) || [];
    rows.push(answer);
    answersBySet.set(answer.setId, rows);
  }
  return sets
    .filter((set) => set?.status === "completed" || set?.submitted === true)
    .sort((a, b) => Date.parse(b.completedAt || b.updatedAt || 0) - Date.parse(a.completedAt || a.updatedAt || 0))
    .slice(0, MAX_COMPLETED_TESTS)
    .map((set) => {
      const rows = answersBySet.get(set.id) || [];
      const answered = rows.filter((row) => row?.selectedAnswer != null && row.selectedAnswer !== "");
      const questionCount = Array.isArray(set.questionIds) ? set.questionIds.length : answered.length;
      return {
        setId: String(set.id || "unknown"),
        bankIds: [...new Set((set.selectedBankIds?.length ? set.selectedBankIds : [set.bankId]).filter(Boolean).map(String))],
        mode: set.mode === "tutor" ? "tutor" : "test",
        timed: Boolean(set.timed),
        startedAt: set.startedAt || null,
        completedAt: set.completedAt || set.updatedAt || null,
        questionCount,
        answered: answered.length,
        correct: answered.filter((row) => row.isCorrect === true).length,
        incorrect: answered.filter((row) => row.isCorrect === false).length,
        omitted: Math.max(0, questionCount - answered.length),
        totalTimeMs: answered.reduce((sum, row) => sum + Math.max(0, Number(row.timeMs || 0)), 0),
      };
    });
}

/**
 * Builds the explicit Study Coach payload. It contains every aggregate needed
 * for coaching, while question content is limited to attempted, flagged, or
 * annotated items and ranked with incorrect/flagged work first. This avoids a
 * redundant full-bank copy and keeps the request within the Worker body limit.
 */
export function buildStudyCoachDataset(banks, progressRows, suppliedOptions = {}, history = {}) {
  const progressByBank = new Map();
  for (const row of progressRows || []) {
    const bankProgress = progressByBank.get(row.bankId) || new Map();
    bankProgress.set(row.questionId, row);
    progressByBank.set(row.bankId, bankProgress);
  }

  const decks = [];
  const coachingItems = [];
  for (const bank of banks || []) {
    const progress = progressByBank.get(bank.id) || new Map();
    const snapshot = buildWeaknessSnapshot(bank, progress, suppliedOptions);
    decks.push({
      id: String(bank.id || "unknown"),
      title: String(bank.title || "Study deck"),
      version: String(bank.version || "1"),
      totalQuestions: bank.questions.length,
      usedQuestions: [...progress.values()].filter((row) => Number(row?.timesUsed || 0) > 0).length,
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
    });

    for (const question of bank.questions) {
      const record = progress.get(question.id);
      const note = String(record?.note || record?.notes || "").trim();
      if (!record?.timesUsed && !record?.isFlagged && !note) continue;
      coachingItems.push({
        bankId: bank.id,
        questionId: question.id,
        subject: question.subjectTitle,
        testSection: question.chapterTitle,
        prompt: question.question,
        vignetteStem: question.vignetteStem,
        choices: question.choices.map((text, index) => ({ letter: question.choiceLetters[index], text })),
        selectedAnswer: record?.selectedAnswer ?? null,
        correctAnswer: [...question.correctLetters],
        answerText: question.answerText,
        explanation: question.explanation,
        note,
        isCorrect: record?.isCorrect ?? null,
        isFlagged: Boolean(record?.isFlagged),
        timesUsed: Math.max(0, Number(record?.timesUsed || 0)),
        totalTimeMs: Math.max(0, Number(record?.totalTimeMs || 0)),
        lastUsedAt: record?.lastUsedAt || null,
      });
    }
  }

  coachingItems.sort((a, b) =>
    Number(b.isFlagged) - Number(a.isFlagged)
    || Number(a.isCorrect !== false) - Number(b.isCorrect !== false)
    || Date.parse(b.lastUsedAt || 0) - Date.parse(a.lastUsedAt || 0));

  const selectedItems = [];
  let selectedBytes = 0;
  for (const item of coachingItems.slice(0, MAX_COACHING_QUESTIONS)) {
    const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (selectedBytes + itemBytes > MAX_COACHING_ITEM_BYTES) break;
    selectedItems.push(item);
    selectedBytes += itemBytes;
  }

  return {
    schemaVersion: 2,
    consentVersion: 2,
    generatedAt: new Date(suppliedOptions.now || Date.now()).toISOString(),
    selectionPolicy: "attempted-flagged-annotated-priority",
    decks,
    completedTests: completedTestSummaries(history.sets, history.answers),
    coachingItems: selectedItems,
    totalEligibleCoachingItems: coachingItems.length,
    truncated: coachingItems.length > selectedItems.length,
  };
}
