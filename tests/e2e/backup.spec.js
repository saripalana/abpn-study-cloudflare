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
    const bank = QUESTION_BANKS.find((item) => item.questions?.length);
    const questionId = bank.questions[0].id;
    await putRecord(STORES.PROGRESS, {
      bankId: bank.id,
      questionId,
      selectedAnswer: 'A',
      revision: 1,
      updatedAt: '2026-08-05T12:00:00.000Z',
    });
    const bundle = await createRecoveryBundle({ appVersion: 'e2e' });
    await deleteRecord(STORES.PROGRESS, [bank.id, questionId]);
    return { bundle, bankId: bank.id, questionId };
  });

  page.on('dialog', (dialog) => dialog.accept());
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('#portableBackupImportInput').setInputFiles({
    name: 'abpn-study-complete.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture.bundle)),
  });
  await navigation;

  const result = await page.evaluate(async ({ bankId, questionId }) => {
    const { STORES, getAllRecords, getRecord } = await import('/client/storage.js');
    return {
      progress: await getRecord(STORES.PROGRESS, [bankId, questionId]),
      snapshots: await getAllRecords(STORES.SNAPSHOTS),
    };
  }, fixture);
  expect(result.progress.revision).toBe(1);
  expect(result.snapshots.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Restore downloaded backup' })).toBeVisible();
});
