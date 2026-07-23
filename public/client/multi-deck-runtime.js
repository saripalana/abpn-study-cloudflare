import { encodeQuestionRef } from "./multi-deck-practice.js";
import {
  isMultiDeckSet,
  resolveSetQuestion,
  storedQuestionKey,
} from "./multi-deck-set.js";

export function setQuestionReference(set, resolved) {
  if (!set || !resolved) return null;
  return isMultiDeckSet(set) || set.scope === "multi-deck"
    ? encodeQuestionRef(resolved.bankId, resolved.questionId)
    : resolved.questionId;
}

export function currentSetQuestion(decks, set) {
  const resolved = resolveSetQuestion(decks, set, set?.index || 0);
  if (!resolved) return null;
  const reference = setQuestionReference(set, resolved);
  return {
    ...resolved,
    reference,
    answerKey: storedQuestionKey(set, reference),
    progressBankId: resolved.bankId,
    progressQuestionId: resolved.questionId,
    displayDeckTitle: resolved.deck.shortTitle || resolved.deck.title,
  };
}

export function answerForSetQuestion(answers, set, resolved) {
  if (!resolved) return undefined;
  const reference = setQuestionReference(set, resolved);
  return answers?.get?.(storedQuestionKey(set, reference));
}

export function setQuestionItems(decks, set) {
  const count = set?.questionRefs?.length || set?.questionIds?.length || 0;
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const resolved = resolveSetQuestion(decks, set, index);
    if (!resolved) return [];
    const reference = setQuestionReference(set, resolved);
    items.push({
      index,
      ...resolved,
      reference,
      answerKey: storedQuestionKey(set, reference),
    });
  }
  return items;
}

export function answeredSetQuestionCount(decks, set, answers, hasAnswer = (entry) => Boolean(entry)) {
  return setQuestionItems(decks, set)
    .filter((item) => hasAnswer(answers?.get?.(item.answerKey)))
    .length;
}

export function progressTargetForResolvedQuestion(resolved) {
  if (!resolved) return null;
  return {
    bankId: resolved.bankId,
    questionId: resolved.questionId,
  };
}
