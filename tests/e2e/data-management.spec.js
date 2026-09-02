import { test, expect } from '@playwright/test';
import { selectActiveBank } from './helpers/active-bank.mjs';

async function useValidationBank(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import from file' })).toBeEnabled();
  await selectActiveBank(page, 'validation-bank');
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

  await expect(page.getByRole('heading', { name: 'Pending tests' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard test' })).toBeVisible();
  await clickThroughDialogsAndReload(page, page.getByRole('button', { name: 'Discard test' }));

  await expect(page.getByRole('heading', { name: 'Pending tests' })).toHaveCount(0);
  await clickThroughDialogsAndReload(page, page.getByRole('button', { name: 'Undo last deletion/reset' }));

  await expect(page.getByRole('heading', { name: 'Pending tests' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume set' }).click();
  await expect(page.locator('.question-map button.answered')).toHaveCount(1);
  await expect(page.locator('.question-map button.unanswered')).toHaveCount(1);
});

test('discards only the selected pending test and restores it without disturbing another', async ({ page }) => {
  await useValidationBank(page);
  await selectActiveBank(page, 'ks-psychiatry-core');
  await page.evaluate(async () => {
    const { QUESTION_BANKS } = await import('/banks/catalog.js');
    const { STORES, putRecord } = await import('/client/storage.js');
    const { createMultiDeckSetRecord } = await import('/client/multi-deck-set.js');
    const { encodeQuestionRef } = await import('/client/multi-deck-practice.js');
    const ks = QUESTION_BANKS.find((bank) => bank.id === 'ks-psychiatry-core');
    const spiegel = QUESTION_BANKS.find((bank) => bank.id === 'spiegel-test-prep');
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const ksReference = encodeQuestionRef(ks.id, ks.questions[0].id);
    const spiegelReference = encodeQuestionRef(spiegel.id, spiegel.questions[0].id);

    await putRecord(STORES.SETS, {
      id: 'pending-test-to-keep',
      bankId: ks.id,
      status: 'active',
      mode: 'tutor',
      timed: false,
      questionIds: [ks.questions[1].id],
      index: 0,
      remainingSeconds: 0,
      submitted: false,
      startedAt: earlier,
      completedAt: null,
      updatedAt: earlier,
    });
    await putRecord(STORES.SETS, createMultiDeckSetRecord({
      id: 'pending-test-to-discard',
      selectedBankIds: [ks.id, spiegel.id],
      references: [ksReference, spiegelReference],
      status: 'active',
      mode: 'test',
      timed: false,
      index: 1,
      remainingSeconds: 0,
      submitted: false,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    }));
    await putRecord(STORES.ANSWERS, {
      setId: 'pending-test-to-discard',
      questionId: ksReference,
      selectedAnswer: ks.questions[0].correctLetter,
      isCorrect: true,
      timeMs: 1200,
      updatedAt: now,
    });
  });
  await page.reload();

  const pending = page.locator('.pending-set-item');
  await expect(pending).toHaveCount(2);
  const target = pending.filter({ hasText: '1/2' });
  await clickThroughDialogsAndReload(page, target.getByRole('button', { name: 'Discard test' }));

  await expect(pending).toHaveCount(1);
  await expect(pending.filter({ hasText: '0/1' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Resume set' }).click();
  await expect(page.locator('.question-map button.unanswered')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save and exit' }).click();

  await clickThroughDialogsAndReload(page, page.getByRole('button', { name: 'Undo last deletion/reset' }));
  await expect(pending).toHaveCount(2);
  await expect(pending.filter({ hasText: '1/2' })).toHaveCount(1);
  await expect(pending.filter({ hasText: '0/1' })).toHaveCount(1);
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
  await expect(page.getByRole('heading', { name: 'Pending tests' })).toBeVisible();

  const resetMessages = await clickThroughDialogsAndReload(
    page,
    page.getByRole('button', { name: 'Reset current deck' }),
    { promptValue: 'RESET' }
  );
  expect(resetMessages.map(({ type }) => type)).toEqual(['confirm', 'prompt', 'alert']);
  expect(resetMessages.some(({ message }) => message.includes('other decks'))).toBe(true);

  await expect(page.locator('.stat').filter({ hasText: 'Used' }).locator('strong')).toHaveText('0');
  await expect(page.locator('.history-item')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Pending tests' })).toHaveCount(0);

  await selectActiveBank(page, 'ks-psychiatry-core');
  await expect(page.locator('.stat').filter({ hasText: 'Used' }).locator('strong')).toHaveText('1');
  await selectActiveBank(page, 'validation-bank');

  await clickThroughDialogsAndReload(page, page.getByRole('button', { name: 'Undo last deletion/reset' }));
  await expect(page.locator('.stat').filter({ hasText: 'Used' }).locator('strong')).toHaveText('1');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Pending tests' })).toBeVisible();
  await expect(page.locator('.stat').filter({ hasText: 'Flagged' }).locator('strong')).toHaveText('1');
});
