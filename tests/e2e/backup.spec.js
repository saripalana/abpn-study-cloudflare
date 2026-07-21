import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('downloads a portable backup that excludes question-bank content', async ({ page }) => {
  await page.goto('/');
  const downloadButton = page.getByRole('button', { name: 'Download backup' });
  await expect(downloadButton).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  const backup = JSON.parse(await readFile(path, 'utf8'));

  expect(backup.format).toBe('abpn-study-local-backup');
  expect(backup.schemaVersion).toBe(1);
  expect(backup.questionContentIncluded).toBe(false);
  expect(backup.deviceSpecificSyncStateIncluded).toBe(false);
  expect(Array.isArray(backup.data.banks)).toBe(true);
  expect(Array.isArray(backup.data.progress)).toBe(true);
  expect(Array.isArray(backup.data.practiceSets)).toBe(true);
  expect(Array.isArray(backup.data.practiceSetAnswers)).toBe(true);
  expect(Array.isArray(backup.data.snapshots)).toBe(true);
  expect(JSON.stringify(backup.data)).not.toContain('"questions"');
});

test('restores non-destructively, preserves a newer local record, and preserves an active timer', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { STORES, putRecord } = await import('/client/storage.js');
    localStorage.setItem('abpn-study:selected-bank', 'validation-bank');
    await putRecord(STORES.PROGRESS, {
      bankId: 'validation-bank',
      questionId: 'validation-1',
      selectedAnswer: 'C',
      isCorrect: true,
      isFlagged: false,
      timesUsed: 5,
      totalTimeMs: 5000,
      revision: 5,
      updatedAt: '2026-07-21T12:00:00.000Z',
      deviceId: 'local-device'
    });
  });
  await page.reload();

  const backup = {
    format: 'abpn-study-local-backup',
    schemaVersion: 1,
    createdAt: '2026-07-21T13:00:00.000Z',
    appVersion: 'test',
    contentScope: 'local-study-records-only',
    questionContentIncluded: false,
    deviceSpecificSyncStateIncluded: false,
    data: {
      banks: [{ id: 'validation-bank', title: 'System Validation Question Bank', version: '1', questionCount: 3, updatedAt: '2026-07-21T13:00:00.000Z' }],
      progress: [
        {
          bankId: 'validation-bank', questionId: 'validation-1', selectedAnswer: 'A', isCorrect: false,
          isFlagged: true, timesUsed: 1, totalTimeMs: 100, revision: 4,
          updatedAt: '2026-07-22T12:00:00.000Z', deviceId: 'backup-device'
        },
        {
          bankId: 'validation-bank', questionId: 'validation-2', selectedAnswer: 'B', isCorrect: true,
          isFlagged: true, timesUsed: 1, totalTimeMs: 200, revision: 1,
          updatedAt: '2026-07-21T13:00:00.000Z', deviceId: 'backup-device'
        }
      ],
      practiceSets: [
        {
          id: 'restored-active-set', bankId: 'validation-bank', status: 'active', mode: 'test', timed: true,
          questionIds: ['validation-1', 'validation-2'], index: 1, remainingSeconds: 321,
          submitted: false, startedAt: '2026-07-21T12:30:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z'
        },
        {
          id: 'quarantined-set', bankId: 'validation-bank', status: 'completed', mode: 'tutor', timed: false,
          questionIds: ['missing-question'], index: 0, remainingSeconds: 0,
          submitted: true, startedAt: '2026-07-21T12:30:00.000Z', updatedAt: '2026-07-21T13:00:00.000Z'
        }
      ],
      practiceSetAnswers: [
        {
          setId: 'restored-active-set', questionId: 'validation-1', selectedAnswer: 'C', isCorrect: true,
          timeMs: 400, updatedAt: '2026-07-21T13:00:00.000Z'
        }
      ],
      snapshots: []
    },
    manifest: { banks: 1, progress: 2, practiceSets: 2, practiceSetAnswers: 1, snapshots: 0 }
  };

  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('#portableBackupImportInput').setInputFiles({
    name: 'abpn-study-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup))
  });
  await navigation;

  const restored = await page.evaluate(async () => {
    const { STORES, getAllRecords, getRecord } = await import('/client/storage.js');
    return {
      newerLocal: await getRecord(STORES.PROGRESS, ['validation-bank', 'validation-1']),
      importedProgress: await getRecord(STORES.PROGRESS, ['validation-bank', 'validation-2']),
      activeSet: await getRecord(STORES.SETS, 'restored-active-set'),
      invalidSet: await getRecord(STORES.SETS, 'quarantined-set'),
      answer: await getRecord(STORES.ANSWERS, ['restored-active-set', 'validation-1']),
      snapshots: await getAllRecords(STORES.SNAPSHOTS)
    };
  });

  expect(restored.newerLocal.revision).toBe(5);
  expect(restored.newerLocal.selectedAnswer).toBe('C');
  expect(restored.importedProgress.revision).toBe(1);
  expect(restored.importedProgress.isFlagged).toBe(true);
  expect(restored.activeSet.status).toBe('active');
  expect(restored.activeSet.remainingSeconds).toBe(321);
  expect(Date.parse(restored.activeSet.updatedAt)).toBeGreaterThan(Date.parse('2026-07-21T13:00:00.000Z'));
  expect(restored.invalidSet.status).toBe('invalid');
  expect(restored.invalidSet.invalidQuestionIds).toContain('missing-question');
  expect(restored.answer.selectedAnswer).toBe('C');
  expect(restored.snapshots.length).toBeGreaterThanOrEqual(1);
  expect(dialogs.some((message) => message.includes('newer local records are kept'))).toBe(true);
  expect(dialogs.some((message) => message.includes('Restore completed safely'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Restore backup' })).toBeVisible();
});
