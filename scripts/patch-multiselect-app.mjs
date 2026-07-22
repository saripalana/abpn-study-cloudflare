import { readFile, writeFile } from "node:fs/promises";

const appPath = new URL("../public/app.js", import.meta.url);
const patchMarker = "// ABPN_MULTI_SELECT_PATCH_V1";
let source = await readFile(appPath, "utf8");

if (source.includes(patchMarker)) process.exit(0);

function replaceRequired(search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not apply ${label}; expected app.js source was not found.`);
  source = source.replace(search, replacement);
}

replaceRequired(
  "  calculateSetResult,\n  categoryStatistics\n} from './client/study-engine.js';",
  "  calculateSetResult,\n  categoryStatistics,\n  hasQuestionAnswer,\n  isQuestionAnswerCorrect,\n  selectedAnswerLetters\n} from './client/study-engine.js';\n\n" + patchMarker,
  "multi-select study-engine imports",
);

replaceRequired(
  "  const answered = activeSet.answers.size;",
  "  const answered = [...activeSet.answers.values()].filter(hasQuestionAnswer).length;",
  "submission answer count",
);

replaceRequired(
  "      if (entry) await saveProgress(activeBank.byId.get(id), entry);",
  "      if (entry && hasQuestionAnswer(entry)) await saveProgress(activeBank.byId.get(id), entry);",
  "omitted multi-select submission handling",
);

const renderStart = source.indexOf("async function renderQuestion() {");
const answerStart = source.indexOf("async function answerQuestion(question, selectedAnswer) {");
if (renderStart < 0 || answerStart < 0 || answerStart <= renderStart) {
  throw new Error("Could not locate renderQuestion/answerQuestion for multi-select compatibility.");
}

const renderQuestion = `async function renderQuestion() {
  if (!activeSet) return renderDashboard();

  clearInterval(timer);
  homeBtn.hidden = false;

  const question = activeBank.byId.get(activeSet.questionIds[activeSet.index]);
  if (!question) {
    await saveActiveSet('invalid');
    activeSet = null;
    return renderDashboard();
  }

  const answer = activeSet.answers.get(question.id);
  const selectedLetters = selectedAnswerLetters(answer?.selectedAnswer);
  const hasAnswer = selectedLetters.length > 0;
  const tutorFinalized = !question.isMultiSelect || answer?.finalized === true;
  const reveal = activeSet.submitted || (activeSet.mode === 'tutor' && hasAnswer && tutorFinalized);
  const progress = await progressMap(activeBank.id);
  const flagged = progress.get(question.id)?.isFlagged;
  const isLastQuestion = activeSet.index === activeSet.questionIds.length - 1;
  const answeredCount = [...activeSet.answers.values()].filter(hasQuestionAnswer).length;
  const unansweredCount = Math.max(0, activeSet.questionIds.length - answeredCount);
  const finalNavigation = activeSet.submitted && isLastQuestion
    ? '<button id="resultsBtn" class="primary" type="button">View results</button>'
    : \`<button id="nextBtn" class="primary" type="button" \${isLastQuestion ? 'disabled' : ''}>Next</button>\`;
  const answerLocked = activeSet.submitted || (activeSet.mode === 'tutor' && reveal);
  const correctLetters = selectedAnswerLetters(question.correctLetters?.length ? question.correctLetters : question.correctLetter);
  const answeredCorrectly = hasAnswer && isQuestionAnswerCorrect(question, selectedLetters);

  startedQuestionAt = Date.now();

  app.innerHTML = \`
    <section class="card exam">
      <div class="exam-head">
        <div>
          <div class="eyebrow" style="color:var(--blue)">\${esc(activeBank.shortTitle)}</div>
          <h2>Question \${activeSet.index + 1} of \${activeSet.questionIds.length}</h2>
          <div class="question-status-row">
            <span class="question-state \${hasAnswer ? 'answered' : 'unanswered'}">\${hasAnswer ? 'Answered' : 'Unanswered'}</span>
            <span class="muted">\${answeredCount} answered · \${unansweredCount} unanswered</span>
          </div>
        </div>
        <div id="timer" class="timer">\${activeSet.timed ? formatTime(activeSet.remainingSeconds) : 'Untimed'}</div>
      </div>

      <div class="progress"><span style="width:\${(activeSet.index + 1) / activeSet.questionIds.length * 100}%"></span></div>
      \${question.vignetteStem ? \`<div class="vignette-stem"><strong>Clinical vignette</strong><div>\${esc(question.vignetteStem)}</div></div>\` : ''}
      <div class="question">\${esc(question.question)}</div>
      \${question.isMultiSelect ? '<p class="multi-select-hint">Select all that apply. Full credit requires the exact set of correct choices.</p>' : ''}
      <div class="choices">
        \${question.choices.map((choice, index) => {
          const letter = question.choiceLetters[index];
          const selected = selectedLetters.includes(letter);
          const correct = correctLetters.includes(letter);
          let classes = 'choice';
          if (selected) classes += ' selected';
          if (reveal && correct) classes += ' correct';
          if (reveal && selected && !correct) classes += ' incorrect';
          if (reveal && correct && !selected) classes += ' missed-correct';
          return \`<button class="\${classes}" data-answer="\${esc(letter)}" aria-pressed="\${selected}" \${answerLocked ? 'disabled' : ''}><span class="letter">\${esc(letter)}</span><span>\${esc(choice)}</span></button>\`;
        }).join('')}
      </div>

      \${reveal ? \`
        <div class="explanation">
          <strong>\${answeredCorrectly ? 'Correct' : \`Correct answer\${correctLetters.length === 1 ? '' : 's'}: \${esc(correctLetters.join(', '))}\`}</strong>
          \${question.answerText ? \`<div class="answer-text">\${esc(question.answerText)}</div>\` : ''}
          <div>\${esc(question.explanation)}</div>
        </div>
      \` : ''}

      <div class="actions question-actions">
        <button id="flagBtn" class="secondary" type="button">\${flagged ? 'Unflag' : 'Flag'} question</button>
        \${question.isMultiSelect && activeSet.mode === 'tutor' && !activeSet.submitted && !reveal
          ? \`<button id="checkAnswerBtn" class="primary" type="button" \${hasAnswer ? '' : 'disabled'}>Check answer</button>\`
          : ''}
        \${!activeSet.submitted ? '<button id="submitBtn" class="danger" type="button">Submit set</button>' : ''}
      </div>

      <div class="question-map-legend" aria-label="Question status legend">
        <span><i class="legend-swatch answered"></i>Answered</span>
        <span><i class="legend-swatch unanswered"></i>Unanswered</span>
        <span><i class="legend-flag">★</i>Flagged</span>
      </div>

      <div class="question-map">
        \${activeSet.questionIds.map((id, index) => {
          const answeredStatus = hasQuestionAnswer(activeSet.answers.get(id)) ? 'answered' : 'unanswered';
          const flaggedStatus = progress.get(id)?.isFlagged ? ' flagged' : '';
          const currentStatus = index === activeSet.index ? ' current' : '';
          return \`<button type="button" data-index="\${index}" class="\${answeredStatus}\${flaggedStatus}\${currentStatus}" aria-label="Question \${index + 1}: \${answeredStatus}\${flaggedStatus ? ', flagged' : ''}">\${index + 1}</button>\`;
        }).join('')}
      </div>

      <div class="exam-nav">
        <button id="prevBtn" class="secondary" type="button" \${activeSet.index === 0 ? 'disabled' : ''}>Previous</button>
        <button id="exitBtn" class="secondary" type="button">\${activeSet.submitted ? 'Back to dashboard' : 'Save and exit'}</button>
        \${finalNavigation}
      </div>
    </section>
  \`;

  document.querySelectorAll('.choice').forEach((button) => {
    button.onclick = () => answerQuestion(question, button.dataset.answer);
  });

  document.getElementById('checkAnswerBtn')?.addEventListener('click', () => finalizeMultiSelectAnswer(question));

  document.getElementById('flagBtn').onclick = async () => {
    const old = progress.get(question.id);
    await updateQuestionProgress({
      bankId: activeBank.id,
      questionId: question.id,
      deviceId,
      patch: { isFlagged: !old?.isFlagged }
    });
    await renderQuestion();
  };

  document.getElementById('submitBtn')?.addEventListener('click', async () => {
    if (!submissionConfirmation()) return;
    await submitSet({ showResults: true });
  });

  document.querySelectorAll('.question-map button').forEach((button) => {
    button.onclick = async () => {
      activeSet.index = Number(button.dataset.index);
      await saveActiveSet();
      await renderQuestion();
    };
  });

  document.getElementById('prevBtn').onclick = async () => {
    activeSet.index -= 1;
    await saveActiveSet();
    await renderQuestion();
  };

  document.getElementById('nextBtn')?.addEventListener('click', async () => {
    activeSet.index += 1;
    await saveActiveSet();
    await renderQuestion();
  });

  document.getElementById('exitBtn').onclick = async () => {
    if (activeSet.submitted) {
      activeSet = null;
    } else {
      await saveActiveSet();
    }
    await renderDashboard();
  };

  document.getElementById('resultsBtn')?.addEventListener('click', renderResults);

  if (activeSet.timed && !activeSet.submitted) {
    timer = setInterval(async () => {
      activeSet.remainingSeconds = Math.max(0, activeSet.remainingSeconds - 1);
      const element = document.getElementById('timer');
      if (element) element.textContent = formatTime(activeSet.remainingSeconds);
      if (activeSet.remainingSeconds % 5 === 0) await saveActiveSet();
      if (activeSet.remainingSeconds <= 0) {
        clearInterval(timer);
        await submitSet({ auto: true, showResults: true });
      }
    }, 1000);
  }
}

`;

source = source.slice(0, renderStart) + renderQuestion + source.slice(answerStart);

const patchedAnswerStart = source.indexOf("async function answerQuestion(question, selectedAnswer) {");
const saveProgressStart = source.indexOf("async function saveProgress(question, entry) {", patchedAnswerStart);
if (patchedAnswerStart < 0 || saveProgressStart < 0) {
  throw new Error("Could not locate answerQuestion/saveProgress for multi-select compatibility.");
}

const answerFunctions = `async function persistSetAnswer(question, entry) {
  activeSet.answers.set(question.id, entry);
  await updatePracticeSetAnswer({ deviceId, record: {
    setId: activeSet.id,
    questionId: question.id,
    ...entry
  }});
}

async function answerQuestion(question, selectedAnswer) {
  if (activeSet.submitted) return;
  const existing = activeSet.answers.get(question.id);
  if (activeSet.mode === 'tutor' && existing?.finalized) return;

  const elapsed = Math.max(0, Date.now() - startedQuestionAt);
  if (question.isMultiSelect) {
    const current = selectedAnswerLetters(existing?.selectedAnswer);
    const selected = current.includes(selectedAnswer)
      ? current.filter((letter) => letter !== selectedAnswer)
      : [...current, selectedAnswer];
    const ordered = question.choiceLetters.filter((letter) => selected.includes(letter));
    const entry = {
      selectedAnswer: ordered,
      isCorrect: isQuestionAnswerCorrect(question, ordered),
      finalized: false,
      timeMs: Number(existing?.timeMs || 0) + elapsed,
      updatedAt: new Date().toISOString()
    };
    await persistSetAnswer(question, entry);
    await saveActiveSet();
    await renderQuestion();
    return;
  }

  const entry = {
    selectedAnswer,
    isCorrect: isQuestionAnswerCorrect(question, selectedAnswer),
    finalized: true,
    timeMs: Number(existing?.timeMs || 0) + elapsed,
    updatedAt: new Date().toISOString()
  };

  await persistSetAnswer(question, entry);
  if (activeSet.mode === 'tutor') await saveProgress(question, entry);
  await saveActiveSet();
  await renderQuestion();
}

async function finalizeMultiSelectAnswer(question) {
  const existing = activeSet.answers.get(question.id);
  if (!hasQuestionAnswer(existing)) return alert('Select at least one answer before checking this question.');
  if (existing.finalized) return;
  const entry = {
    ...existing,
    isCorrect: isQuestionAnswerCorrect(question, existing.selectedAnswer),
    finalized: true,
    timeMs: Number(existing.timeMs || 0) + Math.max(0, Date.now() - startedQuestionAt),
    updatedAt: new Date().toISOString()
  };
  await persistSetAnswer(question, entry);
  await saveProgress(question, entry);
  await saveActiveSet();
  await renderQuestion();
}

`;

source = source.slice(0, patchedAnswerStart) + answerFunctions + source.slice(saveProgressStart);
await writeFile(appPath, source, "utf8");
