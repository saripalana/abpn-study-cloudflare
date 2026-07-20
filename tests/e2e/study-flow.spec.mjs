import { test, expect } from '@playwright/test';

async function useValidationBank(page) {
  await page.goto('/');
  await expect(page.getByText('ABPN PSYCHIATRY STUDY')).toBeVisible();
  await page.locator('#bankSelect').selectOption('validation-bank');
  await expect(page.getByRole('heading', { name: 'System Validation Question Bank' })).toBeVisible();
}

test('test-mode set restores question, answers, and results after reload', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('2');
  await page.locator('#modeSelect').selectOption('test');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start randomized set' }).click();

  await expect(page.getByRole('heading', { name: 'Question 1 of 2' })).toBeVisible();
  await page.locator('.choice').first().click();
  await expect(page.locator('.explanation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Question 2 of 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume set' }).click();
  await expect(page.getByRole('heading', { name: 'Question 2 of 2' })).toBeVisible();
  await expect(page.locator('.question-map button').first()).toHaveClass(/answered/);

  await page.locator('.choice').first().click();
  await page.getByRole('button', { name: 'Submit set' }).click();
  await expect(page.locator('.explanation')).toBeVisible();
  await page.getByRole('button', { name: 'View results' }).click();
  await expect(page.getByText(/answered · 0 omitted/)).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('heading', { name: 'Create practice set' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toHaveCount(0);
});

test('tutor mode reveals feedback immediately and records analytics', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('1');
  await page.locator('#modeSelect').selectOption('tutor');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start randomized set' }).click();
  await page.locator('.choice').first().click();
  await expect(page.locator('.explanation')).toBeVisible();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(page.locator('.summary-table')).toBeVisible();
});

test('timed set continues counting down across reload', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('1');
  await page.locator('#modeSelect').selectOption('test');
  await page.locator('#timingSelect').selectOption('timed');
  await page.getByRole('button', { name: 'Start randomized set' }).click();

  const before = await page.locator('#timer').textContent();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Resume set' }).click();
  const after = await page.locator('#timer').textContent();

  const toSeconds = (value) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  expect(toSeconds(after)).toBeLessThan(toSeconds(before));
});

test('bank switching does not expose another bank active set', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('1');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start randomized set' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();

  await page.locator('#bankSelect').selectOption('ks-psychiatry-core');
  await expect(page.getByRole('heading', { name: 'K&S Psychiatry Question Bank' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toHaveCount(0);

  await page.locator('#bankSelect').selectOption('validation-bank');
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();
});
