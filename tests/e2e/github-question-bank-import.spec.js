import { test, expect } from "@playwright/test";
import { expectActiveBank, selectActiveBank } from "./helpers/active-bank.mjs";

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

  await expectActiveBank(page, "github-browser-bank");
  await expect(page.getByRole("heading", { name: "GitHub Browser Question Bank" })).toBeVisible();
  await expect(page.getByText("GitHub browser fixture")).toBeVisible();
  await expect(page.getByText("1 questions loaded.", { exact: false })).toBeVisible();
});

test("loads the approved Spiegel package without requiring a repeated import", async ({ page }) => {
  await page.goto("/");
  await selectActiveBank(page, "spiegel-test-prep");
  await expect(page.getByRole("heading", { name: "Spiegel Test Prep Question Bank" })).toBeVisible();
  await expect(page.getByText("Spiegel Test Prep · dancingremote/spiegel-test-prep")).toBeVisible();
  await expect(page.getByText("1060 questions loaded.", { exact: false })).toBeVisible();
  await expect(page.locator(".source-organization-summary")).toContainText("6 source tests · 20 vignettes");
  const sourcePicker = page.locator("#sourceSectionPicker");
  await sourcePicker.locator("summary").click();
  await expect(sourcePicker.getByRole("heading", { name: "Tests" })).toBeVisible();
  await expect(sourcePicker.getByRole("heading", { name: "Vignettes" })).toBeVisible();
  await page.locator("#clearSourceSectionsBtn").click();
  await sourcePicker.locator('input[name="sourceSectionFilter"][value="Vignette 1"]').check();
  await expect(page.locator("#eligibleCount")).toContainText("10 questions available");

  const imageQuestionId = await page.evaluate(async () => {
    const { QUESTION_BANKS } = await import("/banks/catalog.js");
    return QUESTION_BANKS.find((bank) => bank.id === "spiegel-test-prep")
      ?.questions.find((question) => question.image)?.id || "";
  });
  expect(imageQuestionId).toBeTruthy();
  await page.locator(`.question-browser-number[data-question-id="${imageQuestionId}"]`).dblclick();
  const image = page.locator('.question-image img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
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
