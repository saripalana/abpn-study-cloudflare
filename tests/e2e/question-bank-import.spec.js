import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function question(id, text, correctLetter = 'B') {
  return {
    id,
    chapterTitle: 'Imported Deck Validation',
    question: text,
    choices: ['First option', 'Second option', 'Third option', 'Fourth option'],
    choiceLetters: ['A', 'B', 'C', 'D'],
    correctLetter,
    explanation: `${correctLetter} is the validated answer.`
  };
}

function packageData({
  id = 'browser-import-bank',
  version = '1.0.0',
  questions = [
    question('browser-import-1', 'Which option validates imported question one?'),
    question('browser-import-2', 'Which option validates imported question two?')
  ]
} = {}) {
  return {
    format: 'abpn-question-bank',
    schemaVersion: 1,
    bank: {
      id,
      title: 'Browser Imported Deck',
      shortTitle: 'Imported Deck',
      description: 'A package used to validate persistent additional-deck support.',
      version,
      sourceType: 'user-imported',
      contentClass: 'source-material',
      sourceLabel: 'Playwright import fixture',
      questions
    }
  };
}

async function importPackageThroughButton(page, data, filename = 'deck.json') {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add deck from file' }).click();
  const chooser = await fileChooserPromise;
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await chooser.setFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data))
  });
  await navigation;
}

test('adds, studies, updates, exports, and reloads a separate deck', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'K&S Psychiatry Question Bank' })).toBeVisible();
  await expect(page.locator('#importBankBtn')).toHaveJSProperty('tagName', 'BUTTON');
  await expect(page.locator('#importBankBtn')).toHaveAttribute('aria-controls', 'bankImportInput');
  await expect(page.locator('#bankImportInput')).not.toHaveAttribute('hidden', '');
  await importPackageThroughButton(page, packageData());

  await expect(page.locator('#bankSelect')).toHaveValue('browser-import-bank');
  await expect(page.getByRole('heading', { name: 'Browser Imported Deck' })).toBeVisible();
  await expect(page.getByText('Source deck')).toBeVisible();
  await expect(page.getByText('Playwright import fixture')).toBeVisible();
  await expect(page.getByText('2 questions loaded.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download deck package' })).toBeVisible();
  expect(dialogs.some((message) => message.includes('separate from every other deck'))).toBe(true);

  await page.locator('#countInput').fill('1');
  await page.selectOption('#modeSelect', 'tutor');
  await page.selectOption('#timingSelect', 'untimed');
  await page.getByRole('button', { name: 'Start randomized set' }).click();
  await page.locator('.choice').nth(1).click();
  await page.getByRole('button', { name: 'Submit set' }).click();
  await expect(page.getByText('SET RESULTS')).toBeVisible();
  await page.getByRole('button', { name: 'Back to dashboard' }).click();
  await expect(page.locator('.history-item')).toHaveCount(1);

  const additive = packageData({
    version: '1.1.0',
    questions: [
      ...packageData().bank.questions,
      question('browser-import-3', 'Which option validates an additive update?', 'A')
    ]
  });
  await importPackageThroughButton(page, additive, 'deck-v1.1.json');
  await expect(page.locator('#bankSelect')).toHaveValue('browser-import-bank');
  await expect(page.getByText('3 questions loaded.', { exact: false })).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(1);
  expect(dialogs.some((message) => message.includes('New questions added: 1'))).toBe(true);

  const packageDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download deck package' }).click();
  const downloadedPackage = await packageDownload;
  const packagePath = await downloadedPackage.path();
  const exported = JSON.parse(await readFile(packagePath, 'utf8'));
  expect(exported.format).toBe('abpn-question-bank');
  expect(exported.bank.id).toBe('browser-import-bank');
  expect(exported.bank.version).toBe('1.1.0');
  expect(exported.bank.questions).toHaveLength(3);
  expect(exported.bank.contentClass).toBe('source-material');

  const backupDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const downloadedBackup = await backupDownload;
  const backupPath = await downloadedBackup.path();
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup.questionContentIncluded).toBe(false);
  expect(JSON.stringify(backup.data)).not.toContain('"questions"');
  expect(backup.data.banks.some((bank) => bank.id === 'browser-import-bank')).toBe(true);

  await page.reload();
  await expect(page.locator('#bankSelect')).toHaveValue('browser-import-bank');
  await expect(page.getByText('3 questions loaded.', { exact: false })).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(1);
  await page.selectOption('#bankSelect', 'ks-psychiatry-core');
  await expect(page.getByRole('heading', { name: 'K&S Psychiatry Question Bank' })).toBeVisible();
  await expect(page.getByText('Source deck')).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(0);
});

test('prevents same-version content from silently replacing an existing deck', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.goto('/');
  const collision = packageData({ id: 'validation-bank', version: '1.0.0' });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add deck from file' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'same-version-collision.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(collision))
  });

  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(dialogs.some((message) => /content changed without a new bank version/i.test(message))).toBe(true);
  await expect(page.locator('#bankSelect option')).toHaveCount(2);
  await page.selectOption('#bankSelect', 'validation-bank');
  await expect(page.getByRole('heading', { name: 'System Validation Question Bank' })).toBeVisible();
  await expect(page.getByText('3 questions loaded.', { exact: false })).toBeVisible();
});

test('real add-deck button survives dashboard replacement and opens the native picker', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto('/');
  await expect(page.locator('#importBankBtn')).toHaveJSProperty('tagName', 'BUTTON');
  await expect(page.locator('#importBankBtn')).toHaveAttribute('aria-controls', 'bankImportInput');

  await page.evaluate(() => {
    const current = document.getElementById('importBankBtn');
    const replacement = document.createElement('button');
    replacement.id = 'importBankBtn';
    replacement.className = 'secondary';
    replacement.type = 'button';
    replacement.textContent = 'Add deck from file';
    replacement.onclick = () => alert('stale placeholder handler');
    current.replaceWith(replacement);
  });

  await expect(page.locator('#importBankBtn')).toHaveAttribute('aria-controls', 'bankImportInput');
  await expect(page.locator('#importBankBtn')).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(page.getByRole('button', { name: 'Add deck from file' })).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add deck from file' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([]);
  expect(dialogs).toHaveLength(0);
});
