import { setQuestionItems } from "./multi-deck-runtime.js";

export function calculateSessionResult(
  decks,
  set,
  answers,
  {
    hasAnswer = (entry) => Boolean(entry),
    isCorrect = (question, entry) => Boolean(entry?.isCorrect),
  } = {},
) {
  const items = setQuestionItems(decks, set);
  let answered = 0;
  let correct = 0;
  const byBank = new Map();

  for (const item of items) {
    const entry = answers?.get?.(item.answerKey);
    const bank = byBank.get(item.bankId) || {
      bankId: item.bankId,
      title: item.deck.shortTitle || item.deck.title,
      total: 0,
      answered: 0,
      correct: 0,
      incorrect: 0,
      omitted: 0,
    };
    bank.total += 1;

    if (!hasAnswer(entry)) {
      bank.omitted += 1;
      byBank.set(item.bankId, bank);
      continue;
    }

    answered += 1;
    bank.answered += 1;
    if (isCorrect(item.question, entry)) {
      correct += 1;
      bank.correct += 1;
    } else {
      bank.incorrect += 1;
    }
    byBank.set(item.bankId, bank);
  }

  return {
    total: items.length,
    answered,
    correct,
    incorrect: answered - correct,
    omitted: items.length - answered,
    byBank: [...byBank.values()],
  };
}

export function progressEntriesForSession(
  decks,
  set,
  answers,
  { hasAnswer = (entry) => Boolean(entry) } = {},
) {
  return setQuestionItems(decks, set)
    .map((item) => ({
      bankId: item.bankId,
      questionId: item.questionId,
      question: item.question,
      answerKey: item.answerKey,
      entry: answers?.get?.(item.answerKey),
    }))
    .filter((item) => hasAnswer(item.entry));
}

export function totalAnswerTimeMs(answers) {
  return [...(answers?.values?.() || [])]
    .reduce((total, entry) => total + Math.max(0, Number(entry?.timeMs || 0)), 0);
}
