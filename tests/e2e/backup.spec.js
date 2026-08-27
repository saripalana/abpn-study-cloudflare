import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('downloads one complete, integrity-protected recovery bundle', async ({ page }) => {
  await page.goto('/');
  const downloadButton = page.getByRole('button', { name: 'Download complete backup' });
  await expect(downloadButton).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const path = await (await downloadPromise).path();
  const backup = JSON.parse(await readFile(path, 'utf8'));

  expect(backup.format).toBe('abpn-study-complete-recovery');
  expect(backup.schemaVersion).toBe(1);
  expect(backup.integrity.algorithm).toBe('SHA-256');
  expect(backup.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(Array.isArray(backup.data.bankContent)).toBe(true);
  expect(Array.isArray(backup.data.bankRevisions)).toBe(true);
  expect(Array.isArray(backup.data.progress)).toBe(true);
  expect(Array.isArray(backup.data.practiceSets)).toBe(true);
  expect(Array.isArray(backup.data.practiceSetAnswers)).toBe(true);
  expect(backup.excludes).toContain('authentication');
  expect(backup.excludes).toContain('tokens');
  expect(backup.data.syncOutbox).toBeUndefined();
});

test('a bundle with IndexedDB structured-clone values survives JSON transport validation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { STORES, putRecord } = await import('/client/storage.js');
    const { createRecoveryBundle, validateRecoveryBundle } = await import('/client/recovery-bundle.js');
    await putRecord(STORES.META, {
      key: 'recovery-json-transport-regression',
      value: { omitted: undefined, array: [undefined], notANumber: Number.NaN },
    });
    const created = await createRecoveryBundle({ appVersion: 'e2e-json-transport' });
    const transported = JSON.parse(JSON.stringify(created));
    await validateRecoveryBundle(transported);
    const record = transported.data.metadata.find((item) => item.key === 'recovery-json-transport-regression');
    return { digest: transported.integrity.digest, value: record.value };
  });
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.value).toEqual({ array: [null], notANumber: null });
});

test('restores a complete bundle non-destructively and creates a safety snapshot', async ({ page }) => {
  await page.goto('/');
  const fixture = await page.evaluate(async () => {
    const { QUESTION_BANKS } = await import('/banks/catalog.js');
    const { STORES, putRecord, deleteRecord } = await import('/client/storage.js');
    const { createRecoveryBundle } = await import('/client/recovery-bundle.js');
    const bank = QUESTION_BANKS.find((item) => item.contentClass !== 'system-validation' && item.questions?.length);
    const questionId = bank.questions[0].id;
    const secondQuestionId = bank.questions[1].id;
    const setId = 'recovery-e2e-set';
    const startedAt = '2026-08-05T11:58:00.000Z';
    const completedAt = '2026-08-05T12:00:00.000Z';
    await putRecord(STORES.PROGRESS, {
      bankId: bank.id,
      questionId,
      selectedAnswer: 'A',
      isCorrect: false,
      timesUsed: 3,
      totalTimeMs: 4200,
      lastUsedAt: completedAt,
      revision: 1,
      updatedAt: completedAt,
    });
    await putRecord(STORES.SETS, {
      id: setId,
      bankId: bank.id,
      status: 'completed',
      mode: 'test',
      timed: true,
      questionIds: [questionId, secondQuestionId],
      index: 1,
      remainingSeconds: 0,
      submitted: true,
      startedAt,
      completedAt,
      updatedAt: completedAt,
    });
    await putRecord(STORES.ANSWERS, {
      setId,
      questionId,
      selectedAnswer: 'A',
      isCorrect: false,
      timeMs: 2100,
      updatedAt: completedAt,
    });
    await putRecord(STORES.ANSWERS, {
      setId,
      questionId: secondQuestionId,
      selectedAnswer: 'B',
      isCorrect: true,
      timeMs: 1800,
      updatedAt: completedAt,
    });
    const bundle = await createRecoveryBundle({ appVersion: 'e2e' });
    await deleteRecord(STORES.PROGRESS, [bank.id, questionId]);
    await deleteRecord(STORES.SETS, setId);
    await deleteRecord(STORES.ANSWERS, [setId, questionId]);
    await deleteRecord(STORES.ANSWERS, [setId, secondQuestionId]);
    return { bundle, bankId: bank.id, questionId, secondQuestionId, setId };
  });

  page.on('dialog', (dialog) => dialog.accept());
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('#portableBackupImportInput').setInputFiles({
    name: 'abpn-study-complete.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture.bundle)),
  });
  await navigation;

  const result = await page.evaluate(async ({ bankId, questionId, secondQuestionId, setId }) => {
    const { STORES, getAllRecords, getRecord } = await import('/client/storage.js');
    return {
      progress: await getRecord(STORES.PROGRESS, [bankId, questionId]),
      practiceSet: await getRecord(STORES.SETS, setId),
      firstAnswer: await getRecord(STORES.ANSWERS, [setId, questionId]),
      secondAnswer: await getRecord(STORES.ANSWERS, [setId, secondQuestionId]),
      snapshots: await getAllRecords(STORES.SNAPSHOTS),
    };
  }, fixture);
  expect(result.progress.revision).toBe(1);
  expect(result.progress.timesUsed).toBe(3);
  expect(result.progress.lastUsedAt).toBe('2026-08-05T12:00:00.000Z');
  expect(result.practiceSet.questionIds).toEqual([fixture.questionId, fixture.secondQuestionId]);
  expect(result.practiceSet.startedAt).toBe('2026-08-05T11:58:00.000Z');
  expect(result.practiceSet.completedAt).toBe('2026-08-05T12:00:00.000Z');
  expect(result.firstAnswer.isCorrect).toBe(false);
  expect(result.secondAnswer.isCorrect).toBe(true);
  expect(result.snapshots.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Restore downloaded backup' })).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(1);
});
