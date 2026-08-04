export function selectedAnswerLetters(value) {
  const values = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return [...new Set(values.map(String).filter(Boolean))];
}

export function isQuestionAnswerCorrect(question, selectedAnswer) {
  const selected = selectedAnswerLetters(selectedAnswer);
  const correct = selectedAnswerLetters(question?.correctLetters?.length ? question.correctLetters : question?.correctLetter);
  if (!selected.length || selected.length !== correct.length) return false;
  const selectedSet = new Set(selected);
  return correct.every((letter) => selectedSet.has(letter));
}

export function hasQuestionAnswer(answer) {
  return selectedAnswerLetters(answer?.selectedAnswer).length > 0;
}

export function normalizeQuestion(question, index, bankId) {
  const choices = Array.isArray(question?.choices) ? question.choices.map(String) : [];
  const letters = Array.isArray(question?.choiceLetters) && question.choiceLetters.length === choices.length
    ? question.choiceLetters.map(String)
    : choices.map((_, i) => String.fromCharCode(65 + i));
  const id = String(question?.id || `${bankId}-${index + 1}`);
  const correctLetters = selectedAnswerLetters(
    Array.isArray(question?.correctLetters) && question.correctLetters.length
      ? question.correctLetters
      : question?.correctLetter
  );
  const isMultiSelect = Boolean(question?.isMultiSelect || correctLetters.length > 1);
  const linkedGroupId = String(
    question?.linkedGroupId
    || question?.groupId
    || (String(question?.sectionType || question?.chapter || "").toLowerCase() === "vignette"
      ? `${bankId}:vignette:${question?.section || question?.chapterTitle || question?.category || "untitled"}`
      : "")
  ).trim();
  const linkedOrder = Number.isFinite(Number(question?.linkedOrder))
    ? Math.max(0, Math.trunc(Number(question.linkedOrder)))
    : index;
  if (
    !question
    || !String(question.question || "").trim()
    || choices.length < 2
    || !correctLetters.length
    || correctLetters.some((letter) => !letters.includes(letter))
    || new Set(correctLetters).size !== correctLetters.length
  ) {
    throw new Error(`Invalid question ${id} in ${bankId}.`);
  }
  return Object.freeze({
    id,
    chapter: question.chapter ?? "",
    chapterTitle: String(question.chapterTitle || question.category || "Uncategorized").trim() || "Uncategorized",
    question: String(question.question),
    vignetteStem: String(question.vignetteStem || ""),
    linkedGroupId,
    linkedOrder,
    choices,
    choiceLetters: letters,
    correctLetter: correctLetters[0],
    correctLetters: Object.freeze(correctLetters),
    isMultiSelect,
    answerText: String(question.answerText || ""),
    explanation: String(question.explanation || "No explanation provided.")
  });
}

export function normalizeBank(definition) {
  const id = String(definition?.id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) throw new Error(`Invalid bank id: ${id}`);
  const questions = (definition.questions || []).map((q, i) => normalizeQuestion(q, i, id));
  if (!questions.length) throw new Error(`${definition.title || id} has no questions.`);
  const ids = new Set();
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`Duplicate question id ${question.id} in ${id}.`);
    ids.add(question.id);
  }
  return Object.freeze({
    id,
    title: String(definition.title || id),
    shortTitle: String(definition.shortTitle || definition.title || id),
    description: String(definition.description || ""),
    version: String(definition.version || "1"),
    sourceType: String(definition.sourceType || "repository-protected"),
    contentClass: String(definition.contentClass || "source-material"),
    sourceLabel: String(definition.sourceLabel || ""),
    protected: Boolean(definition.protected),
    importedAt: definition.importedAt || null,
    checksum: definition.checksum || null,
    questions,
    byId: new Map(questions.map((q) => [q.id, q]))
  });
}

export function buildBankCatalog(definitions) {
  const seen = new Set();
  return definitions.map((definition) => {
    const bank = normalizeBank(definition);
    if (seen.has(bank.id)) throw new Error(`Duplicate bank id: ${bank.id}`);
    seen.add(bank.id);
    return bank;
  });
}

export function eligibleQuestionIds(bank, progress, pool = "all", categories = null) {
  const selectedCategories = categories == null
    ? null
    : new Set(Array.from(categories, (category) => String(category)));

  return bank.questions.filter((question) => {
    if (selectedCategories && !selectedCategories.has(question.chapterTitle)) return false;
    const record = progress.get(question.id);
    if (pool === "new") return !record || !record.timesUsed;
    if (pool === "used") return Number(record?.timesUsed || 0) > 0;
    if (pool === "incorrect") return record?.isCorrect === false;
    if (pool === "flagged") return record?.isFlagged === true;
    return true;
  }).map((question) => question.id);
}

export function eligibleQuestionGroups(bank, progress, pool = "all", categories = null) {
  const matched = new Set(eligibleQuestionIds(bank, progress, pool, categories));
  const groups = new Map();
  for (const question of bank.questions) {
    const key = question.linkedGroupId || `question:${question.id}`;
    const group = groups.get(key) || [];
    group.push(question);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.some((question) => matched.has(question.id)))
    .map((group) => group
      .slice()
      .sort((a, b) => a.linkedOrder - b.linkedOrder)
      .map((question) => question.id));
}

export function chooseQuestionIds(
  bank,
  progress,
  pool = "all",
  count = 40,
  random = Math.random,
  categories = null,
) {
  const groups = eligibleQuestionGroups(bank, progress, pool, categories);
  if (!groups.length) return [];
  const shuffled = groups.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const requested = Math.max(1, Number(count) || 1);
  const selected = [];
  for (const group of shuffled) {
    selected.push(...group);
    if (selected.length >= requested) break;
  }
  return selected;
}

export function calculateSetResult(questionIds, answers, bank) {
  let correct = 0;
  let answered = 0;
  for (const id of questionIds) {
    const answer = answers.get(id);
    if (hasQuestionAnswer(answer)) answered += 1;
    if (hasQuestionAnswer(answer) && isQuestionAnswerCorrect(bank.byId.get(id), answer.selectedAnswer)) correct += 1;
  }
  return { total: questionIds.length, answered, omitted: questionIds.length - answered, correct, incorrect: answered - correct };
}

export function categoryStatistics(bank, progress) {
  const groups = new Map();
  for (const question of bank.questions) {
    const row = groups.get(question.chapterTitle) || { title: question.chapterTitle, total: 0, answered: 0, correct: 0, totalTimeMs: 0 };
    row.total += 1;
    const record = progress.get(question.id);
    if (record?.timesUsed) {
      row.answered += 1;
      if (record.isCorrect === true) row.correct += 1;
      row.totalTimeMs += Number(record.totalTimeMs || 0);
    }
    groups.set(question.chapterTitle, row);
  }
  return [...groups.values()].map((row) => ({
    ...row,
    accuracy: row.answered ? row.correct / row.answered : null,
    averageTimeMs: row.answered ? row.totalTimeMs / row.answered : null
  })).sort((a, b) => b.answered - a.answered || a.title.localeCompare(b.title));
}
