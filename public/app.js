import { QUESTION_BANKS } from './banks/catalog.js';
import { buildBankCatalog, chooseQuestionIds, calculateSetResult, categoryStatistics } from './client/study-engine.js';
import { STORES, putRecord, recordsByIndex, updateQuestionProgress, createRecoverySnapshot } from './client/storage.js';

const app = document.getElementById('app');
const homeBtn = document.getElementById('homeBtn');
const syncBtn = document.getElementById('syncBtn');
const syncStatus = document.getElementById('syncStatus');
const SELECTED_BANK_KEY = 'abpn-study:selected-bank';
const deviceId = localStorage.getItem('abpn-study:device-id') || crypto.randomUUID();
localStorage.setItem('abpn-study:device-id', deviceId);

let banks;
let activeBank;
let activeSet = null;
let timer = null;
let startedQuestionAt = Date.now();

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const formatTime = (seconds) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(safe / 3600), Math.floor((safe % 3600) / 60), safe % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
};

async function progressMap(bankId) {
  return new Map((await recordsByIndex(STORES.PROGRESS, 'byBank', bankId)).map((record) => [record.questionId, record]));
}

async function loadActiveSet(bankId) {
  const candidates = (await recordsByIndex(STORES.SETS, 'byStatus', 'active'))
    .filter((record) => record.bankId === bankId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const saved = candidates[0];
  if (!saved) return null;

  if (!Array.isArray(saved.questionIds) || saved.questionIds.some((id) => !activeBank.byId.has(id))) {
    await putRecord(STORES.SETS, { ...saved, status: 'invalid', updatedAt: new Date().toISOString() });
    return null;
  }

  const savedAnswers = await recordsByIndex(STORES.ANSWERS, 'bySet', saved.id);
  const answers = new Map(savedAnswers.map((answer) => [answer.questionId, answer]));
  let remainingSeconds = Number(saved.remainingSeconds ?? 0);
  if (saved.timed && !saved.submitted && saved.updatedAt) {
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(saved.updatedAt).getTime()) / 1000));
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
    startedAt: saved.startedAt
  };
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
    if (activeSet?.timed && !activeSet.submitted && activeSet.remainingSeconds <= 0) await submitSet(true);
    else await renderDashboard();
  } catch (error) {
    app.innerHTML = `<section class="card"><h2>Application could not start</h2><p class="notice">${esc(error.message)}</p></section>`;
  }
}

async function selectBank(bankId) {
  activeBank = banks.find((bank) => bank.id === bankId) || activeBank;
  localStorage.setItem(SELECTED_BANK_KEY, activeBank.id);
  activeSet = await loadActiveSet(activeBank.id);
  await renderDashboard();
}

async function renderDashboard() {
  clearInterval(timer);
  homeBtn.hidden = true;
  const progress = await progressMap(activeBank.id);
  const answered = [...progress.values()].filter((record) => record.timesUsed).length;
  const correct = [...progress.values()].filter((record) => record.isCorrect === true).length;
  const flagged = [...progress.values()].filter((record) => record.isFlagged).length;
  const rows = categoryStatistics(activeBank, progress).filter((row) => row.answered);
  const resumable = activeSet && activeSet.bankId === activeBank.id;

  app.innerHTML = `<section class="card hero"><div><div class="eyebrow" style="color:var(--blue)">ACTIVE QUESTION BANK</div><h2>${esc(activeBank.title)}</h2><p class="muted">${esc(activeBank.description)} ${activeBank.questions.length} questions loaded.</p></div><div class="bank-selector"><label><strong>Question bank</strong></label><select id="bankSelect">${banks.map((bank) => `<option value="${esc(bank.id)}" ${bank.id === activeBank.id ? 'selected' : ''}>${esc(bank.title)} (${bank.questions.length})</option>`).join('')}</select></div></section>
  <section class="stats"><div class="stat"><strong>${activeBank.questions.length}</strong><span>Total</span></div><div class="stat"><strong>${answered}</strong><span>Used</span></div><div class="stat"><strong>${correct}</strong><span>Correct</span></div><div class="stat"><strong>${flagged}</strong><span>Flagged</span></div></section>
  ${resumable ? `<section class="card"><h3>${activeSet.submitted ? 'Review completed set' : 'Resume active set'}</h3><p class="muted">${activeSet.questionIds.length} questions · ${esc(activeSet.mode)} mode${activeSet.timed ? ` · ${formatTime(activeSet.remainingSeconds)} remaining` : ''}</p><div class="actions"><button id="resumeBtn" class="primary">${activeSet.submitted ? 'Review set' : 'Resume set'}</button></div></section>` : ''}
  <section class="grid"><div class="stack"><section class="card"><h3>Create practice set</h3><div class="form-grid"><div class="field"><label>Questions</label><input id="countInput" type="number" min="1" max="${activeBank.questions.length}" value="${Math.min(40, activeBank.questions.length)}"></div><div class="field"><label>Mode</label><select id="modeSelect"><option value="test">Test</option><option value="tutor">Tutor</option></select></div><div class="field"><label>Timing</label><select id="timingSelect"><option value="timed">Timed at 70.6 sec/question</option><option value="untimed">Untimed</option></select></div><div class="field"><label>Pool</label><select id="poolSelect"><option value="all">All</option><option value="new">New</option><option value="incorrect">Incorrect</option><option value="flagged">Flagged</option></select></div></div><div class="actions"><button id="startBtn" class="primary">Start randomized set</button></div></section><section class="card"><h3>Performance by category</h3>${rows.length ? `<table class="summary-table"><thead><tr><th>Category</th><th>Used</th><th>Accuracy</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.title)}</td><td>${row.answered}/${row.total}</td><td>${Math.round(row.accuracy * 100)}%</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Complete questions to build analytics.</div>'}</section></div><div class="stack"><section class="card"><h3>Data protection</h3><p class="notice">Progress saves to IndexedDB immediately. Cloud synchronization is additive and does not replace local-first saving.</p><div class="actions"><button id="snapshotBtn" class="secondary">Create recovery snapshot</button><button id="importBankBtn" class="secondary">Import question bank</button></div></section><section class="card"><h3>Current release state</h3><p class="muted">The protected K&S package and validation bank are loaded independently so future banks can be added without mixing progress.</p></section></div></section>`;

  document.getElementById('bankSelect').onchange = (event) => selectBank(event.target.value);
  document.getElementById('startBtn').onclick = startSet;
  document.getElementById('resumeBtn')?.addEventListener('click', renderQuestion);
  document.getElementById('snapshotBtn').onclick = async () => {
    await createRecoverySnapshot('manual');
    alert('Recovery snapshot created.');
  };
  document.getElementById('importBankBtn').onclick = () => alert('Additional bank import validation will be added before external banks are accepted.');
}

async function startSet() {
  if (activeSet && !activeSet.submitted && !confirm('Replace the current active set? Its saved answers will remain in history, but it will no longer be resumable.')) return;
  if (activeSet && !activeSet.submitted) await saveActiveSet('abandoned');
  const progress = await progressMap(activeBank.id);
  const ids = chooseQuestionIds(activeBank, progress, document.getElementById('poolSelect').value, document.getElementById('countInput').value);
  if (!ids.length) return alert('No questions are available in that pool.');
  activeSet = {
    id: crypto.randomUUID(), bankId: activeBank.id, questionIds: ids, index: 0,
    mode: document.getElementById('modeSelect').value,
    timed: document.getElementById('timingSelect').value === 'timed',
    remainingSeconds: Math.ceil(ids.length * 70.6), answers: new Map(), submitted: false,
    startedAt: new Date().toISOString()
  };
  await saveActiveSet();
  await renderQuestion();
}

async function saveActiveSet(status = activeSet?.submitted ? 'completed' : 'active') {
  if (!activeSet) return;
  await putRecord(STORES.SETS, {
    id: activeSet.id, bankId: activeSet.bankId, status, mode: activeSet.mode,
    timed: activeSet.timed, questionIds: activeSet.questionIds, index: activeSet.index,
    remainingSeconds: activeSet.remainingSeconds, submitted: activeSet.submitted,
    startedAt: activeSet.startedAt, updatedAt: new Date().toISOString()
  });
}

async function renderQuestion() {
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
  const reveal = activeSet.submitted || (activeSet.mode === 'tutor' && answer);
  const progress = await progressMap(activeBank.id);
  const flagged = progress.get(question.id)?.isFlagged;
  const isLastQuestion = activeSet.index === activeSet.questionIds.length - 1;
  const finalNavigation = activeSet.submitted && isLastQuestion
    ? '<button id="resultsBtn" class="primary">View results</button>'
    : !activeSet.submitted && activeSet.mode === 'tutor' && isLastQuestion
      ? '<button id="finishSetBtn" class="primary">Finish set</button>'
      : `<button id="nextBtn" class="primary" ${isLastQuestion ? 'disabled' : ''}>Next</button>`;
  startedQuestionAt = Date.now();

  app.innerHTML = `<section class="card exam"><div class="exam-head"><div><div class="eyebrow" style="color:var(--blue)">${esc(activeBank.shortTitle)}</div><h2>Question ${activeSet.index + 1} of ${activeSet.questionIds.length}</h2></div><div id="timer" class="timer">${activeSet.timed ? formatTime(activeSet.remainingSeconds) : 'Untimed'}</div></div><div class="progress"><span style="width:${(activeSet.index + 1) / activeSet.questionIds.length * 100}%"></span></div><div class="question">${esc(question.question)}</div><div class="choices">${question.choices.map((choice, index) => {
    const letter = question.choiceLetters[index];
    let classes = 'choice';
    if (answer?.selectedAnswer === letter) classes += ' selected';
    if (reveal && letter === question.correctLetter) classes += ' correct';
    if (reveal && answer?.selectedAnswer === letter && letter !== question.correctLetter) classes += ' incorrect';
    return `<button class="${classes}" data-answer="${esc(letter)}" ${activeSet.submitted ? 'disabled' : ''}><span class="letter">${esc(letter)}</span><span>${esc(choice)}</span></button>`;
  }).join('')}</div>${reveal ? `<div class="explanation"><strong>${answer?.selectedAnswer === question.correctLetter ? 'Correct' : `Correct answer: ${esc(question.correctLetter)}`}</strong><div>${esc(question.explanation)}</div></div>` : ''}<div class="actions"><button id="flagBtn" class="secondary">${flagged ? 'Unflag' : 'Flag'} question</button>${!activeSet.submitted && activeSet.mode === 'test' ? '<button id="submitBtn" class="danger">Submit set</button>' : ''}</div><div class="question-map">${activeSet.questionIds.map((id, index) => `<button data-index="${index}" class="${index === activeSet.index ? 'current ' : ''}${activeSet.answers.has(id) ? 'answered ' : ''}${progress.get(id)?.isFlagged ? 'flagged' : ''}">${index + 1}</button>`).join('')}</div><div class="exam-nav"><button id="prevBtn" class="secondary" ${activeSet.index === 0 ? 'disabled' : ''}>Previous</button><button id="exitBtn" class="secondary">Save and exit</button>${finalNavigation}</div></section>`;

  document.querySelectorAll('.choice').forEach((button) => { button.onclick = () => answerQuestion(question, button.dataset.answer); });
  document.getElementById('flagBtn').onclick = async () => {
    const old = progress.get(question.id);
    await updateQuestionProgress({ bankId: activeBank.id, questionId: question.id, deviceId, patch: { isFlagged: !old?.isFlagged } });
    await renderQuestion();
  };
  document.getElementById('submitBtn')?.addEventListener('click', () => submitSet(false));
  document.getElementById('finishSetBtn')?.addEventListener('click', async () => {
    await submitSet(false, true);
  });
  document.querySelectorAll('.question-map button').forEach((button) => {
    button.onclick = async () => { activeSet.index = Number(button.dataset.index); await saveActiveSet(); await renderQuestion(); };
  });
  document.getElementById('prevBtn').onclick = async () => { activeSet.index -= 1; await saveActiveSet(); await renderQuestion(); };
  document.getElementById('nextBtn')?.addEventListener('click', async () => { activeSet.index += 1; await saveActiveSet(); await renderQuestion(); });
  document.getElementById('exitBtn').onclick = async () => { await saveActiveSet(); await renderDashboard(); };
  document.getElementById('resultsBtn')?.addEventListener('click', renderResults);

  if (activeSet.timed && !activeSet.submitted) {
    timer = setInterval(async () => {
      activeSet.remainingSeconds = Math.max(0, activeSet.remainingSeconds - 1);
      const element = document.getElementById('timer');
      if (element) element.textContent = formatTime(activeSet.remainingSeconds);
      if (activeSet.remainingSeconds % 5 === 0) await saveActiveSet();
      if (activeSet.remainingSeconds <= 0) {
        clearInterval(timer);
        await submitSet(true);
      }
    }, 1000);
  }
}

async function answerQuestion(question, selectedAnswer) {
  if (activeSet.submitted) return;
  const entry = {
    selectedAnswer,
    isCorrect: selectedAnswer === question.correctLetter,
    timeMs: Math.max(0, Date.now() - startedQuestionAt),
    updatedAt: new Date().toISOString()
  };
  activeSet.answers.set(question.id, entry);
  await putRecord(STORES.ANSWERS, { setId: activeSet.id, questionId: question.id, ...entry });
  if (activeSet.mode === 'tutor') await saveProgress(question, entry);
  await saveActiveSet();
  await renderQuestion();
}

async function saveProgress(question, entry) {
  const current = (await progressMap(activeBank.id)).get(question.id);
  await updateQuestionProgress({
    bankId: activeBank.id, questionId: question.id, deviceId,
    patch: {
      selectedAnswer: entry.selectedAnswer, isCorrect: entry.isCorrect,
      timesUsed: Number(current?.timesUsed || 0) + 1,
      totalTimeMs: Number(current?.totalTimeMs || 0) + Number(entry.timeMs || 0),
      lastUsedAt: new Date().toISOString()
    }
  });
}

async function submitSet(auto = false, showResults = false) {
  if (!activeSet || activeSet.submitted) return;
  activeSet.submitted = true;
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
  app.innerHTML = `<section class="card"><div class="eyebrow" style="color:var(--blue)">SET RESULTS</div><h2>${result.correct}/${result.total} correct (${percentage}%)</h2><p class="muted">${result.answered} answered · ${result.omitted} omitted · ${result.incorrect} incorrect</p><div class="actions"><button id="reviewBtn" class="secondary">Review questions</button><button id="finishBtn" class="primary">Finish</button></div></section>`;
  document.getElementById('reviewBtn').onclick = async () => { activeSet.index = 0; await saveActiveSet('completed'); await renderQuestion(); };
  document.getElementById('finishBtn').onclick = async () => { activeSet = null; await renderDashboard(); };
}

syncBtn.onclick = async () => {
  syncStatus.textContent = 'Checking…';
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('Cloud service unavailable');
    const data = await response.json();
    syncStatus.textContent = data.database === 'connected' ? 'Cloud ready' : 'Cloud not configured';
  } catch {
    syncStatus.textContent = 'Local only';
  }
};
homeBtn.onclick = renderDashboard;
window.addEventListener('beforeunload', () => { if (activeSet) void saveActiveSet(); });
initialize();
