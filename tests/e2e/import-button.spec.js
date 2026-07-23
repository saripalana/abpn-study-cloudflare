import { test, expect } from '@playwright/test';

test('Import question bank opens the native file chooser through one activation path', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Import (question bank|from file)/i })).toBeVisible();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Import (question bank|from file)/i }).click();
  const chooser = await chooserPromise;

  expect(chooser.isMultiple()).toBe(false);
  await expect(page.locator('#bankImportInput')).toHaveAttribute('accept', /json/);
  expect(await page.evaluate(() => window.__ABPN_IMPORT_BUTTON_BRIDGE__?.ready)).toBe(true);
});
