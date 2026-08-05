import { test, expect } from "@playwright/test";

test("staging starts clean and reloads retain only the current isolated session", async ({ page }) => {
  let resetCalls = 0;
  await page.route("**/api/health", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ environment: "staging" }),
  }));
  await page.route("**/api/staging/session", async (route) => {
    const isReset = route.request().method() === "DELETE";
    if (isReset) resetCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, environment: "staging", state: isReset ? "cleared" : "active" }),
    });
  });
  await page.route("**/api/recovery/google-drive/latest", (route) => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "No production shadow snapshot exists" }),
  }));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("abpn-study:staging-session")) {
      localStorage.setItem("abpn-study:prior-test-artifact", "remove-me");
      localStorage.setItem("abpn-study:exam-date", "2030-12-31");
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Board Practice" })).toBeVisible();
  const first = await page.evaluate(() => ({
    prior: localStorage.getItem("abpn-study:prior-test-artifact"),
    session: sessionStorage.getItem("abpn-study:staging-session"),
    device: localStorage.getItem("abpn-study:device-id"),
  }));
  expect(first.prior).toBeNull();
  await expect(page.locator("#examCountdownValue")).toContainText(/\d+d \d+h \d+m/);
  expect(first.session).toBeTruthy();
  expect(first.device).toBe(first.session);
  expect(resetCalls).toBe(1);

  const validationOption = page.locator('#bankSelect option[value="validation-bank"]');
  await expect(validationOption).not.toHaveAttribute("hidden", "");
  await page.locator("#bankSelect").selectOption("validation-bank");
  await expect(page.getByRole("heading", { name: "System Validation Question Bank" })).toBeVisible();
  for (const label of [
    "Import from file",
    "Download complete backup",
    "Restore downloaded backup",
    "Reset current deck",
  ]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }
  await page.locator("#countInput").fill("1");
  await page.locator("#modeSelect").selectOption("tutor");
  await page.locator("#timingSelect").selectOption("untimed");
  await page.getByRole("button", { name: "Start set" }).click();
  await page.locator(".choice").first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Submit set" }).click();
  await page.getByRole("button", { name: "Back to dashboard" }).click();
  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect(page.locator("#analyticsSection table.summary-table")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Performance by subject" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Performance by test section" })).toBeVisible();

  await page.evaluate(() => localStorage.setItem("abpn-study:current-test-artifact", "keep-on-reload"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Board Practice" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("abpn-study:current-test-artifact")))
    .toBe("keep-on-reload");
  expect(resetCalls).toBe(1);
});

test("opening a new staging tab revokes the previous tab without accepting stale writes", async ({ context }) => {
  let activeSession = null;
  let staleRejections = 0;

  await context.route("**/api/health", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ environment: "staging" }),
  }));
  await context.route("**/api/staging/session", async (route) => {
    const request = route.request();
    const session = request.headers()["x-abpn-staging-session"];
    if (request.method() === "GET") {
      await route.fulfill({
        status: session === activeSession ? 200 : 409,
        contentType: "application/json",
        body: JSON.stringify(session === activeSession
          ? { ok: true, environment: "staging", state: "active" }
          : { error: "Staging session is no longer active", staleSession: true }),
      });
      return;
    }
    activeSession = session;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, environment: "staging", state: "cleared" }),
    });
  });
  await context.route("**/api/recovery/google-drive/latest", (route) => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "No production shadow snapshot exists" }),
  }));
  await context.route("**/api/sync/**", async (route) => {
    const request = route.request();
    if (request.headers()["x-abpn-device-id"] !== activeSession) {
      staleRejections += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Staging session is no longer active",
          localOnly: true,
          staleSession: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(request.method() === "POST"
        ? { acceptedIds: [], conflicts: [] }
        : { changes: [], nextCursor: "0" }),
    });
  });

  const oldPage = await context.newPage();
  await oldPage.goto("/");
  await expect(oldPage.getByRole("heading", { name: "Board Practice" })).toBeVisible();
  await expect(oldPage.locator("#bankSelect")).toBeVisible();
  const oldSession = await oldPage.evaluate(() => sessionStorage.getItem("abpn-study:staging-session"));

  const currentPage = await context.newPage();
  await currentPage.goto("/");
  await expect(currentPage.getByRole("heading", { name: "Board Practice" })).toBeVisible();
  await expect(currentPage.locator("#bankSelect")).toBeVisible();
  await expect(currentPage.locator('#bankSelect option[value="validation-bank"]')).not.toHaveAttribute("hidden", "");
  for (const label of [
    "Import from file",
    "Download complete backup",
    "Restore downloaded backup",
    "Reset current deck",
  ]) {
    await expect(currentPage.getByRole("button", { name: label })).toBeVisible();
  }
  const currentSession = await currentPage.evaluate(() => sessionStorage.getItem("abpn-study:staging-session"));
  expect(currentSession).toBeTruthy();
  expect(currentSession).not.toBe(oldSession);
  expect(activeSession).toBe(currentSession);

  await oldPage.getByRole("button", { name: "Sync" }).click();
  await expect(oldPage.locator("#syncStatus")).toHaveText("Local only · sync paused");
  await expect(oldPage.locator("#syncStatus")).toHaveAttribute(
    "aria-label",
    /Staging session is no longer active.*Local study data is safe/,
  );
  await expect(oldPage.getByRole("button", { name: "Restart staging sync" })).toBeVisible();
  expect(staleRejections).toBeGreaterThan(0);

  await currentPage.getByRole("button", { name: "Sync" }).click();
  await expect(currentPage.locator("#syncStatus")).toHaveText("Cloud ready");
});
