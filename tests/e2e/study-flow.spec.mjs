import { test, expect } from '@playwright/test';

async function useValidationBank(page) {
  await page.goto('/');
  await expect(page.getByText('ABPN PSYCHIATRY STUDY')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import from file' })).toBeEnabled();
  await page.locator('#bankSelect').selectOption('validation-bank');
  await expect(page.getByRole('heading', { name: 'System Validation Question Bank' })).toBeVisible();
}

test('question order defaults to random for All and sequential for filtered pools', async ({ page }) => {
  await useValidationBank(page);
  const order = page.getByLabel('Randomize question order');
  await expect(order).toBeChecked();
  await page.locator('#poolSelect').selectOption('new');
  await expect(order).not.toBeChecked();
  await order.check();
  await expect(order).toBeChecked();
  await page.locator('#poolSelect').selectOption('all');
  await expect(order).toBeChecked();
});

test('filters a practice set by subjects and remembers builder choices per bank', async ({ page }) => {
  await useValidationBank(page);
  await expect(page.locator('#eligibleCount')).toContainText('3 questions available');

  await page.locator('#subjectPicker summary').click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#eligibleCount')).toContainText('No questions match');
  await expect(page.getByRole('button', { name: 'Start set' })).toBeDisabled();

  await page.locator('input[name="subjectFilter"][value="Question Banks"]').check();
  await expect(page.locator('#eligibleCount')).toContainText('1 question available');
  await expect(page.locator('#countInput')).toHaveValue('1');
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(page.locator('#countInput')).toHaveValue('3');
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.locator('input[name="subjectFilter"][value="Question Banks"]').check();
  await page.locator('#countInput').fill('1');
  await page.locator('#modeSelect').selectOption('tutor');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.locator('#poolSelect').selectOption('new');

  await page.reload();
  await expect(page.locator('#bankSelect')).toHaveValue('validation-bank');
  await expect(page.locator('#countInput')).toHaveValue('1');
  await expect(page.locator('#modeSelect')).toHaveValue('tutor');
  await expect(page.locator('#timingSelect')).toHaveValue('untimed');
  await expect(page.locator('#poolSelect')).toHaveValue('new');
  await expect(page.locator('input[name="subjectFilter"][value="Application Safety"]')).not.toBeChecked();
  await expect(page.locator('input[name="subjectFilter"][value="Question Banks"]')).toBeChecked();

  await page.getByRole('button', { name: 'Start set' }).click();
  await expect(page.getByText('How should progress from two different question banks be stored?')).toBeVisible();
  await page.getByRole('button', { name: 'Save and exit' }).click();

  await page.locator('#bankSelect').selectOption('ks-psychiatry-core');
  await expect(page.getByRole('heading', { name: 'K&S Psychiatry Question Bank' })).toBeVisible();
  await expect(page.locator('#modeSelect')).toHaveValue('test');
  await expect(page.locator('#timingSelect')).toHaveValue('timed');
  await expect(page.locator('#poolSelect')).toHaveValue('all');
  await expect(page.locator('input[name="subjectFilter"]:checked')).toHaveCount(34);
  await page.locator('#poolSelect').selectOption('flagged');
  await page.locator('#subjectPicker summary').click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.locator('input[name="subjectFilter"]').first().check();

  await page.locator('#bankSelect').selectOption('validation-bank');
  await expect(page.locator('#poolSelect')).toHaveValue('new');
  await expect(page.locator('input[name="subjectFilter"][value="Question Banks"]')).toBeChecked();
  await page.locator('#bankSelect').selectOption('ks-psychiatry-core');
  await expect(page.locator('#poolSelect')).toHaveValue('flagged');
  await expect(page.locator('input[name="subjectFilter"]:checked')).toHaveCount(1);
});

test('ignores malformed builder settings instead of blocking dashboard startup', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('abpn-study:builder-settings:validation-bank', 'null'));
  await page.locator('#bankSelect').selectOption('validation-bank');
  await expect(page.getByRole('heading', { name: 'System Validation Question Bank' })).toBeVisible();
  await expect(page.locator('#poolSelect')).toHaveValue('all');
  await expect(page.locator('input[name="subjectFilter"]:checked')).toHaveCount(2);

  await page.locator('#countInput').fill('0');
  await page.locator('#countInput').press('Tab');
  await expect(page.locator('#countInput')).toHaveValue('1');
  await page.locator('#countInput').fill('2.5');
  await page.locator('#countInput').press('Tab');
  await expect(page.locator('#countInput')).toHaveValue('2');
});

test('combines subject selection with wrong and flagged pools in the live builder', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#subjectPicker summary').click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.locator('input[name="subjectFilter"][value="Application Safety"]').check();
  await page.locator('#countInput').fill('2');
  await page.locator('#modeSelect').selectOption('tutor');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start set' }).click();

  await page.locator('.choice').first().click();
  await page.getByRole('button', { name: 'Flag question' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('.choice').first().click();
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Submit set' }).click();
  await page.getByRole('button', { name: 'Back to dashboard' }).click();

  await page.locator('#poolSelect').selectOption('incorrect');
  await expect(page.locator('#eligibleCount')).toContainText('2 questions available');
  await page.locator('#poolSelect').selectOption('flagged');
  await expect(page.locator('#eligibleCount')).toContainText('1 question available');
  await page.locator('#subjectPicker summary').click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.locator('input[name="subjectFilter"][value="Question Banks"]').check();
  await expect(page.locator('#eligibleCount')).toContainText('No questions match');
  await expect(page.getByRole('button', { name: 'Start set' })).toBeDisabled();
});

test('offers a Used pool after a question has been completed', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('1');
  await page.locator('#modeSelect').selectOption('tutor');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start set' }).click();
  await page.locator('.choice').first().click();

  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Submit set' }).click();
  await page.getByRole('button', { name: 'Back to dashboard' }).click();
  await page.locator('#poolSelect').selectOption('used');
  await expect(page.locator('#eligibleCount')).toContainText('1 question available');
});

test('test-mode set restores question, answers, and results after reload', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('2');
  await page.locator('#modeSelect').selectOption('test');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start set' }).click();

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
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('2 answered');
    expect(dialog.message()).toContain('0 unanswered');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Submit set' }).click();
  await expect(page.getByText('SET RESULTS')).toBeVisible();
  await expect(page.getByText(/2 answered · 0 omitted/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Create practice set' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'History / Previous tests' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toHaveCount(0);
  await expect(page.locator('.history-item')).toHaveCount(1);
});

test('tutor mode reveals feedback immediately and records analytics', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('1');
  await page.locator('#modeSelect').selectOption('tutor');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start set' }).click();
  await page.locator('.choice').first().click();
  await expect(page.locator('.explanation')).toBeVisible();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(page.getByRole('columnheader', { name: 'Category' })).toBeVisible();
});

test('timed set continues counting down across reload', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('1');
  await page.locator('#modeSelect').selectOption('test');
  await page.locator('#timingSelect').selectOption('timed');
  await page.getByRole('button', { name: 'Start set' }).click();

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
  await page.getByRole('button', { name: 'Start set' }).click();
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
  await page.locator('#subjectPicker summary').click();

  const dashboard = await page.evaluate(() => {
    const countInput = document.querySelector('#countInput');
    const bankSelect = document.querySelector('#bankSelect');
    const startButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Start set'));
    return {
      userAgent: navigator.userAgent,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      inputFontSize: Number.parseFloat(getComputedStyle(countInput).fontSize),
      inputHeight: countInput.getBoundingClientRect().height,
      selectHeight: bankSelect.getBoundingClientRect().height,
      startHeight: startButton.getBoundingClientRect().height,
      subjectOptionHeights: [...document.querySelectorAll('.subject-option')]
        .map((option) => option.getBoundingClientRect().height),
      subjectToolbarHeights: [...document.querySelectorAll('.subject-toolbar button')]
        .map((button) => button.getBoundingClientRect().height),
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
  expect(Math.min(...dashboard.subjectOptionHeights)).toBeGreaterThanOrEqual(44);
  expect(Math.min(...dashboard.subjectToolbarHeights)).toBeGreaterThanOrEqual(44);
  expect(dashboard.viewportMeta).toContain('viewport-fit=cover');

  await page.locator('#countInput').fill('1');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start set' }).tap();
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
