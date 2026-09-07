// Prepare the latest coach batch without touching question attempts or history.
export function focusCoachPractice(bank, storage = globalThis.localStorage, questionIds = null) {
  const latest = Math.max(0, ...bank.questions.map(q => Number(String(q.chapterTitle).match(/^Study Coach Test (\d+)/)?.[1] || 0)));
  const ids = questionIds && new Set(questionIds);
  const sections = [...new Set(bank.questions.filter(q => ids ? ids.has(q.id) : String(q.chapterTitle).match(/^Study Coach Test (\d+)/)?.[1] === String(latest)).map(q => q.chapterTitle))];
  if (!sections.length) throw new Error('The latest coach questions are not installed. Retry Update Study Coach.');
  const key = `abpn-study:builder-settings:${bank.id}`;
  let previous = {};
  try { previous = JSON.parse(storage.getItem(key) || '{}') || {}; } catch {}
  storage.setItem(key, JSON.stringify({ ...previous, categories: null, sourceSections: sections, pools: ['new'], specialCriteria: null }));
  storage.setItem('abpn-study:selected-bank', bank.id);
  storage.setItem('abpn-study:multi-deck-builder', JSON.stringify({ scope: 'current', selectedBankIds: [bank.id] }));
  return sections;
}
