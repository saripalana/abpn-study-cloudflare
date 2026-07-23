import { readFile, writeFile } from "node:fs/promises";

const appPath = new URL("../public/app.js", import.meta.url);
const patchMarker = "// ABPN_MULTI_DECK_RUNTIME_APP_PATCH_V1";
let source = await readFile(appPath, "utf8");

if (source.includes(patchMarker)) process.exit(0);

function replaceRequired(search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not apply ${label}; expected app.js source was not found.`);
  source = source.replace(search, replacement);
}

function replaceBlock(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0 || end <= start) throw new Error(`Could not apply ${label}; function boundaries were not found.`);
  source = source.slice(0, start) + replacement + source.slice(end);
}

replaceRequired(
  "import { createPracticeSession, persistenceRecordForSession } from './client/multi-deck-app-session.js';",
  "import { createPracticeSession, persistenceRecordForSession, sessionQuestionContext } from './client/multi-deck-app-session.js';\nimport { normalizeStoredSet } from './client/multi-deck-set.js';\nimport { setQuestionItems } from './client/multi-deck-runtime.js';\nimport { calculateSessionResult, progressEntriesForSession, totalAnswerTimeMs } from './client/multi-deck-results.js';\n\n" + patchMarker,
  "source-aware runtime imports",
);

replaceBlock(
  "async function hydrateStoredSet(saved) {",
  "async function loadActiveSet(bankId) {",
  `async function hydrateStoredSet(saved) {
  const normalized = normalizeStoredSet(saved, banks);
  if (!normalized) {
    if (saved) await putRecord(STORES.SETS, { ...saved, status: 'invalid', updatedAt: new Date().toISOString() });
    return null;
  }

  const savedAnswers = await recordsByIndex(STORES.ANSWERS, 'bySet', saved.id);
  const answers = new Map(savedAnswers.map((answer) => [answer.questionId, answer]));
  let remainingSeconds = Number(saved.remainingSeconds ?? 0);
  if (saved.status === 'active' && saved.timed && !saved.submitted && saved.updatedAt) {
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(saved.updatedAt).getTime()) / 1000));
    remainingSeconds = Math.max(0, remainingSeconds - elapsed);
  }

  return {
    ...normalized,
    index: Math.max(0, Math.min(Number(saved.index || 0), saved.questionIds.length - 1)),
    remainingSeconds,
    answers,
    submitted: Boolean(saved.submitted),
    completedAt: saved.completedAt ?? null,
  };
}

`,
  "combined-set hydration",
);

replaceBlock(
  "async function loadActiveSet(bankId) {",
  "async function completedSetHistory(bankId) {",
  `async function loadActiveSet(bankId) {
  const candidates = (await recordsByIndex(STORES.SETS, 'byStatus', 'active'))
    .filter((record) => record.bankId === bankId || record.selectedBankIds?.includes?.(bankId))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return hydrateStoredSet(candidates[0]);
}

`,
  "combined active-set loading",
);

replaceBlock(
  "async function completedSetHistory(bankId) {",
  "async function initialize() {",
  `async function completedSetHistory(bankId) {
  const records = (await recordsByIndex(STORES.SETS, 'byStatus', 'completed'))
    .filter((record) => record.submitted && (record.bankId === bankId || record.selectedBankIds?.includes?.(bankId)))
    .sort((a, b) => String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt)));

  return Promise.all(records.map(async (record) => {
    const normalized = normalizeStoredSet(record, banks);
    if (!normalized) return null;
    const answers = new Map((await recordsByIndex(STORES.ANSWERS, 'bySet', record.id)).map((answer) => [answer.questionId, answer]));
    const result = calculateSessionResult(banks, normalized, answers, { hasAnswer: hasQuestionAnswer, isCorrect: isQuestionAnswerCorrect });
    const totalTimeMs = totalAnswerTimeMs(answers);
    return {
      record,
      result,
      percentage: result.total ? Math.round(result.correct / result.total * 100) : 0,
      averageTimeMs: result.answered ? totalTimeMs / result.answered : 0,
    };
  })).then((items) => items.filter(Boolean));
}

`,
  "combined completed history",
);

replaceRequired(
  "  const resumable = activeSet && activeSet.bankId === activeBank.id && !activeSet.submitted;",
  "  const resumable = activeSet && !activeSet.submitted && (activeSet.bankId === activeBank.id || activeSet.selectedBankIds?.includes?.(activeBank.id));",
  "combined resumable-set visibility",
);

replaceRequired(
  `      const combined = settings.scope !== DECK_SCOPE_CURRENT;
      startButton.textContent = combined ? 'Combined-deck runtime pending validation' : 'Start randomized set';
      startButton.disabled = combined;
      if (combined) {
        eligibleCount.textContent = 'Combined-deck selection is configured. Starting the set will be enabled after source-aware question rendering passes validation.';
        eligibleCount.dataset.empty = 'true';
      } else {
        updateBuilderAvailability();
      }`,
  `      const combined = settings.scope !== DECK_SCOPE_CURRENT;
      startButton.textContent = combined ? 'Start combined randomized set' : 'Start randomized set';
      startButton.disabled = false;
      if (combined) {
        eligibleCount.textContent = document.getElementById('deckScopeAvailability')?.textContent || 'Selected study decks ready.';
        eligibleCount.dataset.empty = 'false';
      } else {
        updateBuilderAvailability();
      }`,
  "combined Start enablement",
);

replaceBlock(
  "async function renderQuestion() {",
  "homeBtn.onclick = async () => {",
  `async function renderQuestion() {
  if (!activeSet) return renderDashboard();
  clearInterval(timer);
  homeBtn.hidden = false;

  const context = sessionQuestionContext(banks, activeSet);
  const items = setQuestionItems(banks, activeSet);
  if (!context || !items.length) {
    await saveActiveSet('invalid');
    activeSet = null;
    return renderDashboard();
  }

  const { question } = context;
  const answer = activeSet.answers.get(context.answerKey);
  const selectedLetters = selectedAnswerLetters(answer?.selectedAnswer);
  const hasAnswer = selectedLetters.length > 0;
  const tutorFinalized = !question.isMultiSelect || answer?.finalized === true;
  const reveal = activeSet.submitted || (activeSet.mode === 'tutor' && hasAnswer && tutorFinalized);
  const progressByBank = new Map();
  for (const bankId of [...new Set(items.map((item) => item.bankId))]) progressByBank.set(bankId, await progressMap(bankId));
  const progress = progressByBank.get(context.bankId) || new Map();
  const flagged = progress.get(context.questionId)?.isFlagged;
  const isLastQuestion = activeSet.index === items.length - 1;
  const answeredCount = items.filter((item) => hasQuestionAnswer(activeSet.answers.get(item.answerKey))).length;
  const unansweredCount = Math.max(0, items.length - answeredCount);
  const correctLetters = selectedAnswerLetters(question.correctLetters?.length ? question.correctLetters : question.correctLetter);
  const answeredCorrectly = hasAnswer && isQuestionAnswerCorrect(question, selectedLetters);
  const answerLocked = activeSet.submitted || (activeSet.mode === 'tutor' && reveal);
  const finalNavigation = activeSet.submitted && isLastQuestion
    ? '<button id="resultsBtn" class="primary" type="button">View results</button>'
    : \`<button id="nextBtn" class="primary" type="button" \${isLastQuestion ? 'disabled' : ''}>Next</button>\`;

  startedQuestionAt = Date.now();
  app.innerHTML = \`
    <section class="card exam">
      <div class="exam-head"><div>
        <div class="eyebrow" style="color:var(--blue)">\${esc(context.displayDeckTitle)}</div>
        <h2>Question \${activeSet.index + 1} of \${items.length}</h2>
        <div class="question-status-row"><span class="question-state \${hasAnswer ? 'answered' : 'unanswered'}">\${hasAnswer ? 'Answered' : 'Unanswered'}</span><span class="muted">\${answeredCount} answered · \${unansweredCount} unanswered</span></div>
      </div><div id="timer" class="timer">\${activeSet.timed ? formatTime(activeSet.remainingSeconds) : 'Untimed'}</div></div>
      <div class="progress"><span style="width:\${(activeSet.index + 1) / items.length * 100}%"></span></div>
      \${question.vignetteStem ? \`<div class="vignette-stem"><strong>Clinical vignette</strong><div>\${esc(question.vignetteStem)}</div></div>\` : ''}
      <div class="question">\${esc(question.question)}</div>
      \${question.isMultiSelect ? '<p class="multi-select-hint">Select all that apply. Full credit requires the exact set of correct choices.</p>' : ''}
      <div class="choices">\${question.choices.map((choice, index) => {
        const letter = question.choiceLetters[index];
        const selected = selectedLetters.includes(letter);
        const correct = correctLetters.includes(letter);
        let classes = 'choice';
        if (selected) classes += ' selected';
        if (reveal && correct) classes += ' correct';
        if (reveal && selected && !correct) classes += ' incorrect';
        if (reveal && correct && !selected) classes += ' missed-correct';
        return \`<button class="\${classes}" data-answer="\${esc(letter)}" aria-pressed="\${selected}" \${answerLocked ? 'disabled' : ''}><span class="letter">\${esc(letter)}</span><span>\${esc(choice)}</span></button>\`;
      }).join('')}</div>
      \${reveal ? \`<div class="explanation"><strong>\${answeredCorrectly ? 'Correct' : \`Correct answer\${correctLetters.length === 1 ? '' : 's'}: \${esc(correctLetters.join(', '))}\`}</strong>\${question.answerText ? \`<div class="answer-text">\${esc(question.answerText)}</div>\` : ''}<div>\${esc(question.explanation)}</div></div>\` : ''}
      <div class="actions question-actions"><button id="flagBtn" class="secondary" type="button">\${flagged ? 'Unflag' : 'Flag'} question</button>\${question.isMultiSelect && activeSet.mode === 'tutor' && !activeSet.submitted && !reveal ? \`<button id="checkAnswerBtn" class="primary" type="button" \${hasAnswer ? '' : 'disabled'}>Check answer</button>\` : ''}\${!activeSet.submitted ? '<button id="submitBtn" class="danger" type="button">Submit set</button>' : ''}</div>
      <div class="question-map-legend"><span><i class="legend-swatch answered"></i>Answered</span><span><i class="legend-swatch unanswered"></i>Unanswered</span><span><i class="legend-flag">★</i>Flagged</span></div>
      <div class="question-map">\${items.map((item, index) => {
        const answeredStatus = hasQuestionAnswer(activeSet.answers.get(item.answerKey)) ? 'answered' : 'unanswered';
        const flaggedStatus = progressByBank.get(item.bankId)?.get(item.questionId)?.isFlagged ? ' flagged' : '';
        const currentStatus = index === activeSet.index ? ' current' : '';
        return \`<button type="button" data-index="\${index}" class="\${answeredStatus}\${flaggedStatus}\${currentStatus}">\${index + 1}</button>\`;
      }).join('')}</div>
      <div class="exam-nav"><button id="prevBtn" class="secondary" type="button" \${activeSet.index === 0 ? 'disabled' : ''}>Previous</button><button id="exitBtn" class="secondary" type="button">\${activeSet.submitted ? 'Back to dashboard' : 'Save and exit'}</button>\${finalNavigation}</div>
    </section>\`;

  document.querySelectorAll('.choice').forEach((button) => { button.onclick = () => answerQuestion(context, button.dataset.answer); });
  document.getElementById('checkAnswerBtn')?.addEventListener('click', () => finalizeMultiSelectAnswer(context));
  document.getElementById('flagBtn').onclick = async () => {
    const old = progress.get(context.questionId);
    await updateQuestionProgress({ bankId: context.bankId, questionId: context.questionId, deviceId, patch: { isFlagged: !old?.isFlagged } });
    await renderQuestion();
  };
  document.getElementById('submitBtn')?.addEventListener('click', async () => { if (submissionConfirmation()) await submitSet({ showResults: true }); });
  document.querySelectorAll('.question-map button').forEach((button) => { button.onclick = async () => { activeSet.index = Number(button.dataset.index); await saveActiveSet(); await renderQuestion(); }; });
  document.getElementById('prevBtn').onclick = async () => { activeSet.index -= 1; await saveActiveSet(); await renderQuestion(); };
  document.getElementById('nextBtn')?.addEventListener('click', async () => { activeSet.index += 1; await saveActiveSet(); await renderQuestion(); });
  document.getElementById('exitBtn').onclick = async () => { if (activeSet.submitted) activeSet = null; else await saveActiveSet(); await renderDashboard(); };
  document.getElementById('resultsBtn')?.addEventListener('click', renderResults);
  if (activeSet.timed && !activeSet.submitted) timer = setInterval(async () => {
    activeSet.remainingSeconds = Math.max(0, activeSet.remainingSeconds - 1);
    const element = document.getElementById('timer'); if (element) element.textContent = formatTime(activeSet.remainingSeconds);
    if (activeSet.remainingSeconds % 5 === 0) await saveActiveSet();
    if (activeSet.remainingSeconds <= 0) { clearInterval(timer); await submitSet({ auto: true, showResults: true }); }
  }, 1000);
}

async function persistSetAnswer(context, entry) {
  activeSet.answers.set(context.answerKey, entry);
  await updatePracticeSetAnswer({ deviceId, record: { setId: activeSet.id, questionId: context.answerKey, ...entry } });
}

async function answerQuestion(context, selectedAnswer) {
  if (activeSet.submitted) return;
  const question = context.question;
  const existing = activeSet.answers.get(context.answerKey);
  if (activeSet.mode === 'tutor' && existing?.finalized) return;
  const elapsed = Math.max(0, Date.now() - startedQuestionAt);
  if (question.isMultiSelect) {
    const current = selectedAnswerLetters(existing?.selectedAnswer);
    const selected = current.includes(selectedAnswer) ? current.filter((letter) => letter !== selectedAnswer) : [...current, selectedAnswer];
    const ordered = question.choiceLetters.filter((letter) => selected.includes(letter));
    await persistSetAnswer(context, { selectedAnswer: ordered, isCorrect: isQuestionAnswerCorrect(question, ordered), finalized: false, timeMs: Number(existing?.timeMs || 0) + elapsed, updatedAt: new Date().toISOString() });
  } else {
    const entry = { selectedAnswer, isCorrect: isQuestionAnswerCorrect(question, selectedAnswer), finalized: true, timeMs: Number(existing?.timeMs || 0) + elapsed, updatedAt: new Date().toISOString() };
    await persistSetAnswer(context, entry);
    if (activeSet.mode === 'tutor') await saveProgress(context, entry);
  }
  await saveActiveSet(); await renderQuestion();
}

async function finalizeMultiSelectAnswer(context) {
  const existing = activeSet.answers.get(context.answerKey);
  if (!hasQuestionAnswer(existing)) return alert('Select at least one answer before checking this question.');
  const entry = { ...existing, isCorrect: isQuestionAnswerCorrect(context.question, existing.selectedAnswer), finalized: true, timeMs: Number(existing.timeMs || 0) + Math.max(0, Date.now() - startedQuestionAt), updatedAt: new Date().toISOString() };
  await persistSetAnswer(context, entry); await saveProgress(context, entry); await saveActiveSet(); await renderQuestion();
}

async function saveProgress(context, entry) {
  const current = (await progressMap(context.bankId)).get(context.questionId);
  await updateQuestionProgress({ bankId: context.bankId, questionId: context.questionId, deviceId, patch: { selectedAnswer: entry.selectedAnswer, isCorrect: entry.isCorrect, timesUsed: Number(current?.timesUsed || 0) + 1, totalTimeMs: Number(current?.totalTimeMs || 0) + Number(entry.timeMs || 0), lastUsedAt: new Date().toISOString() } });
}

async function submitSet({ auto = false, showResults = true } = {}) {
  if (!activeSet || activeSet.submitted) return;
  activeSet.submitted = true; activeSet.completedAt = new Date().toISOString();
  if (activeSet.mode === 'test') {
    for (const item of progressEntriesForSession(banks, activeSet, activeSet.answers, { hasAnswer: hasQuestionAnswer })) {
      await saveProgress({ bankId: item.bankId, questionId: item.questionId, question: item.question }, item.entry);
    }
  }
  await saveActiveSet('completed');
  if (auto) alert('Time expired. The set was submitted.');
  if (showResults) renderResults(); else await renderQuestion();
}

function renderResults() {
  clearInterval(timer);
  const result = calculateSessionResult(banks, activeSet, activeSet.answers, { hasAnswer: hasQuestionAnswer, isCorrect: isQuestionAnswerCorrect });
  const percentage = result.total ? Math.round(result.correct / result.total * 100) : 0;
  const averageTimeMs = result.answered ? totalAnswerTimeMs(activeSet.answers) / result.answered : 0;
  app.innerHTML = \`<section class="card results-card"><div class="eyebrow" style="color:var(--blue)">SET RESULTS</div><h2>\${result.correct}/\${result.total} correct (\${percentage}%)</h2><p class="muted">\${result.answered} answered · \${result.omitted} omitted · \${result.incorrect} incorrect</p><div class="result-stats"><div class="stat"><strong>\${percentage}%</strong><span>Score</span></div><div class="stat"><strong>\${result.omitted}</strong><span>Omitted</span></div><div class="stat"><strong>\${result.answered ? formatSeconds(averageTimeMs) : '—'}</strong><span>Average time/question</span></div></div>\${result.byBank.length > 1 ? \`<table class="summary-table"><thead><tr><th>Deck</th><th>Correct</th><th>Answered</th></tr></thead><tbody>\${result.byBank.map((bank) => \`<tr><td>\${esc(bank.title)}</td><td>\${bank.correct}/\${bank.total}</td><td>\${bank.answered}</td></tr>\`).join('')}</tbody></table>\` : ''}<p class="notice">This completed test is saved locally in History / Previous tests and can be reviewed again later.</p><div class="actions"><button id="reviewBtn" class="secondary" type="button">Review questions</button><button id="finishBtn" class="primary" type="button">Back to dashboard</button></div></section>\`;
  document.getElementById('reviewBtn').onclick = async () => { activeSet.index = 0; await saveActiveSet('completed'); await renderQuestion(); };
  document.getElementById('finishBtn').onclick = async () => { activeSet = null; await renderDashboard(); };
}

async function openCompletedSet(setId) {
  const saved = await getRecord(STORES.SETS, setId);
  if (!saved || saved.status !== 'completed' || !(saved.bankId === activeBank.id || saved.selectedBankIds?.includes?.(activeBank.id))) return alert('That completed test could not be found for the selected question bank.');
  const hydrated = await hydrateStoredSet(saved);
  if (!hydrated) return alert('That completed test contains question references that are no longer available.');
  activeSet = hydrated; activeSet.submitted = true; renderResults();
}

`,
  "source-aware question runtime",
);

await writeFile(appPath, source, "utf8");
