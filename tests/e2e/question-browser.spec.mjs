import { test, expect } from "@playwright/test";

test("question navigator sits beside the builder and opens a question without revealing its answer", async ({ page }, testInfo) => {
  await page.goto("/");

  const builder = page.getByRole("heading", { name: "Create practice set" });
  const navigator = page.getByRole("heading", { name: "Browse questions" });
  await expect(builder).toBeVisible();
  await expect(navigator).toBeVisible();
  await expect(page.locator(".question-browser-number")).toHaveCount(602);
  await expect(page.locator(".question-browser-number.new")).toHaveCount(602);

  const builderBox = await builder.boundingBox();
  const navigatorBox = await navigator.boundingBox();
  if (testInfo.project.name === "chromium-desktop") {
    expect(Math.abs(builderBox.y - navigatorBox.y)).toBeLessThan(80);
    expect(navigatorBox.x).toBeGreaterThan(builderBox.x);
  } else {
    expect(navigatorBox.y).toBeGreaterThan(builderBox.y);
  }

  await page.locator("#questionBrowserSearch").fill("psychopharmacology");
  await expect(page.locator(".question-browser-number:visible").first()).toBeVisible();
  await page.locator(".question-browser-number:visible").first().dblclick();
  await expect(page.locator(".question")).toBeVisible();
  await expect(page.locator(".explanation")).toHaveCount(0);
});

test("version is a compact footer and the question navigator remains usable on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-13-safari", "mobile layout assertion");
  await page.goto("/");
  await expect(page.locator(".release-footer")).toContainText("Version 1.0");
  await expect(page.locator("#questionBrowserSearch")).toBeVisible();
  await expect(page.locator(".question-browser-number").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("question numbers reflect correct wrong unanswered and new progress", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator(".question-browser-number");
  const ids = await Promise.all([0, 1, 2, 3].map((index) => rows.nth(index).getAttribute("data-question-id")));
  expect(ids.every(Boolean)).toBe(true);
  const bankId = await page.locator("#app").getAttribute("data-active-bank-id");
  await page.evaluate(async ({ ids, bankId }) => {
    const { updateQuestionProgress } = await import("/client/storage.js");
    const base = { isFlagged: false, timesUsed: 1, totalTimeMs: 1000 };
    await updateQuestionProgress({ bankId, questionId: ids[0], deviceId: "navigator-test", patch: { ...base, isCorrect: true, selectedAnswer: "A" } });
    await updateQuestionProgress({ bankId, questionId: ids[1], deviceId: "navigator-test", patch: { ...base, isCorrect: false, selectedAnswer: "B" } });
    await updateQuestionProgress({ bankId, questionId: ids[2], deviceId: "navigator-test", patch: { ...base, isCorrect: null, selectedAnswer: null } });
  }, { ids, bankId });
  await page.reload();
  await expect(page.locator(`[data-question-id="${ids[0]}"]`)).toHaveClass(/correct/);
  await expect(page.locator(`[data-question-id="${ids[1]}"]`)).toHaveClass(/wrong/);
  await expect(page.locator(`[data-question-id="${ids[2]}"]`)).toHaveClass(/unanswered/);
  await expect(page.locator(`[data-question-id="${ids[3]}"]`)).toHaveClass(/new/);
});
