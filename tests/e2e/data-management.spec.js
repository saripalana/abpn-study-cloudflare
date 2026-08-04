import { test, expect } from '@playwright/test';

async function useValidationBank(page) {
  await page.goto('/');
  await page.locator('#bankSelect').selectOption('validation-bank');
  await expect(page.getByRole('heading', { name: 'System Validation Question Bank' })).toBeVisible();
}

async function clickThroughDialogsAndReload(page, locator, { promptValue = null } = {}) {
  const messages = [];
  const handler = async (dialog) => {
    messages.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === 'prompt') await dialog.accept(promptValue ?? '');
    else await dialog.accept();
  };
  page.on('dialog', handler);
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      locator.click(),
    ]);
  } finally {
    page.off('dialog', handler);
  }
  return messages;
}

test('deletes a completed test from History and restores it with Undo', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('1');
  await page.locator('#modeSelect').selectOption('tutor');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start set' }).click();
  await page.locator('.choice').first().click();

  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Submit set' }).click();
  await page.getByRole('button', { name: 'Back to dashboard' }).click();

  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Delete test' })).toBeVisible();
  const deleteMessages = await clickThroughDialogsAndReload(
    page,
    page.getByRole('button', { name: 'Delete test' })
  );
  expect(deleteMessages.some(({ message }) => message.includes('Cumulative question performance'))).toBe(true);
  expect(deleteMessages.some(({ type }) => type === 'alert')).toBe(true);

  await expect(page.locator('.history-item')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo last deletion/reset' })).toBeVisible();
  const undoMessages = await clickThroughDialogsAndReload(
    page,
    page.getByRole('button', { name: 'Undo last deletion/reset' })
  );
  expect(undoMessages.some(({ message }) => message.includes('merged back without overwriting newer local records'))).toBe(true);

  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Undo last deletion/reset' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review test' }).click();
  await expect(page.getByText('SET RESULTS')).toBeVisible();
});

test('discards an active set and restores its answers with Undo', async ({ page }) => {
  await useValidationBank(page);
  await page.locator('#countInput').fill('2');
  await page.locator('#modeSelect').selectOption('tutor');
  await page.locator('#timingSelect').selectOption('untimed');
  await page.getByRole('button', { name: 'Start set' }).click();
  await page.locator('.choice').first().click();
  await page.getByRole('button', { name: 'Save and exit' }).click();

  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard active set' })).toBeVisible();
  await clickThroughDialogsAndReload(page, page.getByRole('button', { name: 'Discard active set' }));

  await expect(page.getByRole('heading', { name: 'Resume active set' })).toHaveCount(0);
  await clickThroughDialogsAndReload(page, page.getByRole('button', { name: 'Undo last deletion/reset' }));

  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume set' }).click();
  await expect(page.locator('.question-map button.answered')).toHaveCount(1);
  await expect(page.locator('.question-map button.unanswered')).toHaveCount(1);
});

test('resets only the selected deck and restores progress history and active sets', async ({ page }) => {
  await useValidationBank(page);
  await page.evaluate(async () => {
    const { QUESTION_BANKS } = await import('/banks/catalog.js');
    const { STORES, putRecord, updateQuestionProgress } = await import('/client/storage.js');
    const validation = QUESTION_BANKS.find((bank) => bank.id === 'validation-bank');
    const ks = QUESTION_BANKS.find((bank) => bank.id === 'ks-psychiatry-core');
    const now = new Date().toISOString();

    await updateQuestionProgress({
      bankId: validation.id,
      questionId: validation.questions[0].id,
      deviceId: 'reset-test-device',
      patch: {
        selectedAnswer: validation.questions[0].correctLetter,
        isCorrect: true,
        isFlagged: true,
        timesUsed: 1,
        totalTimeMs: 1200,
        lastUsedAt: now,
      },
    });
    await updateQuestionProgress({
      bankId: ks.id,
      questionId: ks.questions[0].id,
      deviceId: 'reset-test-device',
      patch: {
        selectedAnswer: ks.questions[0].correctLetter,
        isCorrect: true,
        isFlagged: false,
        timesUsed: 1,
        totalTimeMs: 900,
        lastUsedAt: now,
      },
    });

    await putRecord(STORES.SETS, {
      id: 'validation-active-reset-test',
      bankId: validation.id,
      status: 'active',
      mode: 'tutor',
      timed: false,
      questionIds: validation.questions.slice(0, 2).map((question) => question.id),
      index: 0,
      remainingSeconds: 0,
      submitted: false,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });
    await putRecord(STORES.ANSWERS, {
      setId: 'validation-active-reset-test',
      questionId: validation.questions[0].id,
      selectedAnswer: validation.questions[0].correctLetter,
      isCorrect: true,
      timeMs: 1200,
      updatedAt: now,
    });
    await putRecord(STORES.SETS, {
      id: 'validation-completed-reset-test',
      bankId: validation.id,
      status: 'completed',
      mode: 'test',
      timed: false,
      questionIds: [validation.questions[0].id],
      index: 0,
      remainingSeconds: 0,
      submitted: true,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    await putRecord(STORES.ANSWERS, {
      setId: 'validation-completed-reset-test',
      questionId: validation.questions[0].id,
      selectedAnswer: validation.questions[0].correctLetter,
      isCorrect: true,
      timeMs: 1200,
      updatedAt: now,
    });
  });
  await page.reload();

  await expect(page.locator('.stat').filter({ hasText: 'Used' }).locator('strong')).toHaveText('1');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();

  const resetMessages = await clickThroughDialogsAndReload(
    page,
    page.getByRole('button', { name: 'Reset current deck' }),
    { promptValue: 'RESET' }
  );
  expect(resetMessages.map(({ type }) => type)).toEqual(['confirm', 'prompt', 'alert']);
  expect(resetMessages.some(({ message }) => message.includes('other decks'))).toBe(true);

  await expect(page.locator('.stat').filter({ hasText: 'Used' }).locator('strong')).toHaveText('0');
  await expect(page.locator('.history-item')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toHaveCount(0);

  await page.locator('#bankSelect').selectOption('ks-psychiatry-core');
  await expect(page.locator('.stat').filter({ hasText: 'Used' }).locator('strong')).toHaveText('1');
  await page.locator('#bankSelect').selectOption('validation-bank');

  await clickThroughDialogsAndReload(page, page.getByRole('button', { name: 'Undo last deletion/reset' }));
  await expect(page.locator('.stat').filter({ hasText: 'Used' }).locator('strong')).toHaveText('1');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Resume active set' })).toBeVisible();
  await expect(page.locator('.stat').filter({ hasText: 'Flagged' }).locator('strong')).toHaveText('1');
});
