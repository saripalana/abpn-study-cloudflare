import { test, expect } from "@playwright/test";
import { expectActiveBank } from "./helpers/active-bank.mjs";

function deckPackage() {
  return {
    format: "abpn-question-bank",
    schemaVersion: 1,
    bank: {
      id: "cross-device-deck",
      title: "Cross-device Deck",
      shortTitle: "Cross-device",
      description: "A deck used to verify persistent library behavior.",
      version: "1.0.0",
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: "Playwright Deck Library fixture",
      questions: [{
        id: "cross-device-1",
        chapterTitle: "Deck Library",
        question: "What should happen to an added deck on another signed-in device?",
        choices: ["It disappears", "It downloads from the Deck Library", "It merges into K&S", "It becomes public"],
        choiceLetters: ["A", "B", "C", "D"],
        correctLetter: "B",
        explanation: "Added decks are stored separately and downloaded to the local cache on another device.",
      }],
    },
  };
}

function installDeckApiRoute(page, store, observedHeaders) {
  return page.route("**/api/decks**", async (route) => {
    const request = route.request();
    observedHeaders.push(request.headers()["x-abpn-device-id"] || null);
    const url = new URL(request.url());
    const encodedId = url.pathname.startsWith("/api/decks/") ? url.pathname.slice("/api/decks/".length) : null;
    const id = encodedId ? decodeURIComponent(encodedId) : null;

    if (request.method() === "GET" && url.pathname === "/api/decks") {
      const decks = [...store.values()].map((item) => ({
        id: item.bank.id,
        title: item.bank.title,
        shortTitle: item.bank.shortTitle,
        description: item.bank.description,
        version: item.bank.version,
        sourceType: item.bank.sourceType,
        contentClass: item.bank.contentClass,
        sourceLabel: item.bank.sourceLabel,
        checksum: item.bank.checksum,
        questionCount: item.bank.questions.length,
        packageBytes: JSON.stringify(item).length,
        updatedAt: new Date().toISOString(),
      }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decks }) });
      return;
    }

    if (request.method() === "PUT" && id) {
      const body = JSON.parse(request.postData() || "{}");
      store.set(id, body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, deck: { id, checksum: body.bank.checksum } }),
      });
      return;
    }

    if (request.method() === "GET" && id && store.has(id)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(store.get(id)) });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Deck not found" }) });
  });
}

test("an added deck appears in a clean second browser profile like K&S", async ({ browser, baseURL }) => {
  const cloudStore = new Map();
  const observedHeaders = [];

  const firstContext = await browser.newContext({ baseURL });
  const firstPage = await firstContext.newPage();
  await installDeckApiRoute(firstPage, cloudStore, observedHeaders);
  let importCompleted = false;
  firstPage.on("dialog", async (dialog) => {
    if (dialog.message().startsWith("Deck added to your library successfully.")) importCompleted = true;
    await dialog.accept();
  });
  await firstPage.goto("/");
  await expect(firstPage.getByRole("heading", { name: "K&S Psychiatry Question Bank" })).toBeVisible();
  await expect(firstPage.getByText("DECK LIBRARY · 2 INSTALLED")).toBeVisible();
  await expect(firstPage.getByText("Every installed question bank uses the same versioned storage, protection, backup, study, and analytics system.")).toBeVisible();
  await expectActiveBank(firstPage, "ks-psychiatry-core");
  await expect(firstPage.getByLabel("Installed question banks")).toHaveCount(0);
  await expect(firstPage.getByRole("button", { name: "Manage Deck Library" })).toHaveCount(0);
  await expect(firstPage.locator("#deckLibraryManagement")).toBeVisible();
  await expect(firstPage.getByRole("button", { name: "Import from file" })).toBeEnabled();
  await expect(firstPage.getByRole("button", { name: "Download bank package" })).toBeVisible();
  await expect.poll(() => cloudStore.has("ks-psychiatry-core")).toBe(true);
  await expect.poll(() => cloudStore.has("spiegel-test-prep")).toBe(true);
  const seedStorage = await firstPage.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abpn-study", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction(["questionBankContent", "questionBankRevisions"], "readonly");
      const content = await new Promise((resolve, reject) => {
        const request = transaction.objectStore("questionBankContent").get("ks-psychiatry-core");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const revisions = await new Promise((resolve, reject) => {
        const request = transaction.objectStore("questionBankRevisions").index("byBank").getAll("ks-psychiatry-core");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { sourceType: content?.sourceType, checksum: content?.checksum, revisionCount: revisions.length };
    } finally {
      db.close();
    }
  });
  expect(seedStorage.sourceType).toBe("application-seed");
  expect(seedStorage.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(seedStorage.revisionCount).toBeGreaterThanOrEqual(1);

  // File-picker activation is covered by import-button.spec.js. This test targets
  // library persistence, so inject the package through the stable file input.
  await firstPage.locator("#bankImportInput").setInputFiles({
    name: "cross-device-deck.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(deckPackage())),
  });

  // Require protected-cloud publication and the post-install success boundary; the
  // application then performs its own reload, which the selector assertion observes.
  await expect.poll(() => cloudStore.has("cross-device-deck")).toBe(true);
  await expect.poll(() => importCompleted).toBe(true);
  await expectActiveBank(firstPage, "cross-device-deck");
  await expect(firstPage.getByRole("heading", { name: "Cross-device Deck" })).toBeVisible();
  await firstContext.close();

  const secondContext = await browser.newContext({ baseURL });
  const secondPage = await secondContext.newPage();
  await installDeckApiRoute(secondPage, cloudStore, observedHeaders);
  await secondPage.goto("/");
  await expect(secondPage.getByRole("heading", { name: "K&S Psychiatry Question Bank" })).toBeVisible();

  await expect.poll(() => secondPage.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abpn-study", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction("questionBankContent", "readonly");
      return await new Promise((resolve, reject) => {
        const request = transaction.objectStore("questionBankContent").get("cross-device-deck");
        request.onsuccess = () => resolve(Boolean(request.result));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  })).toBe(true);
  await secondPage.evaluate(() => localStorage.setItem("abpn-study:selected-bank", "cross-device-deck"));
  await secondPage.reload();
  await expectActiveBank(secondPage, "cross-device-deck");
  await expect(secondPage.getByRole("heading", { name: "Cross-device Deck" })).toBeVisible();
  await expect(secondPage.getByText("1 questions loaded.", { exact: false })).toBeVisible();
  expect(observedHeaders.length).toBeGreaterThan(0);
  expect(observedHeaders.every(Boolean)).toBe(true);
  await secondContext.close();
});

test("a same-version local seed mismatch does not block Deck Library startup", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DECK LIBRARY · 2 INSTALLED")).toBeVisible();

  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abpn-study", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction("questionBankContent", "readwrite");
      const store = transaction.objectStore("questionBankContent");
      const existing = await new Promise((resolve, reject) => {
        const request = store.get("ks-psychiatry-core");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      store.put({
        ...existing,
        checksum: "same-version-local-mismatch",
        questions: existing.questions.slice(0, 1),
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  });

  const warnings = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.reload();

  await expect(page.getByText("DECK LIBRARY · 2 INSTALLED")).toBeVisible();
  await expect(page.getByRole("heading", { name: "K&S Psychiatry Question Bank" })).toBeVisible();
  expect(warnings.join("\n")).not.toContain("Local deck cache is unavailable");
  expect(warnings.join("\n")).not.toContain("Updated deck catalog could not be loaded");
});
