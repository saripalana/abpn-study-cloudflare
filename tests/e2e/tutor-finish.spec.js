import { test, expect } from '@playwright/test';

test('Tutor mode finishes on the last question without double-counting progress', async ({ page }) => {
  await page.goto('/');

  await page.selectOption('#bankSelect', 'validation-bank');
  await page.locator('#countInput').fill('3');
  await page.selectOption('#modeSelect', 'tutor');
  await page.selectOption('#timingSelect', 'untimed');
  await page.selectOption('#poolSelect', 'all');
  await page.locator('#startBtn').click();

  for (let index = 0; index < 3; index += 1) {
    await page.locator('.choice').first().click();
    await expect(page.locator('.explanation')).toBeVisible();

    if (index < 2) {
      await expect(page.locator('#nextBtn')).toBeEnabled();
      await page.locator('#nextBtn').click();
    }
  }

  await expect(page.locator('#finishSetBtn')).toHaveText('Finish set');
  await expect(page.locator('#nextBtn')).toHaveCount(0);
  await page.locator('#finishSetBtn').click();

  await expect(page.getByText('SET RESULTS')).toBeVisible();

  const stored = await page.evaluate(async () => {
    const { STORES, getAllRecords, recordsByIndex } = await import('/client/storage.js');
    const progress = await recordsByIndex(STORES.PROGRESS, 'byBank', 'validation-bank');
    const sets = await getAllRecords(STORES.SETS);
    return {
      progress: progress.map((record) => ({
        questionId: record.questionId,
        timesUsed: record.timesUsed,
        totalTimeMs: record.totalTimeMs,
      })),
      completedSet: sets.find((set) => set.bankId === 'validation-bank' && set.status === 'completed'),
    };
  });

  expect(stored.progress).toHaveLength(3);
  expect(stored.progress.every((record) => record.timesUsed === 1)).toBe(true);
  expect(stored.completedSet?.submitted).toBe(true);

  await page.locator('#finishBtn').click();
  await expect(page.getByText('Resume active set')).toHaveCount(0);
  await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
});
