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
  const allStatuses = page.locator('input[name="questionStatusFilter"][value="all"]');
  await allStatuses.uncheck();
  await expect(page.getByRole("button", { name: "Start combined set" })).toBeDisabled();
  await expect(page.locator("#eligibleCount")).toContainText("Select at least one question status");
  await allStatuses.check();
  await expect(page.getByRole("button", { name: "Start combined set" })).toBeEnabled();
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
  await expect(page.locator(".exam-head .eyebrow")).toBeVisible();
});

test("special retest criteria preserve multi-answer behavior and show a dated answer log", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("dialog", async (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator("#importBankBtn")).toBeEnabled();
  await page.locator("#bankImportInput").setInputFiles({
    name: "combined-flow-deck.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(combinedDeckPackage())),
  });
  await expectActiveBank(page, "combined-flow-deck");

  await page.locator("#countInput").fill("1");
  await page.locator("#modeSelect").selectOption("tutor");
  await page.locator("#timingSelect").selectOption("untimed");
  await page.getByRole("button", { name: "Start set" }).click();
  await page.locator('.choice[data-answer="A"]').click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.locator(".explanation strong")).toContainText("Correct answers");
  await page.getByRole("button", { name: "Flag question" }).click();
  await page.getByRole("button", { name: "Submit set" }).click();
  await page.getByRole("button", { name: "Back to dashboard" }).click();

  await page.locator('input[name="questionStatusFilter"][value="new"]').check();
  await page.locator("#specialCriteriaPicker summary").click();
  await page.locator("#rangeStartInput").fill("1");
  await page.locator("#rangeEndInput").fill("1");
  await page.locator("#includeFlaggedInput").check();
  await expect(page.locator("#eligibleCount")).toContainText("1 question available");
  await page.locator("#modeSelect").selectOption("test");
  await page.getByRole("button", { name: "Start set" }).click();

  const mapButton = page.locator(".question-map button").first();
  await expect(mapButton).toHaveClass(/previously-attempted/);
  await expect(mapButton).not.toHaveClass(/incorrect-answer/);
  await page.locator('.choice[data-answer="A"]').click();
  await page.locator('.choice[data-answer="C"]').click();
  await page.getByRole("button", { name: "Submit set" }).click();
  await expect(page.getByRole("heading", { name: /1\/1 correct/ })).toBeVisible();
  await page.getByRole("button", { name: "Review all questions" }).click();

  await expect(page.getByRole("heading", { name: "Answer log" })).toBeVisible();
  await expect(page.locator(".answer-history-log li")).toHaveCount(2);
  await expect(page.locator(".answer-history-log")).toContainText("Answer A, C");
  await expect(page.locator(".answer-history-log")).toContainText("Answer A");
  await expect(page.locator(".answer-history-log")).toContainText("This test");
  await expect(page.locator(".answer-history-log")).toContainText(/\w{3} \d{1,2}, \d{4}/);

  await page.getByRole("button", { name: "Back to test summary" }).click();
  await page.getByRole("button", { name: "Back to dashboard" }).click();
  await expect(page.locator(".history-item")).toHaveCount(2);
  await expect(page.locator(".history-item").first()).toContainText("question range 1–1");
  await expect(page.locator(".history-item").first()).toContainText("flagged questions included");
});
