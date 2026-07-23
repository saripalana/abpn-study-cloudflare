import { test, expect } from '@playwright/test';

test('Import from file opens the native file chooser through one activation path', async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Import from file' });
  await expect(button).toBeVisible();

  const chooser = await Promise.race([
    page.waitForEvent('filechooser'),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Import from file did not open the native file chooser within 15 seconds')),
      15_000,
    )),
    button.click().then(() => new Promise(() => {})),
  ]);

  expect(chooser.isMultiple()).toBe(false);
  await expect(page.locator('#bankImportInput')).toHaveAttribute('accept', /json/);
  expect(await page.evaluate(() => window.__ABPN_IMPORT_BUTTON_BRIDGE__?.ready)).toBe(true);
});
