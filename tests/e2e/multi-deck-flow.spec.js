import { test, expect } from "@playwright/test";

const corsHeaders = { "access-control-allow-origin": "*" };

function legacySpiegelSource() {
  return `const QUESTIONS = ${JSON.stringify([{
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

test("combined K&S and Spiegel set survives reload, submission, history, and review", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("dialog", async (dialog) => dialog.accept());
  await page.addInitScript(() => {
    let shuffleCall = 0;
    Math.random = () => {
      shuffleCall += 1;
      return shuffleCall === 1 ? 0 : 0.999999;
    };
  });
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

  await page.locator("#bankSelect").selectOption("ks-psychiatry-core");
  await expect(page.locator("#bankSelect")).toHaveValue("ks-psychiatry-core");
  await page.locator("#deckScopeSelect").selectOption("all");
  await expect(page.locator("#deckScopeAvailability")).toContainText("2 study decks");
  await page.locator("#countInput").fill("2");
  await page.locator("#modeSelect").selectOption("tutor");
  await page.locator("#timingSelect").selectOption("untimed");
  await page.getByRole("button", { name: "Start combined randomized set" }).click();

  const questionMap = page.locator(".question-map button");
  await expect(questionMap).toHaveCount(2);
  const spiegelIndex = await page.locator(".exam .eyebrow").textContent().then((text) => text?.includes("Spiegel") ? 0 : 1);
  if (spiegelIndex === 1) await questionMap.nth(1).click();
  await expect(page.locator(".exam .eyebrow")).toContainText("Spiegel");
  await expect(page.getByText("Select all that apply", { exact: false })).toBeVisible();

  await page.locator('.choice[data-answer="A"]').click();
  await page.locator('.choice[data-answer="C"]').click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.locator(".explanation strong")).toHaveText("Correct");

  await page.getByRole("button", { name: "Save and exit" }).click();
  await expect(page.getByRole("button", { name: "Resume set" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume set" })).toBeVisible();
  await page.getByRole("button", { name: "Resume set" }).click();
  await expect(page.locator(".exam .eyebrow")).toContainText("Spiegel");
  await expect(page.locator(".explanation strong")).toHaveText("Correct");

  await page.getByRole("button", { name: "Submit set" }).click();
  await expect(page.getByText("SET RESULTS")).toBeVisible();
  await expect(page.getByRole("heading", { name: /1\/2 correct/ })).toBeVisible();
  await expect(page.getByText("Spiegel", { exact: true })).toBeVisible();
  await expect(page.getByText("K&S", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to dashboard" }).click();
  const reviewButton = page.locator(".review-history-btn").first();
  await expect(reviewButton).toBeVisible();
  await reviewButton.click();
  await expect(page.getByText("SET RESULTS")).toBeVisible();
  await expect(page.getByRole("heading", { name: /1\/2 correct/ })).toBeVisible();
  await page.getByRole("button", { name: "Review questions" }).click();
  await expect(page.locator(".exam .eyebrow")).toBeVisible();
});