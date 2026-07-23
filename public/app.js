import { QUESTION_BANKS } from './banks/catalog.js';
import {
  buildBankCatalog,
  chooseQuestionIds,
  eligibleQuestionIds,
  calculateSetResult,
  categoryStatistics
} from './client/study-engine.js';
import {
  STORES,
  getRecord,
  putRecord,
  recordsByIndex,
  updateQuestionProgress,
  updatePracticeSet,
  updatePracticeSetAnswer,
  createRecoverySnapshot
} from './client/storage.js';

const app = document.getElementById('app');
const homeBtn = document.getElementById('homeBtn');
const SELECTED_BANK_KEY = 'abpn-study:selected-bank';
const BUILDER_SETTINGS_PREFIX = 'abpn-study:builder-settings:';
const deviceId = localStorage.getItem('abpn-study:device-id') || crypto.randomUUID();
localStorage.setItem('abpn-study:device-id', deviceId);

let banks;
let activeBank;
let activeSet = null;
let timer = null;
let startedQuestionAt = Date.now();
let catalogRefreshInProgress = false;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const formatTime = (seconds) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(safe / 3600), Math.floor((safe % 3600) / 60), safe % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
};

const formatSeconds = (milliseconds) => {
  const seconds = Math.max(0, Number(milliseconds || 0) / 1000);
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
};

const formatDateTime = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Date unavailable';
  return new Date(value).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
};

function categoryEntries(bank) {
  const counts = new Map();
  for (const question of bank.questions) {
    counts.set(question.chapterTitle, Number(counts.get(question.chapterTitle) || 0) + 1);
  }
  return [...counts].map(([title, count]) => ({ title, count }));
}

function loadBuilderSettings(bank, categories) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(`${BUILDER_SETTINGS_PREFIX}${bank.id}`) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  } catch {
    saved = {};
  }

  const validCategories = new Set(categories);
  const selectedCategories = saved.categories == null
    ? categories
    : Array.isArray(saved.categories)
      ? saved.categories.map(String).filter((category) => validCategories.has(category))
      : categories;
  const requestedCount = Math.max(1, Math.trunc(Number(saved.count)) || Math.min(40, bank.questions.length));

  return {
    count: Math.min(requestedCount, bank.questions.length),
    mode: ['test', 'tutor'].includes(saved.mode) ? saved.mode : 'test',
    timing: ['timed', 'untimed'].includes(saved.timing) ? saved.timing : 'timed',
    pool: ['all', 'new', 'used', 'incorrect', 'flagged'].includes(saved.pool) ? saved.pool : 'all',
    categories: selectedCategories
  };
}

function selectedSubjectCategories() {
  return [...document.querySelectorAll('input[name="subjectFilter"]:checked')]
    .map((input) => input.value);
}

async function progressMap(bankId) {
  return new Map(
    (await recordsByIndex(STORES.PROGRESS, 'byBank', bankId))
      .map((record) => [record.questionId, record])
  );
}

async function hydrateStoredSet(saved) {
  if (!saved || saved.bankId !== activeBank.id) return null;
  if (!Array.isArray(saved.questionIds) || saved.questionIds.some((id) => !activeBank.byId.has(id))) {
    await putRecord(STORES.SETS, {
      ...saved,
      status: 'invalid',
      updatedAt: new Date().toISOString()
    });
    return null;
  }

  const savedAnswers = await recordsByIndex(STORES.ANSWERS, 'bySet', saved.id);
  const answers = new Map(savedAnswers.map((answer) => [answer.questionId, answer]));
  let remainingSeconds = Number(saved.remainingSeconds ?? 0);

  if (saved.status === 'active' && saved.timed && !saved.submitted && saved.updatedAt) {
    const elapsed = Math.max(
      0,
      Math.floor((Date.now() - new Date(saved.updatedAt).getTime()) / 1000)
    );
    remainingSeconds = Math.max(0, remainingSeconds - elapsed);
  }

  return {
    id: saved.id,
    bankId: saved.bankId,
    questionIds: saved.questionIds,
    index: Math.max(0, Math.min(Number(saved.index || 0), saved.questionIds.length - 1)),
    mode: saved.mode,
    timed: Boolean(saved.timed),
    remainingSeconds,
    answers,
    submitted: Boolean(saved.submitted),
    startedAt: saved.startedAt,
    completedAt: saved.completedAt ?? null
  };
}

async function loadActiveSet(bankId) {
  const candidates = (await recordsByIndex(STORES.SETS, 'byStatus', 'active'))
    .filter((record) => record.bankId === bankId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return hydrateStoredSet(candidates[0]);
}

async function completedSetHistory(bankId) {
  const records = (await recordsByIndex(STORES.SETS, 'byBank', bankId))
    .filter((record) => record.status === 'completed' && record.submitted)
    .sort((a, b) => String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt)));

  return Promise.all(records.map(async (record) => {
    const answers = new Map(
      (await recordsByIndex(STORES.ANSWERS, 'bySet', record.id))
        .map((answer) => [answer.questionId, answer])
    );
    const result = calculateSetResult(record.questionIds, answers, activeBank);
    const totalTimeMs = [...answers.values()]
      .reduce((total, answer) => total + Math.max(0, Number(answer.timeMs || 0)), 0);
    return {
      record,
      result,
      percentage: result.total ? Math.round(result.correct / result.total * 100) : 0,
      averageTimeMs: result.answered ? totalTimeMs / result.answered : 0
    };
  }));
}

async function initialize() {
  try {
    banks = buildBankCatalog(QUESTION_BANKS);
    for (const bank of banks) {
      await putRecord(STORES.BANKS, {
        id: bank.id,
        title: bank.title,
        version: bank.version,
        questionCount: bank.questions.length,
        updatedAt: new Date().toISOString()
      });
    }

    const selected = localStorage.getItem(SELECTED_BANK_KEY);
    activeBank = banks.find((bank) => bank.id === selected)
      || banks.find((bank) => bank.id === 'ks-psychiatry-core')
      || banks[0];

    activeSet = await loadActiveSet(activeBank.id);
    if (activeSet?.timed && !activeSet.submitted && activeSet.remainingSeconds <= 0) {
      await submitSet({ auto: true, showResults: true });
    } else {
      await renderDashboard();
    }
  } catch (error) {
    app.innerHTML = `<section class="card"><h2>Application could not start</h2><p class="notice">${esc(error.message)}</p></section>`;
  }
}

async function refreshCatalog() {
  if (catalogRefreshInProgress || activeSet) return;
  catalogRefreshInProgress = true;
  try {
    await initialize();
  } finally {
    catalogRefreshInProgress = false;
  }
}

async function selectBank(bankId) {
  activeBank = banks.find((bank) => bank.id === bankId) || activeBank;
  localStorage.setItem(SELECTED_BANK_KEY, activeBank.id);
  activeSet = await loadActiveSet(activeBank.id);
  await renderDashboard();
}

function historyMarkup(history) {
  if (!history.length) {
    return '<div class="empty">Completed tests will appear here with their score, timing, and review link.</div>';
  }

  return `<div class="history-list">${history.map(({ record, result, percentage, averageTimeMs }) => `
    <article class="history-item">
      <div class="history-score" aria-label="${percentage}% correct">
        <strong>${percentage}%</strong>
        <span>${result.correct}/${result.total}</span>
      </div>
      <div class="history-details">
        <strong>${esc(record.name || `${activeBank.shortTitle} practice set`)}</strong>
        <span>${formatDateTime(record.completedAt || record.updatedAt)} · ${record.mode === 'tutor' ? 'Tutor' : 'Test'} · ${record.timed ? 'Timed' : 'Untimed'}</span>
        <span>${result.answered} answered · ${result.omitted} omitted · ${formatSeconds(averageTimeMs)} average</span>
      </div>
      <div class="history-actions">
        <button type="button" class="secondary" data-open-set="${esc(record.id)}">Review</button>
      </div>
    </article>
  `).join('')}</div>`;
}

async function renderDashboard() {
  clearInterval(timer);
  homeBtn.hidden = true;
  const progress = await progressMap(activeBank.id);
  const history = await completedSetHistory(activeBank.id);
  const categories = categoryEntries(activeBank);
  const categoryNames = categories.map((category) => category.title);
  const settings = loadBuilderSettings(activeBank, categoryNames);
  const answered = [...progress.values()].filter((entry) => Number(entry.timesUsed || 0) > 0).length;
  const correct = [...progress.values()].filter((entry) => Number(entry.timesUsed || 0) > 0 && entry.isCorrect === true).length;
  const totalTimeMs = [...progress.values()].reduce((total, entry) => total + Math.max(0, Number(entry.totalTimeMs || 0)), 0);
  const totalUses = [...progress.values()].reduce((total, entry) => total + Math.max(0, Number(entry.timesUsed || 0)), 0);
  const categoryStats = categoryStatistics(activeBank, progress);

  app.innerHTML = `
    <section class="card">
      <div class="deck-header">
        <div>
          <div class="eyebrow" style="color:var(--blue)">QUESTION BANK</div>
          <h2>${esc(activeBank.title)}</h2>
          <p class="muted">${esc(activeBank.description || '')}</p>
        </div>
        <label class="deck-picker">Deck
          <select id="bankSelect">
            ${banks.map((bank) => `<option value="${esc(bank.id)}" ${bank.id === activeBank.id ? 'selected' : ''}>${esc(bank.shortTitle)} · ${bank.questions.length}</option>`).join('')}
          </select>
        </label>
      </div>

      <div class="stats-grid">
        <div class="stat"><strong>${activeBank.questions.length}</strong><span>Total questions</span></div>
        <div class="stat"><strong>${answered}</strong><span>Used questions</span></div>
        <div class="stat"><strong>${answered ? Math.round(correct / answered * 100) : 0}%</strong><span>Latest accuracy</span></div>
        <div class="stat"><strong>${totalUses ? formatSeconds(totalTimeMs / totalUses) : '—'}</strong><span>Average time/question</span></div>
      </div>

      <div class="dashboard-actions">
        <button id="importBankBtn" class="secondary" type="button">Import from file</button>
      </div>

      <form id="builderForm" class="builder-card">
        <div class="builder-heading">
          <div>
            <div class="eyebrow" style="color:var(--blue)">CREATE A NEW PRACTICE SET</div>
            <h3>Build your next set</h3>
          </div>
          <span class="muted">Settings save automatically for this deck.</span>
        </div>

        <div class="builder-grid">
          <label>Questions
            <input id="questionCount" type="number" min="1" max="${activeBank.questions.length}" value="${settings.count}">
          </label>
          <label>Mode
            <select id="modeSelect">
              <option value="test" ${settings.mode === 'test' ? 'selected' : ''}>Test</option>
              <option value="tutor" ${settings.mode === 'tutor' ? 'selected' : ''}>Tutor</option>
            </select>
          </label>
          <label>Timing
            <select id="timingSelect">
              <option value="timed" ${settings.timing === 'timed' ? 'selected' : ''}>Timed</option>
              <option value="untimed" ${settings.timing === 'untimed' ? 'selected' : ''}>Untimed</option>
            </select>
          </label>
          <label>Status
            <select id="poolSelect">
              <option value="all" ${settings.pool === 'all' ? 'selected' : ''}>All questions</option>
              <option value="new" ${settings.pool === 'new' ? 'selected' : ''}>New</option>
              <option value="used" ${settings.pool === 'used' ? 'selected' : ''}>Used</option>
              <option value="incorrect" ${settings.pool === 'incorrect' ? 'selected' : ''}>Incorrect</option>
              <option value="flagged" ${settings.pool === 'flagged' ? 'selected' : ''}>Flagged</option>
            </select>
          </label>
        </div>

        <fieldset class="subject-filter">
          <legend>Subjects</legend>
          <div class="subject-actions">
            <button id="allSubjectsBtn" type="button" class="ghost">All subjects</button>
            <button id="clearSubjectsBtn" type="button" class="ghost">Clear</button>
          </div>
          <div class="subject-grid">
            ${categories.map(({ title, count }) => `
              <label><input type="checkbox" name="subjectFilter" value="${esc(title)}" ${settings.categories.includes(title) ? 'checked' : ''}> <span>${esc(title)}</span><small>${count}</small></label>
            `).join('')}
          </div>
        </fieldset>

        <div class="actions">
          <button class="primary" type="submit">Start practice set</button>
        </div>
      </form>

      <section class="dashboard-section">
        <div class="section-heading">
          <div>
            <div class="eyebrow" style="color:var(--blue)">HISTORY / PREVIOUS TESTS</div>
            <h3>Completed sets</h3>
          </div>
        </div>
        ${historyMarkup(history)}
      </section>

      <section class="dashboard-section">
        <div class="section-heading">
          <div>
            <div class="eyebrow" style="color:var(--blue)">ANALYTICS / PERFORMANCE BY CATEGORY</div>
            <h3>Subject performance</h3>
          </div>
        </div>
        <div class="analytics-table">
          ${categoryStats.map((entry) => `
            <div class="analytics-row">
              <span>${esc(entry.category)}</span>
              <span>${entry.used}/${entry.total} used</span>
              <span>${entry.used ? Math.round(entry.correct / entry.used * 100) : 0}%</span>
            </div>
          `).join('')}
        </div>
      </section>
    </section>
  `;

  document.getElementById('bankSelect').onchange = (event) => selectBank(event.target.value);
  document.getElementById('builderForm').onsubmit = startSet;
  document.getElementById('allSubjectsBtn').onclick = () => {
    document.querySelectorAll('input[name="subjectFilter"]').forEach((input) => { input.checked = true; });
    saveBuilderSettings();
  };
  document.getElementById('clearSubjectsBtn').onclick = () => {
    document.querySelectorAll('input[name="subjectFilter"]').forEach((input) => { input.checked = false; });
    saveBuilderSettings();
  };
  document.querySelectorAll('#builderForm input, #builderForm select').forEach((control) => {
    control.addEventListener('change', saveBuilderSettings);
  });
  document.querySelectorAll('[data-open-set]').forEach((button) => {
    button.onclick = () => openCompletedSet(button.dataset.openSet);
  });
}

function saveBuilderSettings() {
  if (!activeBank) return;
  const categories = selectedSubjectCategories();
  localStorage.setItem(`${BUILDER_SETTINGS_PREFIX}${activeBank.id}`, JSON.stringify({
    count: Math.max(1, Math.trunc(Number(document.getElementById('questionCount')?.value || 1))),
    mode: document.getElementById('modeSelect')?.value || 'test',
    timing: document.getElementById('timingSelect')?.value || 'timed',
    pool: document.getElementById('poolSelect')?.value || 'all',
    categories
  }));
}

async function startSet(event) {
  event.preventDefault();
  const count = Math.max(1, Math.trunc(Number(document.getElementById('questionCount').value)) || 1);
  const mode = document.getElementById('modeSelect').value;
  const timed = document.getElementById('timingSelect').value === 'timed';
  const pool = document.getElementById('poolSelect').value;
  const selectedCategories = selectedSubjectCategories();
  saveBuilderSettings();

  const progress = await progressMap(activeBank.id);
  const eligible = eligibleQuestionIds(activeBank, progress, {
    pool,
    categories: selectedCategories
  });

  if (!eligible.length) {
    alert('No questions match those settings. Choose more subjects or another question status.');
    return;
  }

  const questionIds = chooseQuestionIds(eligible, Math.min(count, eligible.length));
  const startedAt = new Date().toISOString();
  activeSet = {
    id: crypto.randomUUID(),
    bankId: activeBank.id,
    questionIds,
    index: 0,
    mode,
    timed,
    remainingSeconds: timed ? questionIds.length * 90 : 0,
    answers: new Map(),
    submitted: false,
    startedAt,
    completedAt: null
  };

  await updatePracticeSet({ deviceId, record: {
    id: activeSet.id,
    bankId: activeSet.bankId,
    name: `${activeBank.shortTitle} ${mode === 'tutor' ? 'Tutor' : 'Test'} set`,
    mode,
    timed,
    status: 'active',
    startedAt,
    completedAt: null,
    remainingSeconds: activeSet.remainingSeconds,
    index: activeSet.index,
    questionIds,
    submitted: false
  }});
  await createRecoverySnapshot('practice-set-started');
  homeBtn.hidden = false;
  await renderQuestion();
}

function submissionConfirmation() {
  const unanswered = activeSet.questionIds.length - activeSet.answers.size;
  const wording = unanswered > 0
    ? `Submit this set now? ${unanswered} question${unanswered === 1 ? '' : 's'} will be left unanswered.`
    : 'Submit this set now?';
  return confirm(wording);
}

async function saveActiveSet(status = activeSet.submitted ? 'completed' : 'active') {
  await updatePracticeSet({ deviceId, record: {
    id: activeSet.id,
    bankId: activeSet.bankId,
    name: `${activeBank.shortTitle} ${activeSet.mode === 'tutor' ? 'Tutor' : 'Test'} set`,
    mode: activeSet.mode,
    timed: activeSet.timed,
    status,
    startedAt: activeSet.startedAt,
    completedAt: activeSet.completedAt,
    remainingSeconds: activeSet.remainingSeconds,
    index: activeSet.index,
    questionIds: activeSet.questionIds,
    submitted: activeSet.submitted
  }});
}

async function renderQuestion() {
  clearInterval(timer);
  homeBtn.hidden = false;
  const question = activeBank.byId.get(activeSet.questionIds[activeSet.index]);
  if (!question) {
    activeSet = null;
    return renderDashboard();
  }

  const answer = activeSet.answers.get(question.id);
  const reveal = activeSet.submitted || (activeSet.mode === 'tutor' && answer);
  const progress = await progressMap(activeBank.id);
  const flagged = progress.get(question.id)?.isFlagged;
  const isLastQuestion = activeSet.index === activeSet.questionIds.length - 1;
  const answeredCount = activeSet.answers.size;
  const unansweredCount = Math.max(0, activeSet.questionIds.length - answeredCount);
  const finalNavigation = activeSet.submitted && isLastQuestion
    ? '<button id="resultsBtn" class="primary" type="button">View results</button>'
    : `<button id="nextBtn" class="primary" type="button" ${isLastQuestion ? 'disabled' : ''}>Next</button>`;
  const answerLocked = activeSet.submitted || (activeSet.mode === 'tutor' && Boolean(answer));

  startedQuestionAt = Date.now();

  app.innerHTML = `
    <section class="card exam">
      <div class="exam-head">
        <div>
          <div class="eyebrow" style="color:var(--blue)">${esc(activeBank.shortTitle)}</div>
          <h2>Question ${activeSet.index + 1} of ${activeSet.questionIds.length}</h2>
          <div class="question-status-row">
            <span class="question-state ${answer ? 'answered' : 'unanswered'}">${answer ? 'Answered' : 'Unanswered'}</span>
            <span class="muted">${answeredCount} answered · ${unansweredCount} unanswered</span>
          </div>
        </div>
        <div id="timer" class="timer">${activeSet.timed ? formatTime(activeSet.remainingSeconds) : 'Untimed'}</div>
      </div>

      <div class="progress"><span style="width:${(activeSet.index + 1) / activeSet.questionIds.length * 100}%"></span></div>
      <div class="question">${esc(question.question)}</div>
      <div class="choices">
        ${question.choices.map((choice, index) => {
          const letter = question.choiceLetters[index];
          let classes = 'choice';
          if (answer?.selectedAnswer === letter) classes += ' selected';
          if (reveal && letter === question.correctLetter) classes += ' correct';
          if (reveal && answer?.selectedAnswer === letter && letter !== question.correctLetter) classes += ' incorrect';
          return `<button class="${classes}" data-answer="${esc(letter)}" ${answerLocked ? 'disabled' : ''}><span class="letter">${esc(letter)}</span><span>${esc(choice)}</span></button>`;
        }).join('')}
      </div>

      ${reveal ? `
        <div class="explanation">
          <strong>${answer?.selectedAnswer === question.correctLetter ? 'Correct' : `Correct answer: ${esc(question.correctLetter)}`}</strong>
          <div>${esc(question.explanation)}</div>
        </div>
      ` : ''}

      <div class="actions question-actions">
        <button id="flagBtn" class="secondary" type="button">${flagged ? 'Unflag' : 'Flag'} question</button>
        ${!activeSet.submitted ? '<button id="submitBtn" class="danger" type="button">Submit set</button>' : ''}
      </div>

      <div class="question-map-legend" aria-label="Question status legend">
        <span><i class="legend-swatch answered"></i>Answered</span>
        <span><i class="legend-swatch unanswered"></i>Unanswered</span>
        <span><i class="legend-flag">★</i>Flagged</span>
      </div>

      <div class="question-map">
        ${activeSet.questionIds.map((id, index) => {
          const answeredStatus = activeSet.answers.has(id) ? 'answered' : 'unanswered';
          const flaggedStatus = progress.get(id)?.isFlagged ? ' flagged' : '';
          const currentStatus = index === activeSet.index ? ' current' : '';
          return `<button type="button" data-index="${index}" class="${answeredStatus}${flaggedStatus}${currentStatus}" aria-label="Question ${index + 1}: ${answeredStatus}${flaggedStatus ? ', flagged' : ''}">${index + 1}</button>`;
        }).join('')}
      </div>

      <div class="exam-nav">
        <button id="prevBtn" class="secondary" type="button" ${activeSet.index === 0 ? 'disabled' : ''}>Previous</button>
        <button id="exitBtn" class="secondary" type="button">${activeSet.submitted ? 'Back to dashboard' : 'Save and exit'}</button>
        ${finalNavigation}
      </div>
    </section>
  `;

  document.querySelectorAll('.choice').forEach((button) => {
    button.onclick = () => answerQuestion(question, button.dataset.answer);
  });

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

async function answerQuestion(question, selectedAnswer) {
  if (activeSet.submitted) return;
  const existing = activeSet.answers.get(question.id);
  if (activeSet.mode === 'tutor' && existing) return;

  const entry = {
    selectedAnswer,
    isCorrect: selectedAnswer === question.correctLetter,
    timeMs: Math.max(0, Date.now() - startedQuestionAt),
    updatedAt: new Date().toISOString()
  };

  activeSet.answers.set(question.id, entry);
  await updatePracticeSetAnswer({ deviceId, record: {
    setId: activeSet.id,
    questionId: question.id,
    ...entry
  }});

  if (activeSet.mode === 'tutor') await saveProgress(question, entry);
  await saveActiveSet();
  await renderQuestion();
}

async function saveProgress(question, entry) {
  const current = (await progressMap(activeBank.id)).get(question.id);
  await updateQuestionProgress({
    bankId: activeBank.id,
    questionId: question.id,
    deviceId,
    patch: {
      selectedAnswer: entry.selectedAnswer,
      isCorrect: entry.isCorrect,
      timesUsed: Number(current?.timesUsed || 0) + 1,
      totalTimeMs: Number(current?.totalTimeMs || 0) + Number(entry.timeMs || 0),
      lastUsedAt: new Date().toISOString()
    }
  });
}

async function submitSet({ auto = false, showResults = true } = {}) {
  if (!activeSet || activeSet.submitted) return;

  activeSet.submitted = true;
  activeSet.completedAt = new Date().toISOString();

  if (activeSet.mode === 'test') {
    for (const id of activeSet.questionIds) {
      const entry = activeSet.answers.get(id);
      if (entry) await saveProgress(activeBank.byId.get(id), entry);
    }
  }

  await saveActiveSet('completed');

  if (auto) alert('Time expired. The set was submitted.');
  if (showResults) renderResults();
  else await renderQuestion();
}

function renderResults() {
  clearInterval(timer);
  const result = calculateSetResult(activeSet.questionIds, activeSet.answers, activeBank);
  const percentage = result.total ? Math.round(result.correct / result.total * 100) : 0;
  const totalTimeMs = [...activeSet.answers.values()]
    .reduce((total, answer) => total + Math.max(0, Number(answer.timeMs || 0)), 0);
  const averageTimeMs = result.answered ? totalTimeMs / result.answered : 0;

  app.innerHTML = `
    <section class="card results-card">
      <div class="eyebrow" style="color:var(--blue)">SET RESULTS</div>
      <h2>${result.correct}/${result.total} correct (${percentage}%)</h2>
      <p class="muted">${result.answered} answered · ${result.omitted} omitted · ${result.incorrect} incorrect</p>
      <div class="result-stats">
        <div class="stat"><strong>${percentage}%</strong><span>Score</span></div>
        <div class="stat"><strong>${result.omitted}</strong><span>Omitted</span></div>
        <div class="stat"><strong>${result.answered ? formatSeconds(averageTimeMs) : '—'}</strong><span>Average time/question</span></div>
      </div>
      <p class="notice">This completed test is saved locally in History / Previous tests and can be reviewed again later.</p>
      <div class="actions">
        <button id="reviewBtn" class="secondary" type="button">Review questions</button>
        <button id="finishBtn" class="primary" type="button">Back to dashboard</button>
      </div>
    </section>
  `;

  document.getElementById('reviewBtn').onclick = async () => {
    activeSet.index = 0;
    await saveActiveSet('completed');
    await renderQuestion();
  };

  document.getElementById('finishBtn').onclick = async () => {
    activeSet = null;
    await renderDashboard();
  };
}

async function openCompletedSet(setId) {
  const saved = await getRecord(STORES.SETS, setId);
  if (!saved || saved.bankId !== activeBank.id || saved.status !== 'completed') {
    alert('That completed test could not be found for the selected question bank.');
    return;
  }

  const hydrated = await hydrateStoredSet(saved);
  if (!hydrated) {
    alert('That completed test contains question references that are no longer available.');
    return;
  }

  activeSet = hydrated;
  activeSet.submitted = true;
  renderResults();
}

homeBtn.onclick = async () => {
  if (activeSet && !activeSet.submitted) await saveActiveSet();
  if (activeSet?.submitted) activeSet = null;
  await renderDashboard();
};

window.addEventListener('beforeunload', () => {
  if (activeSet && !activeSet.submitted) void saveActiveSet();
});

window.addEventListener('abpn:deck-catalog-updated', () => {
  void refreshCatalog();
});

initialize();
