import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function openAdvancedStudyCoachTools(page) {
  const details = page.locator(".study-coach-advanced");
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator("summary").click();
  }
}

test("Study Coach permission, automatic refresh, revocation, and deletion remain separate", async ({ page }) => {
  let enabled = false;
  let publishCount = 0;
  let accessCount = 0;
  let deleteCount = 0;
  let published = null;
  let sharedPackage = null;
  let sharedOutput = null;

  await page.route("**/api/assistant/study-coach/permission", async (route) => {
    if (route.request().method() === "PUT") {
      enabled = Boolean(JSON.parse(route.request().postData() || "{}").enabled);
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        enabled,
        exchangeEnabled: enabled,
        exchangeConsentVersion: enabled ? 1 : 0,
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
        packagePresent: sharedPackage != null,
        latestPackage: sharedPackage,
        outputPresent: sharedOutput != null,
        latestOutput: sharedOutput,
      }),
    });
  });

  await page.route("**/api/assistant/study-coach/snapshot", async (route) => {
    if (route.request().method() === "DELETE") {
      published = null;
      sharedPackage = null;
      sharedOutput = null;
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
  await expect(section).toContainText("No downloads, file selection, or chat attachments are needed");
  await expect(section).toContainText("Send your latest package to Cloudflare");
  await expect(section).toContainText("Install the latest coach update");
  await expect(page.getByRole("button", { name: "Send latest package" })).toBeVisible();
  await expect(page.locator(".study-coach-advanced").locator("summary")).toContainText("Manual fallback and data controls");
  await expect(page.locator(".study-coach-advanced")).not.toHaveAttribute("open", "");

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

  await openAdvancedStudyCoachTools(page);
  await expect(section).toContainText("Manual fallback if Cloudflare is unavailable");
  await page.locator("#verifyStudyCoachAccessBtn").click();
  await expect(page.locator("#studyCoachStatus")).toContainText("1 snapshot access(es)");
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
  await openAdvancedStudyCoachTools(page);
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
      packagePresent: false,
      latestPackage: null,
      outputPresent: false,
      latestOutput: null,
    }),
  }));
  await page.route("**/api/study-coach/google-drive", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ configured: false, latestPackage: null, latestOutput: null }),
  }));

  await page.goto("/");
  await openAdvancedStudyCoachTools(page);
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

  await expect(page.locator("#studyCoachOutput")).toContainText("Imported coaching plan");
  await expect(page.locator("#studyCoachOutput")).toContainText("20-question rebuild set");
  await expect(page.locator("#studyCoachOutput")).toContainText("Psychopharmacology");
});

test("Study Coach output appends cumulatively, publishes to Cloudflare, and repairs a stale cloud head on reload", async ({ page }) => {
  const cloudStore = new Map();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/api/decks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const encodedId = url.pathname.startsWith("/api/decks/") ? url.pathname.slice("/api/decks/".length) : null;
    const id = encodedId ? decodeURIComponent(encodedId) : null;
    if (request.method() === "GET" && url.pathname === "/api/decks") {
      const decks = [...cloudStore.values()].map((entry) => ({
        id: entry.bank.id,
        title: entry.bank.title,
        shortTitle: entry.bank.shortTitle,
        description: entry.bank.description,
        version: entry.bank.version,
        sourceType: entry.bank.sourceType,
        contentClass: entry.bank.contentClass,
        sourceLabel: entry.bank.sourceLabel,
        checksum: entry.bank.checksum,
        questionCount: entry.bank.questions.length,
        updatedAt: "2026-09-01T18:00:00.000Z",
      }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decks }) });
      return;
    }
    if (request.method() === "GET" && id && cloudStore.has(id)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cloudStore.get(id)) });
      return;
    }
    if (request.method() === "PUT" && id) {
      const incoming = JSON.parse(request.postData() || "{}");
      const expected = request.headers()["x-abpn-expected-head-checksum"];
      const current = cloudStore.get(id);
      if (expected && current?.bank?.checksum !== expected) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "stale head" }) });
        return;
      }
      cloudStore.set(id, incoming);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Deck not found" }) });
  });
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
      packagePresent: false,
      latestPackage: null,
      outputPresent: false,
      latestOutput: null,
    }),
  }));
  await page.route("**/api/study-coach/google-drive", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ configured: false, latestPackage: null, latestOutput: null }),
  }));

  await page.goto("/");
  await expect(page.locator("#app")).toContainText("DECK LIBRARY · 2 INSTALLED");

  await page.locator("#studyCoachOutputImportInput").setInputFiles({
    name: "study-coach-output-with-generated-deck.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "abpn-study-coach-output",
      schemaVersion: 1,
      generatedAt: "2026-08-21T18:35:00.000Z",
      sourcePackageGeneratedAt: "2026-08-21T18:30:00.000Z",
      summary: "Install a targeted psychopharmacology deck.",
      focusAreas: [{
        title: "Psychopharmacology",
        rationale: "Recent misses warrant a fresh coach-authored set.",
        recommendedQuestionCount: 2,
        questionRefs: [],
      }],
      recommendedSets: [],
      progressMetrics: [{ label: "Primary target", value: "Psychopharmacology", detail: "2 fresh questions" }],
      studyActions: ["Run the coach-authored psychopharmacology set next."],
      notes: ["This output should install a separate coach deck."],
      generatedDecks: [{
        title: "Psychopharmacology recovery deck",
        objective: "Fresh coach-authored remediation questions.",
        bankId: "coach-psychopharm-authored-20260821",
        questionCount: 2,
        package: {
          format: "abpn-question-bank",
          schemaVersion: 1,
          bank: {
            id: "coach-psychopharm-authored-20260821",
            title: "Coach deck · Psychopharmacology recovery deck",
            shortTitle: "Psychopharm coach",
            description: "Fresh coach-authored remediation questions.",
            version: "20260821",
            sourceType: "assistant-supplemental",
            contentClass: "assistant-supplemental",
            sourceLabel: "Study Coach",
            questions: [
              {
                id: "coach-psychopharm-authored-20260821-q1",
                chapterTitle: "Psychopharmacology",
                subjectTitle: "Psychopharmacology",
                question: "Which monitoring step is most important after starting lithium?",
                choices: ["Check serum lithium level", "Order EEG", "Avoid renal labs", "Stop fluids"],
                choiceLetters: ["A", "B", "C", "D"],
                correctLetter: "A",
                explanation: "Lithium therapy requires serum level monitoring."
              },
              {
                id: "coach-psychopharm-authored-20260821-q2",
                chapterTitle: "Psychopharmacology",
                subjectTitle: "Psychopharmacology",
                question: "Which antidepressant is most associated with sexual side effects?",
                choices: ["Sertraline", "Bupropion", "Mirtazapine", "Buspirone"],
                choiceLetters: ["A", "B", "C", "D"],
                correctLetter: "A",
                explanation: "SSRIs commonly cause sexual side effects."
              }
            ],
          },
        },
      }],
    }), "utf8"),
  });

  await expect(page.locator("#studyCoachOutput")).toContainText("Generated question sets");
  await expect(page.locator("#app")).toContainText("DECK LIBRARY · 3 INSTALLED");
  await expect(page.getByLabel("View study deck").locator("option")).toContainText(["K&S Psychiatry Question Bank", "Spiegel Test Prep Question Bank", "Study Coach Question Bank"]);
  const excludeCoachMetrics = page.getByLabel("Exclude Study Coach from overall metrics");
  await expect(excludeCoachMetrics).toBeChecked();
  await expect(page.locator("#studyCoachMetricsScope")).toContainText("source decks only");
  await excludeCoachMetrics.uncheck();
  await expect(page.locator("#studyCoachMetricsScope")).toContainText("include every study deck");
  await page.getByLabel("View study deck").selectOption("study-coach-question-bank");
  await expect(page.locator("#app")).toContainText("Study Coach Question Bank");
  await expect(page.getByLabel("Exclude Study Coach from overall metrics")).not.toBeChecked();
  await expect(page.locator(".stats .stat").nth(0)).toContainText("2");
  await expect(page.locator(".stats .stat").nth(1)).toContainText("0");
  await expect(page.locator("#app")).toContainText("1 source test");
  await expect(page.getByLabel("Practice from")).not.toContainText("Coach decks");

  const firstCloudPackage = structuredClone(cloudStore.get("study-coach-question-bank"));
  expect(firstCloudPackage.bank.questions).toHaveLength(2);
  await page.locator("#studyCoachOutputImportInput").setInputFiles({
    name: "study-coach-output-second-cycle.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "abpn-study-coach-output",
      schemaVersion: 1,
      generatedAt: "2026-08-21T19:35:00.000Z",
      sourcePackageGeneratedAt: "2026-08-21T19:30:00.000Z",
      summary: "Install a second targeted cycle.",
      focusAreas: [],
      recommendedSets: [],
      progressMetrics: [],
      studyActions: [],
      notes: [],
      generatedDecks: [{
        title: "Second recovery cycle",
        objective: "Verify cumulative Cloudflare publication.",
        bankId: "coach-second-cycle-20260821",
        questionCount: 1,
        package: {
          format: "abpn-question-bank",
          schemaVersion: 1,
          bank: {
            id: "coach-second-cycle-20260821",
            title: "Second recovery cycle",
            shortTitle: "Second cycle",
            description: "Synthetic cumulative test fixture.",
            version: "20260821-2",
            sourceType: "assistant-supplemental",
            contentClass: "assistant-supplemental",
            sourceLabel: "Study Coach",
            questions: [{
              id: "coach-second-cycle-20260821-q1",
              chapterTitle: "Synthetic section",
              subjectTitle: "Synthetic subject",
              question: "Which synthetic option verifies a second additive cycle?",
              choices: ["The additive option", "The destructive option"],
              choiceLetters: ["A", "B"],
              correctLetter: "A",
              explanation: "The additive option preserves prior questions.",
            }],
          },
        },
      }],
    }), "utf8"),
  });
  await expect.poll(() => cloudStore.get("study-coach-question-bank")?.bank?.questions?.length).toBe(3);
  await expect(page.locator(".stats .stat").nth(0)).toContainText("3");

  await page.evaluate(async () => {
    const { putRecord, STORES } = await import("/client/storage.js");
    await putRecord(STORES.PROGRESS, {
      bankId: "study-coach-question-bank",
      questionId: "coach-psychopharm-authored-20260821-q1",
      timesUsed: 1,
      isCorrect: true,
      updatedAt: "2026-09-01T19:40:00.000Z",
    });
  });
  cloudStore.set("study-coach-question-bank", firstCloudPackage);
  await page.reload();
  await expect.poll(() => cloudStore.get("study-coach-question-bank")?.bank?.questions?.length).toBe(3);
  const preservedProgress = await page.evaluate(async () => {
    const { getRecord, STORES } = await import("/client/storage.js");
    return getRecord(STORES.PROGRESS, ["study-coach-question-bank", "coach-psychopharm-authored-20260821-q1"]);
  });
  expect(preservedProgress?.timesUsed).toBe(1);
  expect(consoleErrors.filter((message) => message.includes("study-coach-question-bank"))).toEqual([]);
});

test("Study Coach package can share through Cloudflare, archive to Google Drive, and pull latest coach output", async ({ page }) => {
  let latestPackage = null;
  let latestOutput = {
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
      enabled: true,
      exchangeEnabled: true,
      exchangeConsentVersion: 1,
      grantedAt: "2026-08-18T17:40:00.000Z",
      retention: "until-revoked",
      expiresAt: null,
      revokedAt: null,
      snapshotPresent: true,
      lastPublishedAt: "2026-08-18T17:41:00.000Z",
      publishCount: 1,
      accessCount: 0,
      deleteCount: 0,
      lastAccessedAt: null,
      packagePresent: latestPackage != null,
      latestPackage: latestPackage ? {
        id: "pkg-1",
        createdAt: "2026-08-18T17:56:00.000Z",
        byteCount: 4096,
        chunkCount: 1,
        exportedAt: latestPackage.exportedAt,
        bankCount: latestPackage.banks.length,
        questionCount: latestPackage.banks.reduce((sum, bank) => sum + bank.questions.length, 0),
      } : null,
      outputPresent: latestOutput != null,
      latestOutput: latestOutput ? {
        id: "output-1",
        createdAt: "2026-08-18T18:01:00.000Z",
        byteCount: 2048,
        chunkCount: 1,
        generatedAt: latestOutput.generatedAt,
        sourcePackageGeneratedAt: latestOutput.sourcePackageGeneratedAt,
        format: latestOutput.format,
        schemaVersion: latestOutput.schemaVersion,
      } : null,
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
  await page.route("**/api/assistant/study-coach/output", async (route) => {
    if (route.request().method() === "PUT") {
      latestOutput = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          file: {
            id: "output-1",
            createdAt: "2026-08-18T18:01:00.000Z",
            byteCount: 2048,
            chunkCount: 1,
            generatedAt: latestOutput.generatedAt,
            sourcePackageGeneratedAt: latestOutput.sourcePackageGeneratedAt,
            format: latestOutput.format,
            schemaVersion: latestOutput.schemaVersion,
          },
          output: latestOutput,
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        file: {
          id: "output-1",
          createdAt: "2026-08-18T18:01:00.000Z",
          byteCount: 2048,
          chunkCount: 1,
          generatedAt: latestOutput.generatedAt,
          sourcePackageGeneratedAt: latestOutput.sourcePackageGeneratedAt,
          format: latestOutput.format,
          schemaVersion: latestOutput.schemaVersion,
        },
        output: latestOutput,
      }),
    });
  });
  await page.route("**/api/assistant/study-coach/output/materialize", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        file: {
          id: "output-1",
          createdAt: "2026-08-18T18:01:00.000Z",
          byteCount: 2048,
          chunkCount: 1,
          generatedAt: latestOutput.generatedAt,
          sourcePackageGeneratedAt: latestOutput.sourcePackageGeneratedAt,
          format: latestOutput.format,
          schemaVersion: latestOutput.schemaVersion,
        },
        output: latestOutput,
        deck: { id: "study-coach-question-bank", questionCount: 24, status: "published" },
      }),
    });
  });
  await page.route("**/api/assistant/study-coach/package", async (route) => {
    latestPackage = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        file: {
          id: "pkg-1",
          createdAt: "2026-08-18T17:56:00.000Z",
          byteCount: 4096,
          chunkCount: 1,
          exportedAt: latestPackage.exportedAt,
          bankCount: latestPackage.banks.length,
          questionCount: latestPackage.banks.reduce((sum, bank) => sum + bank.questions.length, 0),
        },
      }),
    });
  });
  await page.route("**/api/study-coach/google-drive/package", async (route) => {
    const archivePackage = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        configured: true,
        file: {
          id: "drive-pkg-1",
          name: "abpn-study-coach-package.json",
          createdAt: "2026-08-18T17:57:00.000Z",
          byteCount: 4096,
          exportedAt: archivePackage.exportedAt,
          bankCount: archivePackage.banks.length,
          questionCount: archivePackage.banks.reduce((sum, bank) => sum + bank.questions.length, 0),
        },
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Cloudflare is the live Study Coach lane");

  const publishResponse = page.waitForResponse("**/api/assistant/study-coach/package");
  await page.getByRole("button", { name: "Send latest package" }).click();
  await publishResponse;
  expect(latestPackage?.format).toBe("abpn-study-coach-package");
  expect(latestPackage?.banks?.length).toBeGreaterThan(0);
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Study Coach package shared to Cloudflare");

  await openAdvancedStudyCoachTools(page);
  const archiveResponse = page.waitForResponse("**/api/study-coach/google-drive/package");
  await page.getByRole("button", { name: "Archive package to Google Drive" }).click();
  await archiveResponse;
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Study Coach package archived to Google Drive");

  const publishOutputResponse = page.waitForResponse((response) =>
    response.url().includes("/api/assistant/study-coach/output") && response.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "Publish coach output file" }).click();
  await page.locator("#studyCoachOutputImportInput").setInputFiles({
    name: "study-coach-output.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(latestOutput), "utf8"),
  });
  await publishOutputResponse;
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Study Coach output published to Cloudflare");

  const pullResponse = page.waitForResponse("**/api/assistant/study-coach/output/materialize");
  await page.getByRole("button", { name: "Update Study Coach" }).click();
  await pullResponse;
  await expect(page.locator("#studyCoachPackageStatus")).toContainText("Latest Study Coach output materialized and pulled from Cloudflare");
  await expect(page.locator("#studyCoachOutput")).toContainText("Imported coaching plan");
  await expect(page.locator("#studyCoachOutput")).toContainText("15-question anxiety rebuild");
  await expect(page.locator("#studyCoachOutput")).toContainText("Anxiety Disorders");
});
