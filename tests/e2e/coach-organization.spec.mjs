import { test, expect } from '@playwright/test';

// Verify organization-only installation against real IndexedDB and builder UI.
test('canonical coach organization preserves saved study records and exposes latest batch', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name:'Import from file'})).toBeEnabled();
  const result = await page.evaluate(async () => {
    const {buildStudyCoachDeckLibraryUpdate} = await import('/client/study-coach-deck-library.js');
    const {installQuestionBankPackage} = await import('/client/question-bank-import.js');
    const {STORES, putRecord, getAllRecords} = await import('/client/storage.js');
    const bankId = 'study-coach-question-bank';
    const q = id => ({id, question:'Synthetic validation question?', choices:['One','Two'], choiceLetters:['A','B'], correctLetter:'A', correctLetters:['A'], isMultiSelect:false, explanation:'Synthetic validation explanation.', subjectTitle:'Psychiatry'});
    const update = buildStudyCoachDeckLibraryUpdate({generatedDecks:[{bankId:'validation-cycle', package:{format:'abpn-question-bank',schemaVersion:1,bank:{questions:[q('coach-old'),q('coach-new')]}}}]});
    await installQuestionBankPackage(update.package);
    await putRecord(STORES.PROGRESS,{bankId,questionId:'coach-old',timesUsed:1,selectedAnswer:'B',isCorrect:false,isFlagged:true});
    await putRecord(STORES.SETS,{id:'saved-test',bankId,status:'completed',questionIds:['coach-old'],score:0});
    await putRecord(STORES.ANSWERS,{setId:'saved-test',questionId:'coach-old',selectedAnswer:'B',finalized:true});
    const stores = [STORES.PROGRESS,STORES.SETS,STORES.ANSWERS,STORES.OUTBOX];
    const snapshot = () => Promise.all(stores.map(s=>getAllRecords(s)));
    const before = await snapshot();
    const canonical = {...update.package,bank:{...update.package.bank,questions:update.package.bank.questions.map(q=>q.id === 'coach-old' ? q : {...q,chapterTitle:'Study Coach Test 6',chapter:6})}};
    await installQuestionBankPackage(canonical,{allowCoachOrganizationUpdate:true});
    await installQuestionBankPackage(canonical,{allowCoachOrganizationUpdate:true});
    localStorage.setItem('abpn-study:selected-bank',bankId);
    localStorage.setItem(`abpn-study:builder-settings:${bankId}`,JSON.stringify({sourceSections:['Study Coach Test 4'],pools:['new']}));
    return {before,after:await snapshot()};
  });
  expect(result.after).toEqual(result.before);
  await page.reload();
  await page.locator('#latestCoachTestBtn').click();
  const settings = await page.evaluate(()=>JSON.parse(localStorage.getItem('abpn-study:builder-settings:study-coach-question-bank')));
  expect(settings.sourceSections).toEqual(['Study Coach Test 6']);
  expect(settings.pools).toEqual(['new']);
  await expect(page.locator('#startBtn')).toBeEnabled();
  // Ordinary controls must work independently of the latest-batch shortcut.
  await page.locator('#sourceSectionPicker').evaluate(e => { e.open = true; });
  await page.locator('#clearSourceSectionsBtn').click();
  await page.locator('input[name="sourceSectionFilter"][value="Study Coach Test 1"]').check();
  await expect(page.locator('#startBtn')).toBeDisabled();
  await expect(page.locator('#eligibleCount')).toContainText('0 new and 1 used');
  await page.locator('input[name="questionStatusFilter"]').first().evaluate(e => { e.closest('details').open = true; });
  for (const status of ['all', 'used', 'incorrect', 'flagged']) {
    await page.locator('input[name="questionStatusFilter"]').evaluateAll(inputs => {
      for (const input of inputs) input.checked = false;
    });
    await page.locator(`input[name="questionStatusFilter"][value="${status}"]`).check();
    await expect(page.locator('#eligibleCount')).toContainText('1 question available');
    await expect(page.locator('#startBtn')).toBeEnabled();
  }
  await page.locator('input[name="questionStatusFilter"][value="new"]').check();
  await page.locator('#selectAllSourceSectionsBtn').click();
  await expect(page.locator('#eligibleCount')).toContainText('2 questions available');
  await page.reload();
  await expect(page.locator('#eligibleCount')).toContainText('2 questions available');
  await page.locator('#startBtn').click();
  await expect.poll(() => page.evaluate(async () => {
    const {getAllRecords, STORES} = await import('/client/storage.js');
    const created = (await getAllRecords(STORES.SETS)).find(s => s.id !== 'saved-test');
    return created?.questionIds?.slice().sort();
  })).toEqual(['coach-new','coach-old']);
});
