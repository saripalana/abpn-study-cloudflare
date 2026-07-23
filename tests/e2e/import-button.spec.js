import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const indexPath = new URL('../../public/index.html', import.meta.url);
const bridgePath = new URL('../../public/import-button-bridge.js', import.meta.url);

test('Import from file opens the native file chooser through one activation path', async ({ page }) => {
  test.setTimeout(20_000);

  const [indexHtml, bridgeSource] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(bridgePath, 'utf8'),
  ]);

  expect(indexHtml).toContain('id="importBankBtn"');
  expect(indexHtml).toContain('id="bankImportInput"');
  expect(indexHtml).toContain('src="/import-button-bridge.js"');

  await page.setContent(`
    <main id="app">
      <section class="loading-card">
        <button id="importBankBtn" class="secondary" type="button">Import from file</button>
      </section>
    </main>
    <input id="bankImportInput" type="file" accept="application/json,.json">
  `);
  await page.evaluate((source) => {
    (0, eval)(source);
  }, bridgeSource);

  const button = page.locator('#importBankBtn');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Import from file');

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
  await button.click();
  const chooser = await chooserPromise;

  expect(chooser.isMultiple()).toBe(false);
  await expect(page.locator('#bankImportInput')).toHaveAttribute('accept', /json/);
  expect(await page.evaluate(() => window.__ABPN_IMPORT_BUTTON_BRIDGE__?.ready)).toBe(true);
});
