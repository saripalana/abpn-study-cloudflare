import { test, expect } from "@playwright/test";

test("staging starts clean and reloads retain only the current isolated session", async ({ page }) => {
  let resetCalls = 0;
  await page.route("**/api/health", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ environment: "staging" }),
  }));
  await page.route("**/api/staging/session", async (route) => {
    resetCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, environment: "staging", state: "cleared" }),
    });
  });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("abpn-study:staging-session")) {
      localStorage.setItem("abpn-study:prior-test-artifact", "remove-me");
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
  expect(first.session).toBeTruthy();
  expect(first.device).toBe(first.session);
  expect(resetCalls).toBe(1);

  await page.evaluate(() => localStorage.setItem("abpn-study:current-test-artifact", "keep-on-reload"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Board Practice" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("abpn-study:current-test-artifact")))
    .toBe("keep-on-reload");
  expect(resetCalls).toBe(1);
});
