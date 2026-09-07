// Exercise status-only improvements against isolated browser data and fake APIs.
import { test, expect } from "@playwright/test";

test("Sync reports capped pending work, preserves it on reload, then drains it", async ({ page }) => {
  let releaseFirstPush;
  const firstPush = new Promise((resolve) => { releaseFirstPush = resolve; });
  let pushCount = 0;
  await page.route("**/api/sync/push", async (route) => {
    if (++pushCount === 1) await firstPush;
    const { changes } = route.request().postDataJSON();
    await route.fulfill({ json: { acceptedIds: changes.map((item) => item.id), conflicts: [] } });
  });
  await page.route("**/api/sync/pull*", (route) => route.fulfill({ json: { changes: [] } }));
  await page.goto("/");
  await expect(page.locator("#syncBtn")).toBeEnabled();
  await page.evaluate(async () => {
    const { putRecord, STORES } = await import("/client/storage.js");
    await Promise.all(Array.from({ length: 501 }, (_, i) => putRecord(STORES.OUTBOX, {
      id: `status-${i}`, entityType: "questionProgress", entityKey: `status-${i}`,
      payload: { revision: 1 }, createdAt: "2026-09-06T01:00:00.000Z",
    })));
  });
  await page.locator("#syncBtn").click();
  await expect(page.locator("#syncStatus")).toHaveText("Syncing · 0 uploaded · 501 waiting");
  releaseFirstPush();
  await expect(page.locator("#syncStatus")).toHaveText("1 changes waiting · Sync again");
  await expect(page.locator("#syncStatus")).toHaveAttribute("title", /500 local change\(s\) uploaded.*1 still waiting/);
  await page.reload();
  await expect(page.locator("#syncBtn")).toBeEnabled();
  await expect(page.locator("#syncStatus")).toHaveText("1 changes waiting");
  await page.locator("#syncBtn").click();
  await expect(page.locator("#syncStatus")).toHaveText("Cloud ready");
  await expect(page.locator("#syncStatus")).toHaveAttribute("title", /0 still waiting, 0 conflict/);
});

test("coach metadata check changes waiting to ready without downloading or installing", async ({ page }) => {
  let output = null;
  const exportedAt = "2026-09-06T01:00:00.000Z";
  let materializations = 0;
  await page.route("**/api/assistant/study-coach/permission", (route) => route.fulfill({ json: {
    enabled: true, exchangeEnabled: true, snapshotPresent: true,
    latestPackage: { exportedAt }, latestOutput: output,
  } }));
  await page.route("**/api/assistant/study-coach/output/materialize", (route) => {
    materializations += 1;
    return route.fulfill({ status: 500, json: { error: "Unexpected write" } });
  });
  await page.goto("/");
  await expect(page.locator("#studyCoachHandoffStatus")).toContainText("awaiting analysis");
  output = { generatedAt: "2026-09-06T02:00:00.000Z", sourcePackageGeneratedAt: exportedAt };
  await page.locator("#checkStudyCoachStatusBtn").click();
  await expect(page.locator("#studyCoachHandoffStatus")).toContainText("New coach output ready");
  await page.reload();
  await expect(page.locator("#studyCoachHandoffStatus")).toContainText("New coach output ready");
  expect(materializations).toBe(0);
});
