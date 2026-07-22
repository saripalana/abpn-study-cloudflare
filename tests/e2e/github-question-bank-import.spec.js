import { test, expect } from "@playwright/test";

const corsHeaders = { "access-control-allow-origin": "*" };

function githubPackage() {
  return {
    format: "abpn-question-bank",
    schemaVersion: 1,
    bank: {
      id: "github-browser-bank",
      title: "GitHub Browser Question Bank",
      shortTitle: "GitHub Bank",
      description: "A test bank imported from a GitHub repository address.",
      version: "1.0.0",
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: "GitHub browser fixture",
      questions: [{
        id: "github-browser-1",
        chapterTitle: "GitHub Import",
        question: "Which choice confirms GitHub question-bank importing?",
        choices: ["Incorrect", "Correct", "Incorrect", "Incorrect"],
        choiceLetters: ["A", "B", "C", "D"],
        correctLetter: "B",
        explanation: "The repository package was fetched and validated.",
      }],
    },
  };
}

function legacySpiegelSource() {
  return `const QUESTIONS = \uFEFF${JSON.stringify([{
    id: "vignette1-q1",
    section: "Vignette 1",
    sectionType: "vignette",
    vignetteStem: "A patient presents with two characteristic findings.",
    question: "Select both characteristic findings.",
    choices: ["Finding A", "Distractor", "Finding C"],
    choiceLetters: ["A", "B", "C"],
    correctLetters: ["A", "C"],
    isMultiSelect: true,
    answerText: "A and C",
    explanation: "Both A and C are required.",
  }])};`;
}

test("imports a compatible question bank from a GitHub repository address", async ({ page }) => {
  page.on("dialog", async (dialog) => dialog.accept());
  await page.route("https://raw.githubusercontent.com/example/abpn-bank/**", async (route) => {
    if (route.request().url().endsWith("/main/abpn-question-bank.json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify(githubPackage()),
      });
      return;
    }
    await route.fulfill({ status: 404, headers: corsHeaders, body: "not found" });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Import from GitHub" })).toBeVisible();
  await page.locator("#githubBankUrlInput").fill("https://github.com/example/abpn-bank");
  await page.getByRole("button", { name: "Import from GitHub" }).click();

  await expect(page.locator("#bankSelect")).toHaveValue("github-browser-bank");
  await expect(page.getByRole("heading", { name: "GitHub Browser Question Bank" })).toBeVisible();
  await expect(page.getByText("GitHub browser fixture")).toBeVisible();
  await expect(page.getByText("1 questions loaded.", { exact: false })).toBeVisible();
});

test("imports the legacy Spiegel GitHub Pages site and preserves multi-select behavior", async ({ page }) => {
  page.on("dialog", async (dialog) => dialog.accept());
  await page.route("https://raw.githubusercontent.com/dancingremote/spiegel-test-prep/**", async (route) => {
    if (route.request().url().endsWith("/main/data.js")) {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: corsHeaders,
        body: legacySpiegelSource(),
      });
      return;
    }
    await route.fulfill({ status: 404, headers: corsHeaders, body: "not found" });
  });

  await page.goto("/");
  await page.locator("#githubBankUrlInput").fill("https://dancingremote.github.io/spiegel-test-prep/");
  await page.getByRole("button", { name: "Import from GitHub" }).click();

  await expect(page.locator("#bankSelect")).toHaveValue("spiegel-test-prep");
  await expect(page.getByRole("heading", { name: "Spiegel Test Prep Question Bank" })).toBeVisible();
  await expect(page.getByText("Spiegel Test Prep · dancingremote/spiegel-test-prep")).toBeVisible();
  await expect(page.getByText("1 questions loaded.", { exact: false })).toBeVisible();

  await page.locator("#countInput").fill("1");
  await page.selectOption("#modeSelect", "tutor");
  await page.selectOption("#timingSelect", "untimed");
  await page.getByRole("button", { name: "Start randomized set" }).click();

  await expect(page.getByText("Clinical vignette")).toBeVisible();
  await expect(page.getByText("Select all that apply", { exact: false })).toBeVisible();
  await page.locator('.choice[data-answer="A"]').click();
  await page.locator('.choice[data-answer="C"]').click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.locator(".explanation strong")).toHaveText("Correct");

  await page.getByRole("button", { name: "Submit set" }).click();
  await expect(page.getByText("SET RESULTS")).toBeVisible();
  await expect(page.getByRole("heading", { name: "1/1 correct (100%)" })).toBeVisible();
});

test("preserves an unpackaged repository address and gives manual integration guidance", async ({ page }) => {
  await page.route("https://raw.githubusercontent.com/example/unpackaged/**", async (route) => {
    await route.fulfill({ status: 404, headers: corsHeaders, body: "not found" });
  });

  await page.goto("/");
  await page.locator("#githubBankUrlInput").fill("https://github.com/example/unpackaged");
  await page.getByRole("button", { name: "Import from GitHub" }).click();

  await expect(page.locator("#githubBankImportStatus")).toContainText("different structure");
  await page.reload();
  await expect(page.locator("#githubBankUrlInput")).toHaveValue("https://github.com/example/unpackaged");
  await expect(page.getByRole("button", { name: "Import from file" })).toBeVisible();
});
