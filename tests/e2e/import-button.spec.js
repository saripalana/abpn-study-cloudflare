import { test, expect } from '@playwright/test';

test('Import from file opens the native file chooser through one activation path', async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  const button = page.getByRole('button', { name: 'Import from file' });
  await expect(button).toBeVisible();

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
  await button.click();
  const chooser = await chooserPromise;

  expect(chooser.isMultiple()).toBe(false);
  await expect(page.locator('#bankImportInput')).toHaveAttribute('accept', /json/);
  expect(await page.evaluate(() => window.__ABPN_IMPORT_BUTTON_BRIDGE__?.ready)).toBe(true);
});
