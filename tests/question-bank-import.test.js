import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MAX_QUESTIONS_PER_BANK,
  analyzeQuestionBankUpdate,
  prepareQuestionBankPackage,
} from "../src/client/question-bank-import.js";

const packageDefinition = ({
  id = "import-test-bank",
  version = "1.0.0",
  sourceType = "user-imported",
  contentClass = "source-material",
  questions = null,
} = {}) => ({
  format: "abpn-question-bank",
  schemaVersion: 1,
  bank: {
    id,
    title: "Import Test Bank",
    shortTitle: "Import Bank",
    description: "Used only by automated validation.",
    version,
    sourceType,
    contentClass,
    sourceLabel: "Automated test fixture",
    questions: questions ?? [
      {
        id: `${id}-1`,
        chapterTitle: "Import Safety",
        question: "Which answer is correct?",
        choices: ["First", "Second", "Third", "Fourth"],
        choiceLetters: ["A", "B", "C", "D"],
        correctLetter: "B",
        explanation: "Second is correct."
      }
    ]
  }
});

test("prepares a normalized package with a deterministic checksum", async () => {
  const first = await prepareQuestionBankPackage(packageDefinition());
  const second = await prepareQuestionBankPackage(packageDefinition());
  assert.equal(first.bank.id, "import-test-bank");
  assert.equal(first.bank.questions.length, 1);
  assert.equal(first.checksum, second.checksum);
  assert.match(first.checksum, /^[a-f0-9]{64}$/);
  assert.equal(first.bank.contentClass, "source-material");
  assert.equal(Object.hasOwn(first.bank.questions[0], "linkedGroupId"), false);
  assert.equal(Object.hasOwn(first.bank.questions[0], "linkedOrder"), false);
});

test("question images are restricted to verified application-owned Spiegel assets", async () => {
  const approved = packageDefinition({ questions: [{
    ...packageDefinition().bank.questions[0],
    image: "/banks/generated/spiegel-images/test1-q1.png",
  }] });
  const prepared = await prepareQuestionBankPackage(approved);
  assert.equal(prepared.bank.questions[0].image, "/banks/generated/spiegel-images/test1-q1.png");

  const external = packageDefinition({ questions: [{
    ...packageDefinition().bank.questions[0],
    image: "https://example.invalid/question.png",
  }] });
  await assert.rejects(() => prepareQuestionBankPackage(external), /unsupported image path/i);
});

test("application seeds use the same normalized unprivileged package contract", async () => {
  const prepared = await prepareQuestionBankPackage(packageDefinition({
    id: "seed-bank",
    sourceType: "application-seed",
  }));
  assert.equal(prepared.bank.sourceType, "application-seed");
  assert.equal(prepared.bank.protected, false);
  assert.match(prepared.bank.checksum, /^[a-f0-9]{64}$/);
});

test("preserves explicit linked-question metadata without adding it to unlinked questions", async () => {
  const linked = await prepareQuestionBankPackage(packageDefinition({ questions: [
    { id: "case-1", chapterTitle: "Case", linkedGroupId: "case-a", linkedOrder: 0, question: "Start?", choices: ["A", "B"], correctLetter: "A", explanation: "" },
    { id: "case-2", chapterTitle: "Case", linkedGroupId: "case-a", linkedOrder: 1, question: "Follow-up?", choices: ["A", "B"], correctLetter: "B", explanation: "" },
    { id: "solo", chapterTitle: "Other", question: "Solo?", choices: ["A", "B"], correctLetter: "A", explanation: "" },
  ] }));
  assert.deepEqual(linked.bank.questions.slice(0, 2).map((question) => [question.linkedGroupId, question.linkedOrder]), [
    ["case-a", 0], ["case-a", 1],
  ]);
  assert.equal(Object.hasOwn(linked.bank.questions[2], "linkedGroupId"), false);
});

test("hidden system fixture ids remain reserved from user packages", async () => {
  await assert.rejects(
    () => prepareQuestionBankPackage(packageDefinition({ id: "validation-bank" }), {
      reservedIds: ["validation-bank"],
    }),
    /reserved for a hidden system-validation fixture/i
  );
});

test("assistant content cannot be mislabeled as source material", async () => {
  await assert.rejects(
    () => prepareQuestionBankPackage(packageDefinition({
      sourceType: "assistant-supplemental",
      contentClass: "source-material",
    })),
    /Assistant-created material must remain/i
  );
});

test("question bank size is capped at five thousand questions", async () => {
  const questions = Array.from({ length: MAX_QUESTIONS_PER_BANK + 1 }, (_, index) => ({
    id: `oversized-${index + 1}`,
    chapterTitle: "Capacity",
    question: `Question ${index + 1}`,
    choices: ["A", "B"],
    choiceLetters: ["A", "B"],
    correctLetter: "A",
    explanation: "Capacity test",
  }));
  await assert.rejects(
    () => prepareQuestionBankPackage(packageDefinition({ id: "oversized", questions })),
    /at most 5,000 questions/i
  );
});

test("additive version updates remain safe after progress exists", async () => {
  const existing = (await prepareQuestionBankPackage(packageDefinition())).bank;
  const incoming = (await prepareQuestionBankPackage(packageDefinition({
    version: "1.1.0",
    questions: [
      ...packageDefinition().bank.questions,
      {
        id: "import-test-bank-2",
        chapterTitle: "Import Safety",
        question: "Can a safe update add a new question?",
        choices: ["Yes", "No"],
        choiceLetters: ["A", "B"],
        correctLetter: "A",
        explanation: "Additive updates preserve existing question identities."
      }
    ]
  }))).bank;
  const result = analyzeQuestionBankUpdate(existing, incoming, { hasStudyData: true });
  assert.equal(result.status, "update");
  assert.equal(result.additive, true);
  assert.equal(result.addedQuestions, 1);
});

test("changing an existing question is rejected after progress exists", async () => {
  const existing = (await prepareQuestionBankPackage(packageDefinition())).bank;
  const changedQuestion = {
    ...packageDefinition().bank.questions[0],
    question: "This question text changed after study progress existed."
  };
  const incoming = (await prepareQuestionBankPackage(packageDefinition({
    version: "2.0.0",
    questions: [changedQuestion],
  }))).bank;
  assert.throws(
    () => analyzeQuestionBankUpdate(existing, incoming, { hasStudyData: true }),
    /Import it under a new bank id/i
  );
});

test("verified catalog seeds can advance an immutable source revision without weakening ordinary imports", async () => {
  const existing = (await prepareQuestionBankPackage(packageDefinition({
    id: "seed-bank",
    sourceType: "application-seed",
  }))).bank;
  const incoming = (await prepareQuestionBankPackage(packageDefinition({
    id: "seed-bank",
    version: "2.0.0",
    sourceType: "application-seed",
    questions: [{
      ...packageDefinition({ id: "seed-bank" }).bank.questions[0],
      id: "seed-bank-1",
      correctLetters: ["A", "B"],
      isMultiSelect: true,
    }],
  }))).bank;

  assert.throws(
    () => analyzeQuestionBankUpdate(existing, incoming, { hasStudyData: true }),
    /Import it under a new bank id/i,
  );
  const verified = analyzeQuestionBankUpdate(existing, incoming, {
    hasStudyData: true,
    allowVerifiedCatalogSeedUpdate: true,
  });
  assert.equal(verified.status, "update");
  assert.equal(verified.verifiedCatalogSeedUpdate, true);
  assert.equal(verified.additive, false);
});

test("verified bundled catalog updates can retain user-imported source provenance", async () => {
  const existing = (await prepareQuestionBankPackage(packageDefinition({
    id: "approved-catalog-bank",
    sourceType: "user-imported",
  }))).bank;
  const incoming = (await prepareQuestionBankPackage(packageDefinition({
    id: "approved-catalog-bank",
    version: "2.0.0",
    sourceType: "user-imported",
    questions: [{
      ...packageDefinition({ id: "approved-catalog-bank" }).bank.questions[0],
      id: "approved-catalog-bank-1",
      explanation: "A corrected explanation from the application-bundled catalog.",
    }],
  }))).bank;

  assert.throws(
    () => analyzeQuestionBankUpdate(existing, incoming, { hasStudyData: true }),
    /Import it under a new bank id/i,
  );
  const verified = analyzeQuestionBankUpdate(existing, incoming, {
    hasStudyData: true,
    allowVerifiedCatalogSeedUpdate: true,
  });
  assert.equal(verified.status, "update");
  assert.equal(verified.verifiedCatalogSeedUpdate, true);
});

test("changed content requires a new version even before progress exists", async () => {
  const existing = (await prepareQuestionBankPackage(packageDefinition())).bank;
  const changedQuestion = {
    ...packageDefinition().bank.questions[0],
    explanation: "Changed explanation without a version increment."
  };
  const incoming = (await prepareQuestionBankPackage(packageDefinition({ questions: [changedQuestion] }))).bank;
  assert.throws(
    () => analyzeQuestionBankUpdate(existing, incoming, { hasStudyData: false }),
    /new bank version/i
  );
});

test("browser and source import, storage, and study-engine modules remain identical", async () => {
  const pairs = [
    ["src/client/question-bank-import.js", "public/client/question-bank-import.js"],
    ["src/client/storage.js", "public/client/storage.js"],
    ["src/client/study-engine.js", "public/client/study-engine.js"],
    ["src/client/exam-countdown.js", "public/client/exam-countdown.js"],
  ];
  for (const [sourcePath, publicPath] of pairs) {
    const [source, browser] = await Promise.all([
      readFile(new URL(`../${sourcePath}`, import.meta.url), "utf8"),
      readFile(new URL(`../${publicPath}`, import.meta.url), "utf8"),
    ]);
    assert.equal(browser, source, `${publicPath} must match ${sourcePath}`);
  }
});

test("IndexedDB version two creates separate content and revision stores", async () => {
  const storage = await readFile(new URL("../src/client/storage.js", import.meta.url), "utf8");
  assert.match(storage, /DB_VERSION = 2/);
  assert.match(storage, /BANK_CONTENT: "questionBankContent"/);
  assert.match(storage, /BANK_REVISIONS: "questionBankRevisions"/);
  assert.match(storage, /keyPath: \["bankId", "checksum"\]/);
});
