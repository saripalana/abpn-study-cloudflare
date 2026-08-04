import { test, expect } from "@playwright/test";

test("indefinite permission, revocation, and deletion remain separate and content-free", async ({ page }) => {
  let enabled = false;
  let publishCount = 0;
  let accessCount = 0;
  let deleteCount = 0;
  let published = null;

  await page.route("**/api/assistant/weakness/permission", async (route) => {
    if (route.request().method() === "PUT") {
      enabled = Boolean(JSON.parse(route.request().postData() || "{}").enabled);
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        enabled,
        grantedAt: enabled ? "2026-08-04T12:00:00.000Z" : null,
        retention: enabled ? "until-revoked" : null,
        expiresAt: null,
        revokedAt: enabled ? null : "2026-08-04T12:00:00.000Z",
        snapshotPresent: published != null,
        publishCount,
        accessCount,
        deleteCount,
        lastAccessedAt: null,
      }),
    });
  });

  await page.route("**/api/assistant/weakness/snapshot", async (route) => {
    if (route.request().method() === "DELETE") {
      published = null;
      deleteCount += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, deleted: true }) });
      return;
    }
    if (route.request().method() === "GET") {
      accessCount += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ aggregate: published, generatedAt: published.generatedAt, retention: "until-revoked", expiresAt: null }),
      });
      return;
    }
    published = JSON.parse(route.request().postData() || "{}");
    publishCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, generatedAt: published.generatedAt, retention: "until-revoked", expiresAt: null }),
    });
  });

  await page.goto("/");
  const section = page.locator("#assistantInsightsSection");
  await expect(section).toBeVisible();
  await expect(section).toContainText("Questions, choices, answers, explanations, and notes are never included");
  await expect(section).toContainText("until I revoke it");

  const dataProtectionHeading = page.getByRole("heading", { name: "Data protection" });
  await expect(dataProtectionHeading).toBeVisible();
  const insightsTop = await section.evaluate((element) => element.getBoundingClientRect().top);
  const protectionTop = await dataProtectionHeading.evaluate((element) => element.getBoundingClientRect().top);
  expect(protectionTop).toBeGreaterThan(insightsTop);

  await page.locator("#assistantInsightsPermission").check();
  await expect(page.locator("#assistantInsightsStatus")).toContainText("On until you revoke it");
  await expect(page.locator("#shareWeaknessBtn")).toBeEnabled();
  await page.locator("#shareWeaknessBtn").click();
  await expect(page.locator("#assistantInsightsStatus")).toContainText("1 share(s)");

  const serialized = JSON.stringify(published);
  expect(published.schemaVersion).toBe(1);
  expect(published.domains).toBeInstanceOf(Array);
  for (const forbidden of ["questionId", "selectedAnswer", "correctLetter", "rationale", "explanation", "notes"]) {
    expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }

  await page.locator("#verifyWeaknessAccessBtn").click();
  await expect(page.locator("#assistantInsightsStatus")).toContainText("1 access(es)");
  await expect(page.locator("#assistantInsightsStatus")).toContainText("Access verified without question content");

  await page.locator("#revokeWeaknessBtn").click();
  await expect(page.locator("#shareWeaknessBtn")).toBeDisabled();
  expect(published).not.toBeNull();
  await expect(page.locator("#deleteWeaknessAggregateBtn")).toBeEnabled();

  await page.locator("#deleteWeaknessAggregateBtn").click();
  expect(published).toBeNull();
  await expect(page.locator("#assistantInsightsStatus")).toContainText("1 deletion(s)");
  await expect(page.locator("#deleteWeaknessAggregateBtn")).toBeDisabled();
});

test("assistant controls remain visible with a clear unavailable state when status cannot load", async ({ page }) => {
  await page.route("**/api/assistant/weakness/permission", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Service unavailable" }),
  }));
  await page.goto("/");
  const section = page.locator("#assistantInsightsSection");
  await expect(section).toBeVisible();
  await expect(section).toContainText("until I revoke it");
  await expect(page.locator("#assistantInsightsStatus")).toContainText("temporarily unavailable");
  await expect(page.locator("#assistantInsightsPermission")).toBeDisabled();
});
