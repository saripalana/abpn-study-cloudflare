import { test, expect } from "@playwright/test";

test("test-day countdown saves locally and remains usable after reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /test day/i }).click();
  await page.getByLabel("Test date").fill("2030-12-31");
  await page.getByRole("button", { name: "Save date" }).click();
  await expect(page.locator("#examCountdownValue")).not.toHaveText("Set test date");
  await page.reload();
  await expect(page.locator("#examCountdownDate")).toContainText("2030");
});
