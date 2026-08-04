import test from "node:test";
import assert from "node:assert/strict";
import {
  convertLegacySpiegelScript,
  parseLegacySpiegelQuestions,
} from "../public/client/legacy-spiegel-import.js";
import {
  calculateSetResult,
  isQuestionAnswerCorrect,
  normalizeBank,
} from "../public/client/study-engine.js";

const sourceQuestions = [{
  id: "test1-q1",
  section: "Test 1",
  sectionType: "test",
  question: "Choose the single correct option.",
  choices: ["Incorrect", "Correct", "Incorrect"],
  choiceLetters: ["A", "B", "C"],
  correctLetters: ["B"],
  isMultiSelect: false,
  explanation: "B is correct.",
}, {
  id: "vignette1-q1",
  section: "Vignette 1",
  sectionType: "vignette",
  vignetteStem: "A clinical stem shared by linked questions.",
  question: "Select all correct findings.",
  choices: ["Finding A", "Distractor", "Finding C"],
  choiceLetters: ["A", "B", "C"],
  correctLetters: ["A", "C"],
  isMultiSelect: true,
  answerText: "A and C",
  explanation: "Both A and C are required; partial credit is not awarded.",
}];

const legacyScript = `const QUESTIONS = \uFEFF${JSON.stringify(sourceQuestions)};`;

test("parses the legacy QUESTIONS array without evaluating JavaScript", () => {
  const parsed = parseLegacySpiegelQuestions(`${legacyScript}\nthrow new Error('must never execute');`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].vignetteStem, sourceQuestions[1].vignetteStem);
});

test("converts Spiegel questions into an isolated, versioned ABPN bank", async () => {
  const converted = await convertLegacySpiegelScript(
    legacyScript,
    "https://raw.githubusercontent.com/dancingremote/spiegel-test-prep/main/data.js",
  );
  assert.equal(converted.format, "abpn-question-bank");
  assert.equal(converted.bank.id, "spiegel-test-prep");
  assert.equal(converted.bank.questions.length, 2);
  assert.match(converted.bank.version, /^legacy-[a-f0-9]{12}$/);
  assert.equal(converted.bank.questions[1].isMultiSelect, true);
  assert.deepEqual(converted.bank.questions[1].correctLetters, ["A", "C"]);
  assert.equal(converted.bank.questions[1].vignetteStem, sourceQuestions[1].vignetteStem);
});

test("scores multi-select questions only when the exact correct set is selected", async () => {
  const converted = await convertLegacySpiegelScript(legacyScript, "https://example.invalid/data.js");
  const bank = normalizeBank(converted.bank);
  const question = bank.byId.get("vignette1-q1");
  assert.equal(question.linkedGroupId, "spiegel-test-prep:vignette:Vignette 1");
  assert.equal(question.linkedOrder, 1);
  assert.equal(isQuestionAnswerCorrect(question, ["A", "C"]), true);
  assert.equal(isQuestionAnswerCorrect(question, ["C", "A"]), true);
  assert.equal(isQuestionAnswerCorrect(question, ["A"]), false);
  assert.equal(isQuestionAnswerCorrect(question, ["A", "B", "C"]), false);

  const answers = new Map([
    ["test1-q1", { selectedAnswer: "B" }],
    ["vignette1-q1", { selectedAnswer: ["A"] }],
  ]);
  assert.deepEqual(calculateSetResult(["test1-q1", "vignette1-q1"], answers, bank), {
    total: 2,
    answered: 2,
    omitted: 0,
    correct: 1,
    incorrect: 1,
  });
});
