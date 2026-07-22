import {
  QUESTION_BANK_PACKAGE_FORMAT,
  QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
  sha256Hex,
} from "./question-bank-import.js";

function extractJsonArray(source) {
  const marker = /(?:const|let|var)\s+QUESTIONS\s*=/.exec(source);
  if (!marker) throw new Error("The legacy source does not define a QUESTIONS array.");
  const start = source.indexOf("[", marker.index + marker[0].length);
  if (start < 0) throw new Error("The legacy QUESTIONS array could not be found.");

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1).replace(/^\uFEFF/, "");
    }
  }
  throw new Error("The legacy QUESTIONS array is incomplete.");
}

export function parseLegacySpiegelQuestions(source) {
  const text = String(source || "").replace(/\uFEFF/g, "");
  let parsed;
  try {
    parsed = JSON.parse(extractJsonArray(text));
  } catch (error) {
    throw new Error(`The Spiegel data.js QUESTIONS array is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("The Spiegel data.js file contains no questions.");
  }
  return parsed;
}

function sourceQuestionId(question, index) {
  const candidate = String(question?.id || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)
    ? candidate
    : `spiegel-${index + 1}`;
}

function convertQuestion(question, index) {
  const choices = Array.isArray(question?.choices) ? question.choices.map(String) : [];
  const choiceLetters = Array.isArray(question?.choiceLetters) && question.choiceLetters.length === choices.length
    ? question.choiceLetters.map(String)
    : choices.map((_, choiceIndex) => String.fromCharCode(65 + choiceIndex));
  const correctLetters = Array.isArray(question?.correctLetters) && question.correctLetters.length
    ? [...new Set(question.correctLetters.map(String))]
    : question?.correctLetter
      ? [String(question.correctLetter)]
      : [];
  const section = String(question?.section || question?.vignetteName || "Spiegel Test Prep").trim();
  const explanation = String(question?.explanation || question?.answerText || "No explanation provided.");

  return {
    id: sourceQuestionId(question, index),
    chapter: String(question?.sectionType || ""),
    chapterTitle: section || "Spiegel Test Prep",
    question: String(question?.question || ""),
    vignetteStem: String(question?.vignetteStem || ""),
    choices,
    choiceLetters,
    correctLetter: correctLetters[0] || "",
    correctLetters,
    isMultiSelect: Boolean(question?.isMultiSelect || correctLetters.length > 1),
    answerText: String(question?.answerText || ""),
    explanation,
  };
}

export async function convertLegacySpiegelScript(source, sourceUrl) {
  const questions = parseLegacySpiegelQuestions(source).map(convertQuestion);
  const sourceChecksum = await sha256Hex(String(source || ""));
  const multiSelectCount = questions.filter((question) => question.isMultiSelect).length;
  return {
    format: QUESTION_BANK_PACKAGE_FORMAT,
    schemaVersion: QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
    convertedFrom: "legacy-spiegel-data-js",
    sourceUrl,
    bank: {
      id: "spiegel-test-prep",
      title: "Spiegel Test Prep Question Bank",
      shortTitle: "Spiegel Test Prep",
      description: `Psychiatry Test Preparation & Review Manual study questions imported from the legacy Spiegel Test Prep site. Includes ${multiSelectCount} select-all-that-apply question${multiSelectCount === 1 ? "" : "s"}.`,
      version: `legacy-${sourceChecksum.slice(0, 12)}`,
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: "Spiegel Test Prep · dancingremote/spiegel-test-prep",
      questions,
    },
  };
}
