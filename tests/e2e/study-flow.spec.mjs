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

test('iPhone Safari layout avoids overflow and iOS input zoom', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone-13-safari', 'iPhone-specific WebKit validation');
  await useValidationBank(page);

  const dashboard = await page.evaluate(() => {
    const countInput = document.querySelector('#countInput');
    const bankSelect = document.querySelector('#bankSelect');
    const startButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Start randomized set'));
    return {
      userAgent: navigator.userAgent,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      inputFontSize: Number.parseFloat(getComputedStyle(countInput).fontSize),
      inputHeight: countInput.getBoundingClientRect().height,
      selectHeight: bankSelect.getBoundingClientRect().height,
      startHeight: startButton.getBoundingClientRect().height,
      viewportMeta: document.querySelector('meta[name="viewport"]')?.content || ''
    };
  });

  expect(dashboard.userAgent).toContain('iPhone');
  expect(dashboard.innerWidth).toBeGreaterThanOrEqual(375);
  expect(dashboard.innerWidth).toBeLessThanOrEqual(430);
  expect(dashboard.scrollWidth).toBeLessThanOrEqual(dashboard.innerWidth + 1);
  expect(dashboard.inputFontSize).toBeGreaterThanOrEqual(16);
  expect(dashboard.inputHeight).toBeGreaterThanOrEqual(44);
  expect(dashboard.selectHeight).toBeGreaterThanOrEqual(44);
  expect(dashboard.startHeight).toBeGreaterThanOrEqual(44);
  expect(dashboard.viewportMeta).toContain('viewport-fit=cover');

  await page.locator('#countInput').fill('1');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start randomized set' }).tap();
  await expect(page.getByRole('heading', { name: 'Question 1 of 1' })).toBeVisible();

  const exam = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    choiceHeights: [...document.querySelectorAll('.choice')].map((choice) => choice.getBoundingClientRect().height),
    mapHeights: [...document.querySelectorAll('.question-map button')].map((button) => button.getBoundingClientRect().height)
  }));
  expect(exam.scrollWidth).toBeLessThanOrEqual(exam.innerWidth + 1);
  expect(Math.min(...exam.choiceHeights)).toBeGreaterThanOrEqual(44);
  expect(Math.min(...exam.mapHeights)).toBeGreaterThanOrEqual(44);
});
