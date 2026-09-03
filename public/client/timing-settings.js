// Purpose: keep timed practice-set duration rules consistent across the browser
// builder and multi-deck session creation.
export const DEFAULT_SECONDS_PER_QUESTION = 70.6;
export const MIN_SECONDS_PER_QUESTION = 10;
export const MAX_SECONDS_PER_QUESTION = 600;

export function normalizeSecondsPerQuestion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SECONDS_PER_QUESTION;
  const clamped = Math.min(MAX_SECONDS_PER_QUESTION, Math.max(MIN_SECONDS_PER_QUESTION, numeric));
  return Math.round(clamped * 10) / 10;
}

export function secondsPerQuestionLabel(value) {
  const normalized = normalizeSecondsPerQuestion(value);
  return `${Number.isInteger(normalized) ? normalized.toFixed(0) : normalized.toFixed(1)} sec/question`;
}
