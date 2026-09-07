// Real builder controls must select and persist the same AND/OR result.
import {test, expect} from '@playwright/test';
for (const combined of [false,true]) test(`status AND/OR creates matching ${combined ? 'combined' : 'current'} set`, async ({page}) => {
  await page.goto('/');
  await expect(page.locator('#importBankBtn')).toBeEnabled();
  await page.evaluate(async () => {
    const {installQuestionBankPackage} = await import('/client/question-bank-import.js');
    const {STORES,putRecord} = await import('/client/storage.js');
    const bankId='status-fixture';
    await installQuestionBankPackage({format:'abpn-question-bank',schemaVersion:1,bank:{id:bankId,title:'Status fixture',version:'1',sourceType:'user-imported',contentClass:'source-material',questions:['both','wrong','flagged'].map(id=>({id,question:'Synthetic filter check?',choices:['One','Two'],choiceLetters:['A','B'],correctLetter:'A',explanation:'Fixture.',subjectTitle:'S'}))}});
    for (const id of ['both','wrong','flagged']) await putRecord(STORES.PROGRESS,{bankId,questionId:id,timesUsed:1,isCorrect:id==='flagged',isFlagged:id!=='wrong'});
    localStorage.setItem('abpn-study:selected-bank',bankId);
  });
  await page.reload();
  if(combined) await page.locator('#deckScopeSelect').selectOption('all');
  await page.locator('#question-status-incorrect').check();
  await page.locator('#question-status-flagged').check();
  await expect(page.locator('#eligibleCount')).toContainText('3 questions available');
  await page.locator('#statusMatchSelect').selectOption('and');
  await expect(page.locator('#eligibleCount')).toContainText('1 question available');
  await page.reload();
  await expect(page.locator('#statusMatchSelect')).toHaveValue('and');
  await expect(page.locator('#eligibleCount')).toContainText('1 question available');
  await page.locator('#startBtn').click();
  await expect.poll(()=>page.evaluate(async()=>{
    const {STORES,getAllRecords}=await import('/client/storage.js');
    return (await getAllRecords(STORES.SETS)).map(s=>({criteria:s.specialCriteria,ids:s.questionIds}));
  })).toEqual([expect.objectContaining({criteria:expect.objectContaining({statusMatch:'and'}),ids:expect.arrayContaining([expect.stringMatching(/both/)])})]);
});
