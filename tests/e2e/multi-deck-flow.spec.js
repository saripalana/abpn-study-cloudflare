import { test, expect } from "@playwright/test";
import { expectActiveBank, selectActiveBank } from "./helpers/active-bank.mjs";

function combinedDeckPackage() {
  return {
    format: "abpn-question-bank",
    schemaVersion: 1,
    bank: {
      id: "combined-flow-deck",
      title: "Combined Flow Question Bank",
      shortTitle: "Combined Flow",
      description: "A one-question browser fixture for combined-session persistence.",
      version: "1.0.0",
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: "Combined-flow browser fixture",
      questions: [{
        id: "combined-flow-1",
        chapterTitle: "Combined Flow",
        question: "Which two choices validate the combined flow?",
        choices: ["First", "Distractor", "Third"],
        choiceLetters: ["A", "B", "C"],
        correctLetters: ["A", "C"],
        isMultiSelect: true,
        explanation: "The combined session preserves source-bound answers.",
      }],
    },
  };
}

test("combined K&S and added-deck set survives reload, submission, history, and review", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("dialog", async (dialog) => dialog.accept());
  await page.addInitScript(() => {
    let shuffleCall = 0;
    Math.random = () => {
      shuffleCall += 1;
      return shuffleCall === 1 ? 0 : 0.999999;
    };
  });
  await page.goto("/");
  await expectActiveBank(page, "ks-psychiatry-core");
  await expect(page.locator("#importBankBtn")).toBeEnabled();

  await page.locator("#bankImportInput").setInputFiles({
    name: "combined-flow-deck.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(combinedDeckPackage())),
  });
  await expectActiveBank(page, "combined-flow-deck");

  await selectActiveBank(page, "ks-psychiatry-core");
  await page.locator("#deckScopeSelect").selectOption("custom");
  await page.locator("#deckPicker summary").click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.locator('input[name="practiceDeckFilter"][value="ks-psychiatry-core"]').check();
  await page.locator('input[name="practiceDeckFilter"][value="combined-flow-deck"]').check();
  await expect(page.locator("#deckScopeAvailability")).toContainText("2 selected decks");
  await page.locator("#countInput").fill("2");
  await page.locator("#modeSelect").selectOption("tutor");
  await page.locator("#timingSelect").selectOption("untimed");
  await page.evaluate(() => {
    Math.random = () => 0.999999;
  });
  await page.getByRole("button", { name: "Start combined set" }).click();

  const questionMap = page.locator(".question-map button");
  await expect(questionMap).toHaveCount(2);
  const combinedIndex = await page.locator(".exam .eyebrow").textContent().then((text) => text?.includes("Combined Flow") ? 0 : 1);
  if (combinedIndex === 1) await questionMap.nth(1).click();
  await expect(page.locator(".exam .eyebrow")).toContainText("Combined Flow");
  await page.locator('.choice[data-answer="A"]').click();
  await page.locator('.choice[data-answer="C"]').click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.locator(".explanation strong")).toHaveText("Correct");

  await page.getByRole("button", { name: "Save and exit" }).click();
  await expect(page.getByRole("button", { name: "Resume set" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume set" })).toBeVisible();
  await page.getByRole("button", { name: "Resume set" }).click();
  await expect(page.locator(".exam .eyebrow")).toContainText("Combined Flow");
  await expect(page.locator(".explanation strong")).toBeVisible();

  await page.getByRole("button", { name: "Submit set" }).click();
  await expect(page.getByText("SET RESULTS")).toBeVisible();
  await expect(page.getByRole("heading", { name: /1\/2 correct/ })).toBeVisible();
  await expect(page.getByText("Combined Flow", { exact: true })).toBeVisible();
  await expect(page.getByText("K&S Psychiatry", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to dashboard" }).click();
  await expect(page.locator(".history-item").first()).toContainText("Decks: Combined Flow + K&S Psychiatry");
  const reviewButton = page.locator(".review-history-btn").first();
  await expect(reviewButton).toBeVisible();
  await reviewButton.click();
  await expect(page.getByText("SET RESULTS")).toBeVisible();
  await expect(page.getByRole("heading", { name: /1\/2 correct/ })).toBeVisible();
  await page.getByRole("button", { name: "Review all questions" }).click();
  await expect(page.locator(".exam .eyebrow")).toBeVisible();
});
