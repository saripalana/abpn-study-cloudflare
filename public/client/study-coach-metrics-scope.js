export const INCLUDE_STUDY_COACH_METRICS_KEY = "abpn-study:include-study-coach-overall-metrics";

export function isStudyCoachDeck(deck) {
  return deck?.contentClass === "assistant-supplemental";
}

export function includeStudyCoachInOverallMetrics(storage = globalThis.localStorage) {
  return storage?.getItem?.(INCLUDE_STUDY_COACH_METRICS_KEY) === "true";
}

export function banksForOverallMetrics(banks = [], includeStudyCoach = false) {
  const available = Array.isArray(banks) ? banks.filter(Boolean) : [];
  return includeStudyCoach ? available : available.filter((bank) => !isStudyCoachDeck(bank));
}

export function studyRecordsForBanks({ banks = [], progress = [], sets = [], answers = [] } = {}) {
  const allowedBankIds = new Set(banks.map((bank) => String(bank.id)));
  const includedProgress = progress.filter((row) => allowedBankIds.has(String(row?.bankId || "")));
  const includedSets = sets.filter((set) => {
    const bankIds = Array.isArray(set?.selectedBankIds) && set.selectedBankIds.length
      ? set.selectedBankIds
      : set?.bankId
        ? [set.bankId]
        : [];
    return bankIds.length > 0 && bankIds.every((bankId) => allowedBankIds.has(String(bankId)));
  });
  const includedSetIds = new Set(includedSets.map((set) => String(set.id)));
  const includedAnswers = answers.filter((answer) => includedSetIds.has(String(answer?.setId || "")));
  return {
    progress: includedProgress,
    sets: includedSets,
    answers: includedAnswers,
  };
}
