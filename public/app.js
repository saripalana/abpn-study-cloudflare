import { QUESTION_BANKS } from './banks/catalog.js';
import { isUserSelectableDeck, practiceSetDeckLabel, resolveUserActiveDeck } from './client/deck-display.js';

// ABPN_USER_FACING_DECKS_PATCH_V1
import {
  buildBankCatalog,
  chooseQuestionIds,
  eligibleQuestionIds,
  calculateSetResult,
  categoryStatistics,
  subjectStatistics,
  hasQuestionAnswer,
  isQuestionAnswerCorrect,
  selectedAnswerLetters
} from './client/study-engine.js';
import { bindMultiDeckSelector, multiDeckSelectorMarkup } from './client/multi-deck-builder-ui.js';
import { DECK_SCOPE_CURRENT, normalizeDeckScopeSettings } from './client/multi-deck-builder.js';
import { createPracticeSession, persistenceRecordForSession, sessionQuestionContext } from './client/multi-deck-app-session.js';
import { normalizeStoredSet } from './client/multi-deck-set.js';
import { setQuestionItems } from './client/multi-deck-runtime.js';
import { calculateSessionResult, progressEntriesForSession, totalAnswerTimeMs } from './client/multi-deck-results.js';

// ABPN_MULTI_DECK_RUNTIME_APP_PATCH_V1
// ABPN_MULTI_DECK_RESULTS_CORRECTNESS_PATCH_V1
import { categoriesByDeckForSession } from './client/multi-deck-app-session.js';

// ABPN_MULTI_DECK_SESSION_APP_PATCH_V1

// ABPN_MULTI_DECK_BUILDER_UI_PATCH_V1

// ABPN_MULTI_SELECT_PATCH_V1
import { buildWeaknessSnapshot } from './client/weakness-analytics.js';
import { attachAssistantWeaknessControls, scheduleStudyCoachRefresh } from './assistant-weakness-controller.js';
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
const MULTI_DECK_BUILDER_KEY = 'abpn-study:multi-deck-builder';
const deviceId = localStorage.getItem('abpn-study:device-id') || crypto.randomUUID();
localStorage.setItem('abpn-study:device-id', deviceId);

let banks;
let activeBank;
let allowSystemValidation = false;
let activeSet = null;
// Review filters are deliberately transient. They change only the review UI and
// are never written into the saved test, question bank, or progress records.
let reviewQuestionIndexes = null;
let timer = null;
let startedQuestionAt = Date.now();

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
    const subject = question.subjectTitle || question.chapterTitle || 'Uncategorized';
    counts.set(subject, Number(counts.get(subject) || 0) + 1);
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
    randomized: typeof saved.randomized === 'boolean' ? saved.randomized : saved.pool == null || saved.pool === 'all',
    categories: selectedCategories
  };
}

function loadMultiDeckBuilderSettings(activeBankId) {
  let saved = { scope: DECK_SCOPE_CURRENT, selectedBankIds: [activeBankId] };
  try {
    const parsed = JSON.parse(localStorage.getItem(MULTI_DECK_BUILDER_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch {
    // Invalid local settings fall back to the current deck.
  }
  return normalizeDeckScopeSettings({ decks: banks, activeBankId, saved });
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

async function loadActiveSet(bankId) {
  const candidates = (await recordsByIndex(STORES.SETS, 'byStatus', 'active'))
    .filter((record) => record.bankId === bankId || record.selectedBankIds?.includes?.(bankId))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return hydrateStoredSet(candidates[0]);
}

async function completedSetHistory(bankId) {
  const records = (await recordsByIndex(STORES.SETS, 'byStatus', 'completed'))
    .filter((record) => record.submitted && (record.bankId === bankId || record.selectedBankIds?.includes?.(bankId)))
    .sort((a, b) => String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt)));

  return Promise.all(records.map(async (record) => {
    const normalized = normalizeStoredSet(record, banks);
    if (!normalized) return null;
    const answers = new Map((await recordsByIndex(STORES.ANSWERS, 'bySet', record.id)).map((answer) => [answer.questionId, answer]));
    const result = calculateSessionResult(banks, normalized, answers, { hasAnswer: hasQuestionAnswer });
    const totalTimeMs = totalAnswerTimeMs(answers);
    return {
      record,
      result,
      percentage: result.total ? Math.round(result.correct / result.total * 100) : 0,
      averageTimeMs: result.answered ? totalTimeMs / result.answered : 0,
    };
  })).then((items) => items.filter(Boolean));
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
    // Internal fixtures may be selected only from the local browser harness.
    // Native select menus do not consistently honor hidden <option> elements,
    // so remote staging and production omit the fixture from the DOM entirely.
    const localValidationHarness = ['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname);
    allowSystemValidation = localValidationHarness;
    activeBank = resolveUserActiveDeck(banks, selected, 'ks-psychiatry-core', allowSystemValidation);
    if (!activeBank) throw new Error('No normal study decks are available.');
    localStorage.setItem(SELECTED_BANK_KEY, activeBank.id);

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
        <div class="history-title">
          <strong>${record.mode === 'tutor' ? 'Tutor' : 'Test'} set · ${record.questionIds.length} questions</strong>
          <span class="pill good">Completed</span>
        </div>
        <small><strong>Decks:</strong> ${esc(practiceSetDeckLabel(banks, record))}</small>
        <small>${formatDateTime(record.completedAt || record.updatedAt)} · ${record.timed ? 'Timed' : 'Untimed'}</small>
        <small>${result.answered} answered · ${result.omitted} omitted · ${result.incorrect} incorrect · ${formatSeconds(averageTimeMs)} average/question</small>
      </div>
      <button class="secondary review-history-btn" type="button" data-set-id="${esc(record.id)}">Review test</button>
    </article>
  `).join('')}</div>`;
}

async function renderDashboard() {
  clearInterval(timer);
  homeBtn.hidden = true;

  const progress = await progressMap(activeBank.id);
  const usedRecords = [...progress.values()].filter((record) => Number(record.timesUsed || 0) > 0);
  const answered = usedRecords.length;
  const correct = usedRecords.filter((record) => record.isCorrect === true).length;
  const flagged = [...progress.values()].filter((record) => record.isFlagged).length;
  const attempts = usedRecords.reduce((total, record) => total + Number(record.timesUsed || 0), 0);
  const totalTimeMs = usedRecords.reduce((total, record) => total + Number(record.totalTimeMs || 0), 0);
  const averageTimeMs = attempts ? totalTimeMs / attempts : 0;
  const subjectRows = subjectStatistics(activeBank, progress).filter((row) => row.answered);
  const sectionRows = categoryStatistics(activeBank, progress).filter((row) => row.answered);
  const weakness = buildWeaknessSnapshot(activeBank, progress);
  const weaknessRows = weakness.domains.filter((domain) => domain.usedQuestions > 0);
  const history = await completedSetHistory(activeBank.id);
  const resumable = activeSet && !activeSet.submitted && (activeSet.bankId === activeBank.id || activeSet.selectedBankIds?.includes?.(activeBank.id));
  const categories = categoryEntries(activeBank);
  const builder = loadBuilderSettings(activeBank, categories.map((category) => category.title));
  const multiDeckBuilder = loadMultiDeckBuilderSettings(activeBank.id);
  const installedDeckCount = banks.filter(isUserSelectableDeck).length;
  const questionBrowserRows = activeBank.questions.map((question, index) => {
    const record = progress.get(question.id);
    const used = Number(record?.timesUsed || 0) > 0;
    const status = !used ? 'New' : record?.isCorrect === true ? 'Correct' : record?.isCorrect === false ? 'Wrong' : 'Unanswered';
    const preview = question.vignetteStem || question.question;
    const subject = question.subjectTitle || question.chapterTitle || 'Uncategorized';
    return `<button class="question-browser-number ${status.toLowerCase()}" type="button" aria-label="Question ${index + 1}, ${status}. Double-click to open." title="${esc(subject)} · ${status}" data-question-id="${esc(question.id)}" data-search="${esc(`${index + 1} ${subject} ${preview} ${status}`.toLowerCase())}">${index + 1}</button>`;
  }).join('');

  // Rendered controllers use this state marker instead of coupling data
  // operations to a redundant visible deck selector.
  app.dataset.activeBankId = activeBank.id;
  app.dataset.activeBankLabel = activeBank.title;
  app.innerHTML = `
    <section class="card hero">
      <div>
        <div class="eyebrow" style="color:var(--blue)">DECK LIBRARY · ${installedDeckCount} INSTALLED</div>
        <h2>${esc(activeBank.title)}</h2>
        <p class="muted">${esc(activeBank.description)} ${activeBank.questions.length} questions loaded.</p>
        <p class="deck-library-contract">Every installed question bank uses the same versioned storage, protection, backup, study, and analytics system.</p>
      </div>
    </section>

    <section class="stats">
      <div class="stat"><strong>${activeBank.questions.length}</strong><span>Total questions</span></div>
      <div class="stat"><strong>${answered}</strong><span>Used</span></div>
      <div class="stat"><strong>${correct}</strong><span>Currently correct</span></div>
      <div class="stat"><strong>${flagged}</strong><span>Flagged</span></div>
      <div class="stat"><strong>${history.length}</strong><span>Completed tests</span></div>
      <div class="stat"><strong>${attempts ? formatSeconds(averageTimeMs) : '—'}</strong><span>Average time/question</span></div>
    </section>

    ${resumable ? `
      <section class="card">
        <h3>Resume active set</h3>
        <p class="muted">${activeSet.questionIds.length} questions · ${esc(activeSet.mode)} mode${activeSet.timed ? ` · ${formatTime(activeSet.remainingSeconds)} remaining` : ''}</p>
        <div class="actions"><button id="resumeBtn" class="primary" type="button">Resume set</button></div>
      </section>
    ` : ''}

    <section class="grid">
      <div class="stack">
        <section class="card">
          <h3>Create practice set</h3>
          ${multiDeckSelectorMarkup({ decks: banks, activeBankId: activeBank.id, settings: multiDeckBuilder })}
          <div class="form-grid">
            <div class="field">
              <label for="countInput">Questions</label>
              <input id="countInput" type="number" min="1" max="${activeBank.questions.length}" value="${builder.count}">
            </div>
            <div class="field">
              <label for="modeSelect">Mode</label>
              <select id="modeSelect"><option value="test" ${builder.mode === 'test' ? 'selected' : ''}>Test</option><option value="tutor" ${builder.mode === 'tutor' ? 'selected' : ''}>Tutor</option></select>
            </div>
            <div class="field">
              <label for="timingSelect">Timing</label>
              <select id="timingSelect"><option value="timed" ${builder.timing === 'timed' ? 'selected' : ''}>Timed at 70.6 sec/question</option><option value="untimed" ${builder.timing === 'untimed' ? 'selected' : ''}>Untimed</option></select>
            </div>
            <div class="field">
              <label for="poolSelect">Question status</label>
              <select id="poolSelect">
                <option value="all" ${builder.pool === 'all' ? 'selected' : ''}>All / Random</option>
                <option value="new" ${builder.pool === 'new' ? 'selected' : ''}>New</option>
                <option value="used" ${builder.pool === 'used' ? 'selected' : ''}>Used</option>
                <option value="incorrect" ${builder.pool === 'incorrect' ? 'selected' : ''}>Wrong</option>
                <option value="flagged" ${builder.pool === 'flagged' ? 'selected' : ''}>Flagged</option>
              </select>
            </div>
            <label class="subject-option" for="randomizeOrder">
              <input id="randomizeOrder" type="checkbox" ${builder.randomized ? 'checked' : ''}>
              <span><strong>Randomize question order</strong><small>Turn off to follow the source order. The All pool defaults to randomized.</small></span>
            </label>
          </div>
          <details id="subjectPicker" class="subject-picker">
            <summary>
              <span>Subjects</span>
              <span id="subjectSummary" class="subject-summary"></span>
            </summary>
            <div class="subject-picker-body">
              <div class="subject-toolbar">
                <button id="selectAllSubjectsBtn" class="secondary" type="button">Select all</button>
                <button id="clearSubjectsBtn" class="secondary" type="button">Clear</button>
              </div>
              <div class="subject-options">
                ${categories.map((category, index) => `
                  <label class="subject-option" for="subject-${index}">
                    <input id="subject-${index}" name="subjectFilter" type="checkbox" value="${esc(category.title)}" ${builder.categories.includes(category.title) ? 'checked' : ''}>
                    <span>${esc(category.title)}</span>
                    <small>${category.count}</small>
                  </label>
                `).join('')}
              </div>
            </div>
          </details>
          <p id="eligibleCount" class="builder-availability"></p>
          <div class="actions"><button id="startBtn" class="primary" type="button">Start set</button></div>
        </section>
      </div>

      <div class="stack">
        <section class="card question-browser-card">
          <div class="section-heading">
            <div>
              <div class="eyebrow" style="color:var(--blue)">QUESTION NAVIGATOR</div>
              <h3>Browse questions</h3>
              <p class="muted">Double-click a number to open it without revealing the answer. Linked follow-ups open together.</p>
            </div>
            <span class="pill">${activeBank.questions.length}</span>
          </div>
          <label class="field" for="questionBrowserSearch">
            <span>Find by number, subject, or text</span>
            <input id="questionBrowserSearch" type="search" placeholder="Search questions">
          </label>
          <div class="question-browser-legend" aria-label="Question status legend"><span><i class="correct"></i>Correct</span><span><i class="wrong"></i>Wrong</span><span><i class="unanswered"></i>Unanswered</span><span><i class="new"></i>New</span></div>
          <div id="questionBrowserList" class="question-browser-list">${questionBrowserRows}</div>
          <p id="questionBrowserEmpty" class="empty" hidden>No questions match this search.</p>
        </section>
      </div>
    </section>

    <section id="historySection" class="card dashboard-section">
      <div class="section-heading">
        <div>
          <div class="eyebrow" style="color:var(--blue)">SAVED LOCALLY</div>
          <h3>History / Previous tests</h3>
        </div>
        <span class="pill">${history.length} completed</span>
      </div>
      ${historyMarkup(history)}
    </section>

    <section id="analyticsSection" class="card dashboard-section">
      <div class="section-heading">
        <div>
          <div class="eyebrow" style="color:var(--blue)">ANALYTICS</div>
          <h3>Performance by subject</h3>
        </div>
      </div>
      ${subjectRows.length ? `
        <table class="summary-table">
          <thead><tr><th>Subject</th><th>Used</th><th>Accuracy</th></tr></thead>
          <tbody>${subjectRows.map((row) => `<tr><td>${esc(row.title)}</td><td>${row.answered}/${row.total}</td><td>${Math.round(row.accuracy * 100)}%</td></tr>`).join('')}</tbody>
        </table>
      ` : '<div class="empty">Complete questions to build analytics.</div>'}
      <div class="section-heading analytics-subsection">
        <div>
          <div class="eyebrow" style="color:var(--blue)">SOURCE VIEW</div>
          <h3>Performance by test section</h3>
        </div>
      </div>
      ${sectionRows.length ? `
        <table class="summary-table">
          <thead><tr><th>Test section</th><th>Used</th><th>Accuracy</th></tr></thead>
          <tbody>${sectionRows.map((row) => `<tr><td>${esc(row.title)}</td><td>${row.answered}/${row.total}</td><td>${Math.round(row.accuracy * 100)}%</td></tr>`).join('')}</tbody>
        </table>
      ` : '<div class="empty">Complete questions to build test-section analytics.</div>'}
      <div class="section-heading analytics-subsection">
        <div>
          <div class="eyebrow" style="color:var(--blue)">LOCAL-ONLY · LIMITED EVIDENCE</div>
          <h3>Weakness priorities</h3>
          <p class="muted">A planning aid based on current correctness, recent use, and time. It is not attempt history or a prediction.</p>
        </div>
        <span class="pill">${Math.round((weakness.masteryCoverage || 0) * 100)}% mastery coverage</span>
      </div>
      ${weaknessRows.length ? `
        <table class="summary-table">
          <thead><tr><th>Domain</th><th>Priority</th><th>Evidence</th></tr></thead>
          <tbody>${weaknessRows.map((domain) => `<tr><td>${esc(domain.title)}</td><td>${domain.priorityScore}/100</td><td>${esc(domain.evidence)} · ${domain.usedQuestions}/${domain.totalQuestions} used</td></tr>`).join('')}</tbody>
        </table>
        <p class="muted">Adequate evidence in ${Math.round((weakness.evidenceCoverage || 0) * 100)}% of domains. More completed questions improve reliability.</p>
      ` : '<div class="empty">Complete questions to build local weakness priorities.</div>'}
    </section>

    <section id="studyCoachSection" class="card dashboard-section">
      <div class="section-heading">
        <div>
          <div class="eyebrow" style="color:var(--blue)">PRIVATE STAGING · OPTIONAL</div>
          <h3>Study Coach access</h3>
          <p class="muted">While enabled, coaching data refreshes automatically after study changes. It includes performance, timing, flags, subjects, test sections, and attempted, flagged, or annotated question details with choices, answers, explanations, and notes. Credentials and unrelated browser or device data are never included.</p>
        </div>
      </div>
      <label class="assistant-permission" for="studyCoachPermission">
        <input id="studyCoachPermission" type="checkbox">
        <span><strong>Allow Study Coach access until I revoke it</strong><small>This broader permission requires a fresh approval. Revoking stops access without deleting the stored data; deletion remains a separate action.</small></span>
      </label>
      <div class="actions">
        <button id="refreshStudyCoachBtn" class="primary" type="button" disabled>Refresh now</button>
        <button id="verifyStudyCoachAccessBtn" class="secondary" type="button" disabled>Verify access</button>
        <button id="revokeStudyCoachBtn" class="secondary" type="button" disabled>Revoke access</button>
        <button id="deleteStudyCoachDataBtn" class="secondary danger" type="button" disabled>Delete shared study data</button>
      </div>
      <p id="studyCoachStatus" class="muted" aria-live="polite"></p>
    </section>

    <section id="deckLibraryManagement" class="card dashboard-section">
      <div class="eyebrow" style="color:var(--blue)">DECK LIBRARY</div>
      <h3>Data protection</h3>
      <p class="muted">Three clear recovery destinations protect the same complete study workspace. Synchronization remains separate from point-in-time backups.</p>
      <p class="notice"><strong>Automatic local saving:</strong> answers and progress save to this browser immediately. A recoverable snapshot is also created before destructive actions.</p>
      <div id="recoveryDestinations" class="recovery-destinations" aria-live="polite"></div>
      <div class="deck-management-block">
        <h4>Question-bank management</h4>
        <p class="muted">Install or export individual versioned question-bank packages. These controls do not replace a complete workspace backup.</p>
        <div id="deckManagementActions" class="actions">
        <button id="importBankBtn" class="secondary" type="button" disabled>Import question bank</button>
        </div>
      </div>
    </section>

    <footer class="release-footer">Version 1.0 · Protected local-first study workspace</footer>
  `;

  // Bind core study controls before starting the optional assistant status
  // request. The assistant section reference is render-specific, so a slow
  // response cannot mutate a newer dashboard after the user changes decks.
  const assistantSection = document.getElementById('studyCoachSection');

  document.getElementById('startBtn').onclick = startSet;
  document.querySelectorAll('.question-browser-number').forEach((button) => {
    button.ondblclick = () => openSpecificQuestion(button.dataset.questionId);
    button.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSpecificQuestion(button.dataset.questionId);
    };
  });
  document.getElementById('questionBrowserSearch').oninput = (event) => {
    const query = event.target.value.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll('.question-browser-number').forEach((row) => {
      row.hidden = Boolean(query) && !row.dataset.search.includes(query);
      if (!row.hidden) visible += 1;
    });
    document.getElementById('questionBrowserEmpty').hidden = visible > 0;
  };
  document.getElementById('resumeBtn')?.addEventListener('click', renderQuestion);
  document.getElementById('importBankBtn').onclick = () => {
    alert('Additional bank import validation will be added before external banks are accepted.');
  };
  document.querySelectorAll('.review-history-btn').forEach((button) => {
    button.addEventListener('click', () => openCompletedSet(button.dataset.setId));
  });

  const subjectInputs = [...document.querySelectorAll('input[name="subjectFilter"]')];
  const countInput = document.getElementById('countInput');
  const modeSelect = document.getElementById('modeSelect');
  const timingSelect = document.getElementById('timingSelect');
  const poolSelect = document.getElementById('poolSelect');
  const randomizeOrder = document.getElementById('randomizeOrder');
  const eligibleCount = document.getElementById('eligibleCount');
  const subjectSummary = document.getElementById('subjectSummary');
  const startButton = document.getElementById('startBtn');
  let preferredCount = builder.count;

  const updateBuilderAvailability = ({ countChanged = false } = {}) => {
    const selectedCategories = selectedSubjectCategories();
    const eligible = eligibleQuestionIds(activeBank, progress, poolSelect.value, selectedCategories);
    if (countChanged) {
      preferredCount = Math.min(
        activeBank.questions.length,
        Math.max(1, Math.trunc(Number(countInput.value)) || 1)
      );
    }
    const displayedCount = eligible.length ? Math.min(preferredCount, eligible.length) : preferredCount;
    const capped = eligible.length > 0 && displayedCount < preferredCount;

    countInput.value = String(displayedCount);
    countInput.max = String(Math.max(1, eligible.length));
    startButton.disabled = eligible.length === 0;

    subjectSummary.textContent = selectedCategories.length === categories.length
      ? `All ${categories.length} selected`
      : selectedCategories.length
        ? `${selectedCategories.length} of ${categories.length} selected`
        : 'No subjects selected';
    eligibleCount.textContent = eligible.length
      ? `${eligible.length} question${eligible.length === 1 ? '' : 's'} available${capped ? '; requested set size adjusted to match.' : '.'}`
      : 'No questions match the selected subjects and question status.';
    eligibleCount.dataset.empty = eligible.length ? 'false' : 'true';

    localStorage.setItem(`${BUILDER_SETTINGS_PREFIX}${activeBank.id}`, JSON.stringify({
      schemaVersion: 1,
      count: preferredCount,
      mode: modeSelect.value,
      timing: timingSelect.value,
      pool: poolSelect.value,
      randomized: randomizeOrder.checked,
      categories: selectedCategories.length === categories.length ? null : selectedCategories
    }));
  };

  bindMultiDeckSelector(app, {
    decks: banks,
    activeBankId: activeBank.id,
    settings: multiDeckBuilder,
    onChange: (settings) => {
      localStorage.setItem(MULTI_DECK_BUILDER_KEY, JSON.stringify({ schemaVersion: 1, ...settings }));
      const combined = settings.scope !== DECK_SCOPE_CURRENT;
      startButton.textContent = combined ? 'Start combined set' : 'Start set';
      startButton.disabled = false;
      if (combined) {
        eligibleCount.textContent = document.getElementById('deckScopeAvailability')?.textContent || 'Selected study decks ready.';
        eligibleCount.dataset.empty = 'false';
      } else {
        updateBuilderAvailability();
      }
    },
  });

  document.getElementById('selectAllSubjectsBtn').onclick = () => {
    subjectInputs.forEach((input) => { input.checked = true; });
    updateBuilderAvailability();
  };
  document.getElementById('clearSubjectsBtn').onclick = () => {
    subjectInputs.forEach((input) => { input.checked = false; });
    updateBuilderAvailability();
  };
  subjectInputs.forEach((input) => input.addEventListener('change', updateBuilderAvailability));
  countInput.addEventListener('input', () => {
    const nextCount = Number(countInput.value);
    if (Number.isFinite(nextCount) && nextCount >= 1) {
      preferredCount = Math.min(activeBank.questions.length, Math.trunc(nextCount));
    }
  });
  countInput.addEventListener('change', () => updateBuilderAvailability({ countChanged: true }));
  modeSelect.addEventListener('change', updateBuilderAvailability);
  timingSelect.addEventListener('change', updateBuilderAvailability);
  poolSelect.addEventListener('change', () => {
    randomizeOrder.checked = poolSelect.value === 'all';
    updateBuilderAvailability();
  });
  randomizeOrder.addEventListener('change', updateBuilderAvailability);
  updateBuilderAvailability();
  void attachAssistantWeaknessControls({ root: assistantSection, banks });
}

async function startSet() {
  if (activeSet && !activeSet.submitted && !confirm(
    'Replace the current active set?\n\nIts saved answers will remain in local history, but it will no longer be resumable.'
  )) return;

  if (activeSet && !activeSet.submitted) await saveActiveSet('abandoned');

  const categories = selectedSubjectCategories();
  if (!categories.length) return alert('Select at least one subject before starting a practice set.');

  const settings = loadMultiDeckBuilderSettings(activeBank.id);
  const pool = document.getElementById('poolSelect').value;
  const count = document.getElementById('countInput').value;
  const mode = document.getElementById('modeSelect').value;
  const timed = document.getElementById('timingSelect').value === 'timed';
  const randomized = document.getElementById('randomizeOrder').checked;
  const categoriesByBank = categoriesByDeckForSession(banks, activeBank.id, categories);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const session = await createPracticeSession({
    decks: banks,
    activeBank,
    settings,
    loadProgress: progressMap,
    pool,
    categoriesByBank,
    count,
    mode,
    timed,
    now,
    id,
    random: Math.random,
    randomized,
    createSingleDeckSet: async ({ activeBank: selectedBank, pool: selectedPool, count: requestedCount, mode: selectedMode, timed: isTimed, now: startedAt, id: setId, random, randomized: randomizeQuestions, categories: selectedCategories }) => {
      const progress = await progressMap(selectedBank.id);
      const ids = chooseQuestionIds(selectedBank, progress, selectedPool, requestedCount, random, selectedCategories, randomizeQuestions);
      if (!ids.length) return null;
      return {
        id: setId,
        bankId: selectedBank.id,
        questionIds: ids,
        index: 0,
        mode: selectedMode,
        timed: isTimed,
        remainingSeconds: isTimed ? Math.ceil(ids.length * 70.6) : 0,
        submitted: false,
        startedAt,
        completedAt: null,
      };
    },
  });

  if (!session) return alert('No questions are available in that pool for the selected decks.');

  activeSet = {
    ...session,
    answers: new Map(),
    submitted: false,
    completedAt: null,
  };
  await saveActiveSet();
  await renderQuestion();
}

async function openSpecificQuestion(questionId) {
  if (activeSet && !activeSet.submitted && !confirm(
    'Replace the current active set?\n\nIts saved answers will remain in local history, but it will no longer be resumable.'
  )) return;
  if (activeSet && !activeSet.submitted) await saveActiveSet('abandoned');

  const selected = activeBank.questions.find((question) => question.id === questionId);
  if (!selected) return alert('That question is no longer available in the selected deck.');
  // Preserve an ordered linked-question group as one indivisible study set.
  const questionIds = selected.linkedGroupId
    ? activeBank.questions
      .filter((question) => question.linkedGroupId === selected.linkedGroupId)
      .sort((a, b) => Number(a.linkedOrder || 0) - Number(b.linkedOrder || 0))
      .map((question) => question.id)
    : [selected.id];

  activeSet = {
    id: crypto.randomUUID(),
    bankId: activeBank.id,
    questionIds,
    index: Math.max(0, questionIds.indexOf(selected.id)),
    mode: 'tutor',
    timed: false,
    remainingSeconds: 0,
    answers: new Map(),
    submitted: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  await saveActiveSet();
  await renderQuestion();
}

async function saveActiveSet(status = activeSet?.submitted ? 'completed' : 'active') {
  if (!activeSet) return;
  const record = persistenceRecordForSession(activeSet);
  record.status = status;
  await updatePracticeSet({ deviceId, record });
}

function submissionConfirmation() {
  const answered = [...activeSet.answers.values()].filter(hasQuestionAnswer).length;
  const unanswered = Math.max(0, activeSet.questionIds.length - answered);
  return confirm([
    'Submit this set now?',
    '',
    `${answered} answered`,
    `${unanswered} unanswered (submitted as omitted)`,
    '',
    'After submission, the test will be saved in History / Previous tests and can be reviewed later.'
  ].join('\n'));
}

// The in-set map deliberately separates completion from correctness. Test mode
// may show that an answer exists, but it cannot disclose whether it is correct
// until the full set has been submitted. Tutor mode may disclose a finalized
// incorrect answer immediately because its explanation is already visible.
function questionMapState(entry, { mode, submitted, flagged = false, current = false } = {}) {
  const answered = hasQuestionAnswer(entry);
  const discloseCorrectness = submitted || (mode === 'tutor' && entry?.finalized === true);
  const incorrect = answered && discloseCorrectness && entry?.isCorrect === false;
  return {
    answered,
    incorrect,
    classes: [
      answered ? 'answered' : 'unanswered',
      incorrect ? 'incorrect-answer' : '',
      flagged ? 'flagged' : '',
      current ? 'current' : '',
    ].filter(Boolean).join(' '),
  };
}

function questionMapLegend({ discloseCorrectness = false } = {}) {
  return `<div class="question-map-legend"><span><i class="legend-swatch answered"></i>Answered</span><span><i class="legend-swatch unanswered"></i>Unanswered</span>${discloseCorrectness ? '<span><i class="legend-incorrect-dot"></i>Incorrect</span>' : ''}<span><i class="legend-flag">★</i>Flagged</span></div>`;
}

function questionMapMarkup(items, {
  progressByBank = null,
  showCurrent = true,
  resultMap = false,
  sessionIndexes = items.map((_, index) => index),
} = {}) {
  const discloseCorrectness = activeSet.submitted || activeSet.mode === 'tutor';
  const mapClass = resultMap ? 'question-map results-question-map' : 'question-map';
  return `${questionMapLegend({ discloseCorrectness })}<div class="${mapClass}">${sessionIndexes.map((sessionIndex) => {
    const item = items[sessionIndex];
    const entry = activeSet.answers.get(item.answerKey);
    const state = questionMapState(entry, {
      mode: activeSet.mode,
      submitted: activeSet.submitted,
      flagged: Boolean(progressByBank?.get(item.bankId)?.get(item.questionId)?.isFlagged),
      current: showCurrent && sessionIndex === activeSet.index,
    });
    const status = state.answered ? (state.incorrect ? 'answered, incorrect' : 'answered') : 'unanswered';
    return `<button type="button" data-index="${sessionIndex}" class="${state.classes}" aria-label="Question ${sessionIndex + 1}, ${status}">${sessionIndex + 1}</button>`;
  }).join('')}</div>`;
}

async function renderQuestion() {
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
  const allSessionIndexes = items.map((_, index) => index);
  const reviewIndexes = activeSet.submitted && Array.isArray(reviewQuestionIndexes)
    ? reviewQuestionIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
    : allSessionIndexes;
  if (!reviewIndexes.length) return renderResults();
  if (!reviewIndexes.includes(activeSet.index)) activeSet.index = reviewIndexes[0];
  const reviewPosition = reviewIndexes.indexOf(activeSet.index);
  const isFirstQuestion = reviewPosition === 0;
  const isLastQuestion = reviewPosition === reviewIndexes.length - 1;
  const answeredCount = items.filter((item) => hasQuestionAnswer(activeSet.answers.get(item.answerKey))).length;
  const unansweredCount = Math.max(0, items.length - answeredCount);
  const correctLetters = selectedAnswerLetters(question.correctLetters?.length ? question.correctLetters : question.correctLetter);
  const answeredCorrectly = hasAnswer && isQuestionAnswerCorrect(question, selectedLetters);
  const answerLocked = activeSet.submitted || (activeSet.mode === 'tutor' && reveal);
  const finalNavigation = `<button id="nextBtn" class="primary" type="button" ${isLastQuestion ? 'disabled' : ''}>Next</button>`;
  const reviewLabel = activeSet.submitted && Array.isArray(reviewQuestionIndexes)
    ? `<span class="pill">Incorrect review ${reviewPosition + 1} of ${reviewIndexes.length}</span>`
    : '';

  startedQuestionAt = Date.now();
  app.innerHTML = `
    <section class="card exam">
      <div class="exam-workspace">
        <aside class="exam-question-sidebar" aria-label="Question navigation">
          <div class="question-rail-title">QUESTIONS</div>
          ${reviewLabel}
          ${questionMapMarkup(items, { progressByBank, sessionIndexes: reviewIndexes })}
        </aside>
        <div class="exam-question-main">
          <div class="exam-head"><div>
            <div class="eyebrow" style="color:var(--blue)">${esc(context.displayDeckTitle)}</div>
            <h2>Question ${activeSet.index + 1} of ${items.length}</h2>
            <div class="question-status-row"><span class="question-state ${hasAnswer ? 'answered' : 'unanswered'}">${hasAnswer ? 'Answered' : 'Unanswered'}</span><span class="muted">${answeredCount} answered · ${unansweredCount} unanswered</span></div>
          </div><div id="timer" class="timer">${activeSet.timed ? formatTime(activeSet.remainingSeconds) : 'Untimed'}</div></div>
          <div class="progress"><span style="width:${(activeSet.index + 1) / items.length * 100}%"></span></div>
          ${question.vignetteStem ? `<div class="vignette-stem"><strong>Clinical vignette</strong><div>${esc(question.vignetteStem)}</div></div>` : ''}
          <div class="question">${esc(question.question)}</div>
          ${question.isMultiSelect ? '<p class="multi-select-hint">Select all that apply. Full credit requires the exact set of correct choices.</p>' : ''}
          <div class="choices">${question.choices.map((choice, index) => {
        const letter = question.choiceLetters[index];
        const selected = selectedLetters.includes(letter);
        const correct = correctLetters.includes(letter);
        let classes = 'choice';
        if (selected) classes += ' selected';
        if (reveal && correct) classes += ' correct';
        if (reveal && selected && !correct) classes += ' incorrect';
        if (reveal && correct && !selected) classes += ' missed-correct';
        return `<button class="${classes}" data-answer="${esc(letter)}" aria-pressed="${selected}" ${answerLocked ? 'disabled' : ''}><span class="letter">${esc(letter)}</span><span>${esc(choice)}</span></button>`;
          }).join('')}</div>
          ${reveal ? `<div class="explanation"><strong>${answeredCorrectly ? 'Correct' : `Correct answer${correctLetters.length === 1 ? '' : 's'}: ${esc(correctLetters.join(', '))}`}</strong>${question.answerText ? `<div class="answer-text">${esc(question.answerText)}</div>` : ''}<div>${esc(question.explanation)}</div></div>` : ''}
          <div class="actions question-actions"><button id="flagBtn" class="secondary" type="button">${flagged ? 'Unflag' : 'Flag'} question</button>${question.isMultiSelect && activeSet.mode === 'tutor' && !activeSet.submitted && !reveal ? `<button id="checkAnswerBtn" class="primary" type="button" ${hasAnswer ? '' : 'disabled'}>Check answer</button>` : ''}${!activeSet.submitted ? '<button id="submitBtn" class="danger" type="button">Submit set</button>' : ''}</div>
          <div class="exam-nav"><button id="prevBtn" class="secondary" type="button" ${isFirstQuestion ? 'disabled' : ''}>Previous</button><button id="exitBtn" class="secondary" type="button">${activeSet.submitted ? 'Back to test summary' : 'Save and exit'}</button>${finalNavigation}</div>
        </div>
      </div>
    </section>`;

  document.querySelectorAll('.choice').forEach((button) => { button.onclick = () => answerQuestion(context, button.dataset.answer); });
  document.getElementById('checkAnswerBtn')?.addEventListener('click', () => finalizeMultiSelectAnswer(context));
  document.getElementById('flagBtn').onclick = async () => {
    const old = progress.get(context.questionId);
    await updateQuestionProgress({ bankId: context.bankId, questionId: context.questionId, deviceId, patch: { isFlagged: !old?.isFlagged } });
    scheduleStudyCoachRefresh({ banks });
    await renderQuestion();
  };
  document.getElementById('submitBtn')?.addEventListener('click', async () => { if (submissionConfirmation()) await submitSet({ showResults: true }); });
  document.querySelectorAll('.question-map button').forEach((button) => { button.onclick = async () => { activeSet.index = Number(button.dataset.index); await saveActiveSet(); await renderQuestion(); }; });
  document.getElementById('prevBtn').onclick = async () => { activeSet.index = reviewIndexes[reviewPosition - 1]; await saveActiveSet(); await renderQuestion(); };
  document.getElementById('nextBtn')?.addEventListener('click', async () => { activeSet.index = reviewIndexes[reviewPosition + 1]; await saveActiveSet(); await renderQuestion(); });
  document.getElementById('exitBtn').onclick = async () => { if (activeSet.submitted) renderResults(); else { await saveActiveSet(); await renderDashboard(); } };
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
  scheduleStudyCoachRefresh({ banks });
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
  reviewQuestionIndexes = null;
  const result = calculateSessionResult(banks, activeSet, activeSet.answers, { hasAnswer: hasQuestionAnswer });
  const items = setQuestionItems(banks, activeSet);
  const incorrectIndexes = items.map((item, index) => ({ item, index }))
    .filter(({ item }) => activeSet.answers.get(item.answerKey)?.isCorrect === false)
    .map(({ index }) => index);
  const percentage = result.total ? Math.round(result.correct / result.total * 100) : 0;
  const averageTimeMs = result.answered ? totalAnswerTimeMs(activeSet.answers) / result.answered : 0;
  app.innerHTML = `<section class="card results-card"><div class="eyebrow" style="color:var(--blue)">SET RESULTS</div><h2>${result.correct}/${result.total} correct (${percentage}%)</h2><p class="muted">${result.answered} answered · ${result.omitted} omitted · ${result.incorrect} incorrect</p><div class="result-stats"><div class="stat"><strong>${percentage}%</strong><span>Score</span></div><div class="stat"><strong>${result.omitted}</strong><span>Omitted</span></div><div class="stat"><strong>${result.answered ? formatSeconds(averageTimeMs) : '—'}</strong><span>Average time/question</span></div></div>${result.byBank.length > 1 ? `<table class="summary-table"><thead><tr><th>Deck</th><th>Correct</th><th>Answered</th></tr></thead><tbody>${result.byBank.map((bank) => `<tr><td>${esc(bank.title)}</td><td>${bank.correct}/${bank.total}</td><td>${bank.answered}</td></tr>`).join('')}</tbody></table>` : ''}<section class="results-question-list" aria-labelledby="resultsQuestionListTitle"><h3 id="resultsQuestionListTitle">Question results</h3><p class="muted">Select a number to review that question.</p>${questionMapMarkup(items, { showCurrent: false, resultMap: true })}</section><p class="notice">This completed test is saved locally in History / Previous tests and can be reviewed again later.</p><div class="actions"><button id="reviewIncorrectBtn" class="secondary" type="button" ${incorrectIndexes.length ? '' : 'disabled'}>Review incorrect questions (${incorrectIndexes.length})</button><button id="reviewBtn" class="secondary" type="button">Review all questions</button><button id="finishBtn" class="primary" type="button">Back to dashboard</button></div></section>`;
  document.querySelectorAll('.results-question-map button').forEach((button) => {
    button.onclick = async () => {
      activeSet.index = Number(button.dataset.index);
      reviewQuestionIndexes = null;
      await saveActiveSet('completed');
      await renderQuestion();
    };
  });
  document.getElementById('reviewIncorrectBtn').onclick = async () => { reviewQuestionIndexes = incorrectIndexes; activeSet.index = incorrectIndexes[0]; await saveActiveSet('completed'); await renderQuestion(); };
  document.getElementById('reviewBtn').onclick = async () => { reviewQuestionIndexes = null; activeSet.index = 0; await saveActiveSet('completed'); await renderQuestion(); };
  document.getElementById('finishBtn').onclick = async () => { reviewQuestionIndexes = null; activeSet = null; await renderDashboard(); };
}

async function openCompletedSet(setId) {
  const saved = await getRecord(STORES.SETS, setId);
  if (!saved || saved.status !== 'completed' || !(saved.bankId === activeBank.id || saved.selectedBankIds?.includes?.(activeBank.id))) return alert('That completed test could not be found for the selected question bank.');
  const hydrated = await hydrateStoredSet(saved);
  if (!hydrated) return alert('That completed test contains question references that are no longer available.');
  reviewQuestionIndexes = null;
  activeSet = hydrated; activeSet.submitted = true; renderResults();
}

homeBtn.onclick = async () => {
  if (activeSet && !activeSet.submitted) await saveActiveSet();
  if (activeSet?.submitted) { reviewQuestionIndexes = null; activeSet = null; }
  await renderDashboard();
};

window.addEventListener('beforeunload', () => {
  if (activeSet && !activeSet.submitted) void saveActiveSet();
});

// Bootstrap and controllers share this explicit readiness boundary instead of
// guessing when the first asynchronous dashboard render has completed.
export const applicationReady = initialize();
export const refreshApplication = () => applicationReady.then(() => initialize());
