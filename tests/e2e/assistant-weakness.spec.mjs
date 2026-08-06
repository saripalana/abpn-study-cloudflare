import { test, expect } from "@playwright/test";

test("Study Coach permission, automatic refresh, revocation, and deletion remain separate", async ({ page }) => {
  let enabled = false;
  let publishCount = 0;
  let accessCount = 0;
  let deleteCount = 0;
  let published = null;

  await page.route("**/api/assistant/study-coach/permission", async (route) => {
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
        lastPublishedAt: published?.generatedAt || null,
        publishCount,
        accessCount,
        deleteCount,
        lastAccessedAt: null,
      }),
    });
  });

  await page.route("**/api/assistant/study-coach/snapshot", async (route) => {
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
  const section = page.locator("#studyCoachSection");
  await expect(section).toBeVisible();
  await expect(section).toContainText("choices, answers, explanations, and notes");
  await expect(section).toContainText("Credentials and unrelated browser or device data are never included");
  await expect(section).toContainText("until I revoke it");

  const dataProtectionHeading = page.getByRole("heading", { name: "Data protection" });
  await expect(dataProtectionHeading).toBeVisible();
  const insightsTop = await section.evaluate((element) => element.getBoundingClientRect().top);
  const protectionTop = await dataProtectionHeading.evaluate((element) => element.getBoundingClientRect().top);
  expect(protectionTop).toBeGreaterThan(insightsTop);

  await page.locator("#studyCoachPermission").check();
  await expect(page.locator("#studyCoachStatus")).toContainText("On until revoked");
  await expect(page.locator("#refreshStudyCoachBtn")).toBeEnabled();
  expect(published).not.toBeNull();

  const serialized = JSON.stringify(published);
  expect(published.schemaVersion).toBe(2);
  expect(published.consentVersion).toBe(2);
  expect(published.decks).toBeInstanceOf(Array);
  for (const forbidden of ["password", "credential", "accessToken", "browserHistory"]) {
    expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }

  await page.locator("#verifyStudyCoachAccessBtn").click();
  await expect(page.locator("#studyCoachStatus")).toContainText("1 access(es)");
  await expect(page.locator("#studyCoachStatus")).toContainText("Study Coach access verified");

  await page.locator("#revokeStudyCoachBtn").click();
  await expect(page.locator("#refreshStudyCoachBtn")).toBeDisabled();
  expect(published).not.toBeNull();
  await expect(page.locator("#deleteStudyCoachDataBtn")).toBeEnabled();

  await page.locator("#deleteStudyCoachDataBtn").click();
  expect(published).toBeNull();
  await expect(page.locator("#studyCoachStatus")).toContainText("1 deletion(s)");
  await expect(page.locator("#deleteStudyCoachDataBtn")).toBeDisabled();
});

test("assistant controls remain visible with a clear unavailable state when status cannot load", async ({ page }) => {
  await page.route("**/api/assistant/study-coach/permission", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Service unavailable" }),
  }));
  await page.goto("/");
  const section = page.locator("#studyCoachSection");
  await expect(section).toBeVisible();
  await expect(section).toContainText("until I revoke it");
  await expect(page.locator("#studyCoachStatus")).toContainText("temporarily unavailable");
  await expect(page.locator("#studyCoachPermission")).toBeDisabled();
});
