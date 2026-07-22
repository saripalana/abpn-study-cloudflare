import { test, expect } from "@playwright/test";

const BOOTSTRAP_VERSION = "unified-deck-library-v1";

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
      checksum: "cross-device-checksum",
      questions: [{
        id: "cross-device-1",
        chapterTitle: "Deck Library",
        question: "What should happen to an added deck on another signed-in device?",
        choices: ["It disappears", "It downloads from the Deck Library", "It merges into another deck", "It becomes public"],
        choiceLetters: ["A", "B", "C", "D"],
        correctLetter: "B",
        explanation: "Added decks are stored separately and downloaded to the local cache on another device.",
      }],
    },
  };
}

function initialDeckPackage() {
  return {
    format: "abpn-question-bank",
    schemaVersion: 1,
    bank: {
      id: "validation-bank",
      title: "System Validation Question Bank",
      shortTitle: "Validation Bank",
      description: "Initial ordinary deck fixture.",
      version: "1.0.0",
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: "Playwright initial deck",
      checksum: "validation-checksum",
      questions: [{
        id: "validation-1",
        chapterTitle: "Deck Library",
        question: "Are all decks loaded through the same library?",
        choices: ["No", "Yes"],
        choiceLetters: ["A", "B"],
        correctLetter: "B",
        explanation: "Every deck uses the same library.",
      }],
    },
  };
}

function installDeckApiRoute(page, store, state, observedHeaders) {
  return page.route("**/api/decks**", async (route) => {
    const request = route.request();
    observedHeaders.push(request.headers()["x-abpn-device-id"] || null);
    const url = new URL(request.url());

    if (url.pathname === "/api/decks/bootstrap") {
      if (request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ version: state.version, completedAt: state.completedAt }),
        });
        return;
      }
      if (request.method() === "PUT") {
        const body = JSON.parse(request.postData() || "{}");
        state.version = body.version;
        state.completedAt = new Date().toISOString();
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...state }) });
        return;
      }
    }

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

test("an added deck appears in a clean second browser profile through the same library", async ({ browser, baseURL }) => {
  const cloudStore = new Map([["validation-bank", initialDeckPackage()]]);
  const bootstrapState = { version: BOOTSTRAP_VERSION, completedAt: new Date().toISOString() };
  const observedHeaders = [];

  const firstContext = await browser.newContext({ baseURL });
  const firstPage = await firstContext.newPage();
  await installDeckApiRoute(firstPage, cloudStore, bootstrapState, observedHeaders);
  firstPage.on("dialog", async (dialog) => dialog.accept());
  await firstPage.goto("/");

  const chooserPromise = firstPage.waitForEvent("filechooser");
  await firstPage.getByRole("button", { name: "Add deck from file" }).click();
  const chooser = await chooserPromise;
  const navigation = firstPage.waitForNavigation({ waitUntil: "domcontentloaded" });
  await chooser.setFiles({
    name: "cross-device-deck.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(deckPackage())),
  });
  await navigation;

  await expect(firstPage.locator("#bankSelect")).toHaveValue("cross-device-deck");
  await expect(firstPage.getByRole("heading", { name: "Cross-device Deck" })).toBeVisible();
  expect(cloudStore.has("cross-device-deck")).toBe(true);
  await firstContext.close();

  const secondContext = await browser.newContext({ baseURL });
  const secondPage = await secondContext.newPage();
  await installDeckApiRoute(secondPage, cloudStore, bootstrapState, observedHeaders);
  await secondPage.goto("/");

  await expect(secondPage.locator('#bankSelect option[value="cross-device-deck"]')).toHaveCount(1);
  await secondPage.selectOption("#bankSelect", "cross-device-deck");
  await expect(secondPage.getByRole("heading", { name: "Cross-device Deck" })).toBeVisible();
  await expect(secondPage.getByText("1 questions loaded.", { exact: false })).toBeVisible();
  expect(observedHeaders.length).toBeGreaterThan(0);
  expect(observedHeaders.every(Boolean)).toBe(true);
  await secondContext.close();
});
