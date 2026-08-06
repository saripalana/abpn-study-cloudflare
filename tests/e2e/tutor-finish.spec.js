import { test, expect } from '@playwright/test';
import { selectActiveBank } from './helpers/active-bank.mjs';

async function startOrderedValidationSet(page, mode) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import from file' })).toBeEnabled();
  await selectActiveBank(page, 'validation-bank');
  await page.locator('#countInput').fill('2');
  await page.selectOption('#modeSelect', mode);
  await page.selectOption('#timingSelect', 'untimed');
  await page.selectOption('#poolSelect', 'all');
  await page.getByLabel('Randomize question order').uncheck();
  await page.locator('#startBtn').click();
}

test('Tutor question map uses blue answered states and immediate incorrect dots', async ({ page }) => {
  await startOrderedValidationSet(page, 'tutor');

  await page.locator('.choice').first().click();
  await expect(page.locator('.question-map button').nth(0)).toHaveClass(/answered/);
  await expect(page.locator('.question-map button').nth(0)).toHaveClass(/incorrect-answer/);
  await expect(page.locator('.question-map button').nth(0)).toHaveAttribute('aria-label', 'Question 1, answered, incorrect');

  await page.locator('#nextBtn').click();
  await page.locator('.choice').nth(1).click();
  await expect(page.locator('.question-map button').nth(1)).toHaveClass(/answered/);
  await expect(page.locator('.question-map button').nth(1)).not.toHaveClass(/incorrect-answer/);

  page.once('dialog', async (dialog) => dialog.accept());
  await page.locator('#submitBtn').click();
  await expect(page.getByRole('heading', { name: 'Question results' })).toBeVisible();
  await expect(page.locator('.results-question-map button')).toHaveCount(2);
  await expect(page.locator('.results-question-map button').nth(0)).toHaveClass(/incorrect-answer/);
  await expect(page.locator('.results-question-map button').nth(1)).not.toHaveClass(/incorrect-answer/);
});

test('Test question map hides correctness until submission and then shows the full result map', async ({ page }) => {
  await startOrderedValidationSet(page, 'test');

  await page.locator('.choice').first().click();
  await expect(page.locator('.question-map button').nth(0)).toHaveClass(/answered/);
  await expect(page.locator('.question-map button').nth(0)).not.toHaveClass(/incorrect-answer/);
  await expect(page.locator('.question-map button').nth(0)).toHaveAttribute('aria-label', 'Question 1, answered');
  await expect(page.getByText('Incorrect', { exact: true })).toHaveCount(0);

  await page.locator('#nextBtn').click();
  await page.locator('.choice').nth(1).click();
  await expect(page.locator('.question-map button').nth(1)).toHaveClass(/answered/);
  await expect(page.locator('.question-map button').nth(1)).not.toHaveClass(/incorrect-answer/);

  page.once('dialog', async (dialog) => dialog.accept());
  await page.locator('#submitBtn').click();
  await expect(page.getByRole('heading', { name: 'Question results' })).toBeVisible();
  await expect(page.locator('.results-question-map button')).toHaveCount(2);
  await expect(page.locator('.results-question-map button').nth(0)).toHaveClass(/incorrect-answer/);
  await expect(page.locator('.results-question-map button').nth(1)).not.toHaveClass(/incorrect-answer/);
  await expect(page.getByText('Incorrect', { exact: true })).toBeVisible();
});

test('Completed-test review supports incorrect-only and all-question flows with a separate left rail', async ({ page }) => {
  await startOrderedValidationSet(page, 'test');

  await page.locator('.choice').first().click();
  await page.locator('#nextBtn').click();
  await page.locator('.choice').nth(1).click();
  page.once('dialog', async (dialog) => dialog.accept());
  await page.locator('#submitBtn').click();

  await expect(page.getByRole('button', { name: 'Review incorrect questions (1)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Review all questions' })).toBeEnabled();
  await page.getByRole('button', { name: 'Review incorrect questions (1)' }).click();

  await expect(page.getByRole('button', { name: 'Back to test summary' })).toBeVisible();
  await expect(page.getByText('Incorrect review 1 of 1')).toBeVisible();
  await expect(page.locator('.exam-question-sidebar .question-map button')).toHaveCount(1);
  await expect(page.locator('.exam-question-sidebar .question-map button')).toHaveText('1');
  await expect(page.locator('#prevBtn')).toBeDisabled();
  await expect(page.locator('#nextBtn')).toBeDisabled();

  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector('.exam-question-sidebar');
    const main = document.querySelector('.exam-question-main');
    const sidebarBox = sidebar.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(sidebar).overflowY,
      sidebarLeft: sidebarBox.left,
      mainLeft: mainBox.left,
      narrow: matchMedia('(max-width: 560px)').matches,
    };
  });
  expect(layout.overflowY).toBe('auto');
  if (!layout.narrow) expect(layout.sidebarLeft).toBeLessThan(layout.mainLeft);

  await page.getByRole('button', { name: 'Back to test summary' }).click();
  await expect(page.getByText('SET RESULTS')).toBeVisible();
  await page.getByRole('button', { name: 'Review all questions' }).click();
  await expect(page.locator('.exam-question-sidebar .question-map button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Back to test summary' })).toBeVisible();
});

test('Tutor mode supports confirmed submission at any point, answer states, and completed-test history', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import from file' })).toBeEnabled();
  await selectActiveBank(page, 'validation-bank');
  await page.locator('#countInput').fill('3');
  await page.selectOption('#modeSelect', 'tutor');
  await page.selectOption('#timingSelect', 'untimed');
  await page.selectOption('#poolSelect', 'all');
  await page.locator('#startBtn').click();

  await expect(page.locator('#submitBtn')).toHaveText('Submit set');
  await expect(page.locator('.question-map button.unanswered')).toHaveCount(3);
  await expect(page.locator('.question-map button.answered')).toHaveCount(0);
  await expect(page.getByText('Unanswered', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Answered', { exact: true }).last()).toBeVisible();

  await page.locator('.choice').first().click();
  await expect(page.locator('.explanation')).toBeVisible();
  await expect(page.locator('.question-state.answered')).toHaveText('Answered');
  await expect(page.locator('.question-map button.answered')).toHaveCount(1);
  await expect(page.locator('.question-map button.unanswered')).toHaveCount(2);

  await page.locator('#nextBtn').click();
  await expect(page.locator('.question-state.unanswered')).toHaveText('Unanswered');
  await expect(page.locator('#submitBtn')).toBeVisible();

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('Submit this set now?');
    expect(dialog.message()).toContain('1 answered');
    expect(dialog.message()).toContain('2 unanswered');
    expect(dialog.message()).toContain('History / Previous tests');
    await dialog.dismiss();
  });
  await page.locator('#submitBtn').click();
  await expect(page.getByText('SET RESULTS')).toHaveCount(0);
  await expect(page.locator('#submitBtn')).toBeVisible();

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('2 unanswered (submitted as omitted)');
    await dialog.accept();
  });
  await page.locator('#submitBtn').click();

  await expect(page.getByText('SET RESULTS')).toBeVisible();
  await expect(page.getByText('1 answered · 2 omitted', { exact: false })).toBeVisible();
  await expect(page.getByText('saved locally in History / Previous tests', { exact: false })).toBeVisible();

  const stored = await page.evaluate(async () => {
    const { STORES, getAllRecords, recordsByIndex } = await import('/client/storage.js');
    const progress = await recordsByIndex(STORES.PROGRESS, 'byBank', 'validation-bank');
    const sets = await getAllRecords(STORES.SETS);
    const completedSet = sets.find((set) => set.bankId === 'validation-bank' && set.status === 'completed');
    const answers = completedSet
      ? await recordsByIndex(STORES.ANSWERS, 'bySet', completedSet.id)
      : [];
    return {
      progress: progress.map((record) => ({
        questionId: record.questionId,
        timesUsed: record.timesUsed,
      })),
      completedSet,
      answerCount: answers.length,
    };
  });

  expect(stored.progress).toHaveLength(1);
  expect(stored.progress[0].timesUsed).toBe(1);
  expect(stored.completedSet?.submitted).toBe(true);
  expect(stored.completedSet?.completedAt).toBeTruthy();
  expect(stored.answerCount).toBe(1);

  await page.locator('#finishBtn').click();
  await expect(page.getByText('Resume active set')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'History / Previous tests' })).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.locator('.history-item')).toContainText('1 answered');
  await expect(page.locator('.history-item')).toContainText('2 omitted');
  await expect(page.getByText('Performance by subject')).toBeVisible();
  await expect(page.getByText('Performance by test section')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Weakness priorities' })).toBeVisible();
  await expect(page.getByText('LOCAL-ONLY · LIMITED EVIDENCE')).toBeVisible();
  await expect(page.getByText(/limited · 1\/\d+ used/)).toBeVisible();

  await page.getByRole('button', { name: 'Review test' }).click();
  await expect(page.getByText('SET RESULTS')).toBeVisible();
  await page.getByRole('button', { name: 'Review all questions' }).click();
  await expect(page.locator('.choice:disabled')).toHaveCount(4);
  await expect(page.locator('.question-map button.answered')).toHaveCount(1);
  await expect(page.locator('.question-map button.unanswered')).toHaveCount(2);
});
