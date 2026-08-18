import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
  await page.route("**/api/study-coach/google-drive", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ configured: false, latestPackage: null, latestOutput: null }),
  }));
  await page.goto("/");
  const section = page.locator("#studyCoachSection");
  await expect(section).toBeVisible();
  await expect(section).toContainText("until I revoke it");
  await expect(page.locator("#studyCoachStatus")).toContainText("temporarily unavailable");
  await expect(page.locator("#studyCoachPermission")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Download full coach package" })).toBeEnabled();
});

test("Study Coach package export and local coach-output import remain usable", async ({ page }) => {
  await page.route("**/api/assistant/study-coach/permission", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      enabled: false,
      grantedAt: null,
      retention: null,
      expiresAt: null,
      revokedAt: null,
      snapshotPresent: false,
      lastPublishedAt: null,
      publishCount: 0,
      accessCount: 0,
      deleteCount: 0,
      lastAccessedAt: null,
    }),
  }));
  await page.route("**/api/study-coach/google-drive", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ configured: false, latestPackage: null, latestOutput: null }),
  }));

  await page.goto("/");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download full coach package" }).click();
  const path = await (await downloadPromise).path();
  const pkg = JSON.parse(await readFile(path, "utf8"));
  expect(pkg.format).toBe("abpn-study-coach-package");
  expect(pkg.banks[0].questions.length).toBeGreaterThan(0);
  expect(pkg.studyState.progress).toBeInstanceOf(Array);

  await page.locator("#studyCoachOutputImportInput").setInputFiles({
    name: "study-coach-output.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "abpn-study-coach-output",
      schemaVersion: 1,
      generatedAt: "2026-08-18T13:00:00.000Z",
      sourcePackageGeneratedAt: pkg.exportedAt,
      summary: "Target psychopharmacology and anxiety misses first.",
      focusAreas: [{
        title: "Psychopharmacology",
        rationale: "Recent errors are clustered here.",
        recommendedQuestionCount: 20,
        questionRefs: [{ bankId: pkg.banks[0].id, questionId: pkg.banks[0].questions[0].id }],
      }],
      recommendedSets: [{
        title: "20-question rebuild set",
        objective: "Retest the concepts you most recently missed.",
        mode: "test",
        timed: true,
        questionCount: 20,
        questionRefs: [{ bankId: pkg.banks[0].id, questionId: pkg.banks[0].questions[0].id }],
        instructions: "Use missed-question themes to create a fresh ABPN-style set.",
      }],
      progressMetrics: [{ label: "Primary target", value: "Psychopharmacology", detail: "20-question rebuild" }],
      studyActions: ["Run the 20-question rebuild set."],
      notes: ["Reassess after one timed pass."],
    })),
  });

  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Study Coach output imported");
  await expect(page.locator("#studyCoachOutput")).toContainText("Imported coaching plan");
  await expect(page.locator("#studyCoachOutput")).toContainText("20-question rebuild set");
  await expect(page.locator("#studyCoachOutput")).toContainText("Psychopharmacology");
});

test("Study Coach package can publish to Google Drive and pull latest coach output", async ({ page }) => {
  let latestPackage = null;
  const pulledOutput = {
    format: "abpn-study-coach-output",
    schemaVersion: 1,
    generatedAt: "2026-08-18T18:00:00.000Z",
    sourcePackageGeneratedAt: "2026-08-18T17:55:00.000Z",
    summary: "Rebuild psychiatry weak areas from the latest package.",
    focusAreas: [{
      title: "Anxiety Disorders",
      rationale: "Low accuracy with enough usage to prioritize now.",
      recommendedQuestionCount: 15,
      questionRefs: [{ bankId: "ks-psychiatry-core", questionId: "ks-1" }],
    }],
    recommendedSets: [{
      title: "15-question anxiety rebuild",
      objective: "Focus on high-yield misses first.",
      mode: "test",
      timed: false,
      questionCount: 15,
      questionRefs: [{ bankId: "ks-psychiatry-core", questionId: "ks-1" }],
      instructions: "Use latest incorrect themes and keep the style ABPN-like.",
    }],
    progressMetrics: [{ label: "Primary target", value: "Anxiety Disorders", detail: "15-question rebuild" }],
    studyActions: ["Run the anxiety rebuild set next."],
    notes: ["Re-check weakness ranking after one fresh pass."],
  };

  await page.route("**/api/assistant/study-coach/permission", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      enabled: false,
      grantedAt: null,
      retention: null,
      expiresAt: null,
      revokedAt: null,
      snapshotPresent: false,
      lastPublishedAt: null,
      publishCount: 0,
      accessCount: 0,
      deleteCount: 0,
      lastAccessedAt: null,
    }),
  }));
  await page.route(/\/api\/study-coach\/google-drive$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      configured: true,
      latestPackage: null,
      latestOutput: {
        id: "output-1",
        name: "abpn-study-coach-output-1.json",
        createdAt: "2026-08-18T18:01:00.000Z",
        byteCount: 2048,
      },
    }),
  }));
  await page.route("**/api/study-coach/google-drive/output/latest", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      configured: true,
      file: {
        id: "output-1",
        name: "abpn-study-coach-output-1.json",
        createdAt: "2026-08-18T18:01:00.000Z",
        byteCount: 2048,
      },
      output: pulledOutput,
    }),
  }));
  await page.route("**/api/study-coach/google-drive/package", async (route) => {
    latestPackage = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        configured: true,
        file: {
          id: "pkg-1",
          name: "abpn-study-coach-package.json",
          createdAt: "2026-08-18T17:56:00.000Z",
          byteCount: 4096,
          exportedAt: latestPackage.exportedAt,
          bankCount: latestPackage.banks.length,
          questionCount: latestPackage.banks.reduce((sum, bank) => sum + bank.questions.length, 0),
        },
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Google Drive exchange ready");

  const publishResponse = page.waitForResponse("**/api/study-coach/google-drive/package");
  await page.getByRole("button", { name: "Publish package to Google Drive" }).click();
  await publishResponse;
  expect(latestPackage?.format).toBe("abpn-study-coach-package");
  expect(latestPackage?.banks?.length).toBeGreaterThan(0);
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Study Coach package published to Google Drive");

  const pullResponse = page.waitForResponse("**/api/study-coach/google-drive/output/latest");
  await page.getByRole("button", { name: "Pull latest coach output" }).click();
  await pullResponse;
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Latest Study Coach output pulled from Google Drive");
  await expect(page.locator("#studyCoachOutput")).toContainText("Imported coaching plan");
  await expect(page.locator("#studyCoachOutput")).toContainText("15-question anxiety rebuild");
  await expect(page.locator("#studyCoachOutput")).toContainText("Anxiety Disorders");
});
