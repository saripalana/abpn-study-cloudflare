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

function staleCatalogPackage(id, sourceType) {
  return {
    format: "abpn-question-bank",
    schemaVersion: 1,
    checksum: `stale-${id}`,
    bank: {
      ...deckPackage().bank,
      id,
      version: "stale-catalog-revision",
      sourceType,
      sourceLabel: "Stale cloud catalog fixture",
      checksum: `stale-${id}`,
      questions: [{
        ...deckPackage().bank.questions[0],
        id: `${id}-stale-1`,
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

async function stageStaleKsCorrectness(page, { setId = "completed-key-repair-set", selectedAnswer = ["C"] } = {}) {
  return page.evaluate(async ({ setId, selectedAnswer }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abpn-study", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(["questionBankContent", "progress", "practiceSets", "practiceSetAnswers"], "readwrite");
      const bankStore = tx.objectStore("questionBankContent");
      const progressStore = tx.objectStore("progress");
      const setStore = tx.objectStore("practiceSets");
      const answerStore = tx.objectStore("practiceSetAnswers");
      const bank = await new Promise((resolve, reject) => {
        const request = bankStore.get("ks-psychiatry-core");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const target = bank.questions.find((question) => question.id === "k-28.1");
      const completedAt = "2026-08-01T00:00:00.000Z";
      bankStore.put({
        ...bank,
        version: "ddfcba21e97973f77c08311400d05310a4ea1ee3",
        checksum: "prior-verified-seed-checksum",
        questions: bank.questions.map((question) => question.id === target.id ? {
          ...question,
          correctLetter: "D",
          correctLetters: ["D"],
          isMultiSelect: false,
        } : question),
      });
      setStore.put({
        id: setId,
        bankId: bank.id,
        questionIds: [target.id],
        mode: "test",
        status: "completed",
        startedAt: completedAt,
        completedAt,
        elapsedMs: 1000,
        timed: false,
        index: 0,
        remainingSeconds: 0,
        submitted: true,
        revision: 2,
        deviceId: "upgrade-test-device",
        updatedAt: completedAt,
      });
      answerStore.put({
        setId,
        questionId: target.id,
        selectedAnswer,
        isCorrect: false,
        isFlagged: false,
        timeMs: 1000,
        answeredAt: completedAt,
        revision: 3,
        deviceId: "upgrade-test-device",
        updatedAt: completedAt,
      });
      progressStore.put({
        bankId: bank.id,
        questionId: target.id,
        selectedAnswer,
        isCorrect: false,
        timesUsed: 1,
        totalTimeMs: 1000,
        lastUsedAt: completedAt,
        revision: 4,
        deviceId: "upgrade-test-device",
        updatedAt: completedAt,
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return { questionId: target.id, selectedAnswer, answeredAt: completedAt, setId };
    } finally {
      db.close();
    }
  }, { setId, selectedAnswer });
}

async function readKsCorrectnessRepair(page, { questionId, setId }) {
  return page.evaluate(async ({ questionId, setId }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abpn-study", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(["questionBankContent", "questionBankRevisions", "progress", "practiceSetAnswers", "syncOutbox", "meta"], "readonly");
      const bank = await read(tx.objectStore("questionBankContent"), "ks-psychiatry-core");
      const progress = await read(tx.objectStore("progress"), ["ks-psychiatry-core", questionId]);
      const answer = await read(tx.objectStore("practiceSetAnswers"), [setId, questionId]);
      const outbox = await read(tx.objectStore("syncOutbox"), `questionProgress:ks-psychiatry-core:${questionId}`);
      const answerOutbox = await read(tx.objectStore("syncOutbox"), `practiceSetAnswer:${setId}:${questionId}`);
      const revisions = await new Promise((resolve, reject) => {
        const request = tx.objectStore("questionBankRevisions").index("byBank").getAll("ks-psychiatry-core");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const question = bank.questions.find((candidate) => candidate.id === questionId);
      const marker = await new Promise((resolve, reject) => {
        const request = tx.objectStore("meta").get(`catalogReconciliation:ks-psychiatry-core:${bank.checksum}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return {
        version: bank.version,
        correctLetters: question.correctLetters,
        selectedAnswer: progress.selectedAnswer,
        progressCorrect: progress.isCorrect,
        progressRevision: progress.revision,
        answerCorrect: answer.isCorrect,
        answerRevision: answer.revision,
        answeredAt: answer.answeredAt,
        archivedPrior: revisions.some((item) => item.checksum === "prior-verified-seed-checksum"),
        outboxCorrectness: outbox?.payload?.isCorrect,
        answerOutboxCorrectness: answerOutbox?.payload?.isCorrect,
        hasOutbox: Boolean(outbox || answerOutbox),
        marker,
      };
    } finally {
      db.close();
    }
  }, { questionId, setId });
}

function installSyncApiRoute(page, observedSyncChanges) {
  return page.route("**/api/sync/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === "POST" && url.pathname === "/api/sync/push") {
      const body = JSON.parse(request.postData() || "{}");
      observedSyncChanges.push(...(body.changes || []));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ acceptedIds: (body.changes || []).map((change) => change.id), conflicts: [] }),
      });
      return;
    }

    if (request.method() === "GET" && url.pathname === "/api/sync/pull") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ changes: [], nextCursor: null }) });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unknown sync route" }) });
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

test("approved bundled catalog decks repair stale cloud copies without startup errors", async ({ page }) => {
  const cloudStore = new Map([
    ["ks-psychiatry-core", staleCatalogPackage("ks-psychiatry-core", "application-seed")],
    ["spiegel-test-prep", staleCatalogPackage("spiegel-test-prep", "user-imported")],
  ]);
  const observedHeaders = [];
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await installDeckApiRoute(page, cloudStore, observedHeaders);

  await page.goto("/");
  await expect(page.getByText("DECK LIBRARY · 2 INSTALLED")).toBeVisible();
  await expect.poll(() => cloudStore.get("ks-psychiatry-core")?.bank?.questions?.length).toBe(602);
  await expect.poll(() => cloudStore.get("spiegel-test-prep")?.bank?.questions?.length).toBe(1060);
  expect(cloudStore.get("ks-psychiatry-core").checksum).not.toBe("stale-ks-psychiatry-core");
  expect(cloudStore.get("spiegel-test-prep").checksum).not.toBe("stale-spiegel-test-prep");
  expect(errors.filter((message) => message.includes("Cloud deck "))).toEqual([]);
  expect(observedHeaders.length).toBeGreaterThan(0);
  expect(observedHeaders.every(Boolean)).toBe(true);
});

test("a same-version local seed mismatch is repaired before cloud promotion", async ({ page }) => {
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
  const repairedCount = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abpn-study", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction("questionBankContent", "readonly");
      return await new Promise((resolve, reject) => {
        const request = transaction.objectStore("questionBankContent").get("ks-psychiatry-core");
        request.onsuccess = () => resolve(request.result?.questions?.length || 0);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
  expect(repairedCount).toBe(602);
  expect(warnings.join("\n")).not.toContain("Local deck cache is unavailable");
  expect(warnings.join("\n")).not.toContain("Updated deck catalog could not be loaded");
});

test("a verified K&S seed revision repairs derived correctness without changing answer history", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DECK LIBRARY · 2 INSTALLED")).toBeVisible();

  const staged = await stageStaleKsCorrectness(page);

  await page.reload();
  await expect(page.getByRole("heading", { name: "K&S Psychiatry Question Bank" })).toBeVisible();

  const upgraded = await readKsCorrectnessRepair(page, staged);

  expect(upgraded.version).toBe("020aae0f5c55ad3bb0c122760c7b7d3fe26f1b46-ak1");
  expect(upgraded.correctLetters).toEqual(["C"]);
  expect(upgraded.selectedAnswer).toEqual(staged.selectedAnswer);
  expect(upgraded.progressCorrect).toBe(true);
  expect(upgraded.progressRevision).toBe(5);
  expect(upgraded.answerCorrect).toBe(true);
  expect(upgraded.answerRevision).toBe(4);
  expect(upgraded.answeredAt).toBe(staged.answeredAt);
  expect(upgraded.archivedPrior).toBe(true);
  expect(upgraded.outboxCorrectness).toBe(true);
  expect(upgraded.answerOutboxCorrectness).toBe(true);
  expect(upgraded.marker.repairedProgress).toBe(1);
  expect(upgraded.marker.repairedAnswers).toBe(1);
});

test("the Sync button applies K&S catalog corrections and uploads repaired answer metadata", async ({ page }) => {
  const observedSyncChanges = [];
  await installSyncApiRoute(page, observedSyncChanges);
  await page.goto("/");
  await expect(page.getByText("DECK LIBRARY · 2 INSTALLED")).toBeVisible();
  await expect(page.locator("#syncBtn")).toBeEnabled();

  const staged = await stageStaleKsCorrectness(page, { setId: "sync-button-key-repair-set" });
  await page.locator("#syncBtn").click();
  await expect.poll(async () => {
    const repair = await readKsCorrectnessRepair(page, staged);
    return {
      version: repair.version,
      progressCorrect: repair.progressCorrect,
      answerCorrect: repair.answerCorrect,
      hasOutbox: repair.hasOutbox,
      uploadedRepairs: observedSyncChanges
        .filter((change) => (
          (change.entityType === "practiceSetAnswer" && change.payload?.setId === staged.setId && change.payload?.isCorrect === true)
          || (change.entityType === "questionProgress" && change.payload?.questionId === staged.questionId && change.payload?.isCorrect === true)
        ))
        .length,
    };
  }).toEqual({
    version: "020aae0f5c55ad3bb0c122760c7b7d3fe26f1b46-ak1",
    progressCorrect: true,
    answerCorrect: true,
    hasOutbox: false,
    uploadedRepairs: 2,
  });

  const repaired = await readKsCorrectnessRepair(page, staged);
  expect(repaired.version).toBe("020aae0f5c55ad3bb0c122760c7b7d3fe26f1b46-ak1");
  expect(repaired.correctLetters).toEqual(["C"]);
  expect(repaired.selectedAnswer).toEqual(staged.selectedAnswer);
  expect(repaired.progressCorrect).toBe(true);
  expect(repaired.answerCorrect).toBe(true);
  expect(repaired.answeredAt).toBe(staged.answeredAt);
  expect(repaired.hasOutbox).toBe(false);
  expect(observedSyncChanges.some((change) => change.entityType === "practiceSetAnswer" && change.payload?.setId === staged.setId && change.payload?.isCorrect === true)).toBe(true);
  expect(observedSyncChanges.some((change) => change.entityType === "questionProgress" && change.payload?.questionId === staged.questionId && change.payload?.isCorrect === true)).toBe(true);
});
