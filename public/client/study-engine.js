export function normalizeQuestion(question, index, bankId) {
  const choices = Array.isArray(question?.choices) ? question.choices.map(String) : [];
  const letters = Array.isArray(question?.choiceLetters) && question.choiceLetters.length === choices.length
    ? question.choiceLetters.map(String)
    : choices.map((_, i) => String.fromCharCode(65 + i));
  const id = String(question?.id || `${bankId}-${index + 1}`);
  const correctLetter = String(question?.correctLetter || "");
  if (!question || !String(question.question || "").trim() || choices.length < 2 || !letters.includes(correctLetter)) {
    throw new Error(`Invalid question ${id} in ${bankId}.`);
  }
  return Object.freeze({
    id,
    chapter: question.chapter ?? "",
    chapterTitle: String(question.chapterTitle || question.category || "Uncategorized").trim() || "Uncategorized",
    question: String(question.question),
    choices,
    choiceLetters: letters,
    correctLetter,
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

export function chooseQuestionIds(
  bank,
  progress,
  pool = "all",
  count = 40,
  random = Math.random,
  categories = null,
) {
  const eligible = eligibleQuestionIds(bank, progress, pool, categories);
  if (!eligible.length) return [];
  const shuffled = eligible.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.max(1, Math.min(Number(count) || 1, shuffled.length)));
}

export function calculateSetResult(questionIds, answers, bank) {
  let correct = 0;
  let answered = 0;
  for (const id of questionIds) {
    const selected = answers.get(id)?.selectedAnswer;
    if (selected) answered += 1;
    if (selected && selected === bank.byId.get(id)?.correctLetter) correct += 1;
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
