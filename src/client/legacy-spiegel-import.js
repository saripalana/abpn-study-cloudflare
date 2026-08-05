import {
  QUESTION_BANK_PACKAGE_FORMAT,
  QUESTION_BANK_PACKAGE_SCHEMA_VERSION,
  sha256Hex,
} from "./question-bank-import.js";

if (typeof document !== "undefined" && !document.querySelector('link[data-spiegel-question-styles]')) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/multiselect-questions.css";
  link.dataset.spiegelQuestionStyles = "true";
  document.head.append(link);
}

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

// The legacy Spiegel source identifies practice-test sections but contains no
// subject field. Classify it locally during conversion so study analytics use
// clinical subjects instead of misleading labels such as "Test 1". Only the
// resulting label is stored; source content is never sent to a service.
const CLINICAL_SUBJECT_RULES = Object.freeze([
  ['Mood disorders', /\b(depress\w*|mania|manic|bipolar|dysthymi\w*|cyclothymi\w*|lithium)\b/gi],
  ['Psychotic disorders', /\b(psychos\w*|psychotic|schizophren\w*|delusion\w*|hallucinat\w*|antipsychotic)\b/gi],
  ['Anxiety, trauma, and obsessive-compulsive disorders', /\b(anxiety|panic|phobi\w*|obsess\w*|compuls\w*|ptsd|posttraumatic|trauma\w*)\b/gi],
  ['Substance-related and addictive disorders', /\b(alcohol|opioid|cocaine|amphetamine|substance|intoxicat\w*|withdrawal|addict\w*|nicotine|cannabis)\b/gi],
  ['Child and adolescent psychiatry', /\b(child|adolescen\w*|autis\w*|adhd|attention.deficit|conduct disorder|oppositional|school refusal)\b/gi],
  ['Neurocognitive disorders', /\b(dementia|delirium|alzheimer\w*|neurocognitive|memory loss|frontotemporal|lewy bod\w*)\b/gi],
  ['Neurology', /\b(seizure|epilep\w*|stroke|migraine|parkinson\w*|multiple sclerosis|neuropath\w*|movement disorder|huntington\w*)\b/gi],
  ['Sleep-wake disorders', /\b(insomnia|narcolep\w*|parasomnia|sleep apnea|sleep.walk|night terror|rem sleep)\b/gi],
  ['Eating and feeding disorders', /\b(anorexi\w*|bulimi\w*|binge.eating|feeding disorder|body mass index|weight loss)\b/gi],
  ['Personality disorders', /\b(personality disorder|borderline|narcissis\w*|antisocial|histrionic|schizoid|schizotypal|avoidant personality|dependent personality)\b/gi],
  ['Somatic symptom and dissociative disorders', /\b(somatic|conversion disorder|dissociat\w*|factitious|malinger\w*|illness anxiety)\b/gi],
  ['Psychotherapy', /\b(psychotherap\w*|cognitive.behavior|psychoanaly\w*|transference|countertransference|defense mechanism|motivational interview)\b/gi],
  ['Psychopharmacology', /\b(antidepressant|ssri|snri|maoi|benzodiazepine|psychotropic|pharmacokinetic|side effect|drug interaction)\b/gi],
  ['Consultation-liaison psychiatry', /\b(transplant|dialysis|cancer|hiv|pregnan\w*|postpartum|medical illness|consultation.liaison)\b/gi],
  ['Emergency psychiatry', /\b(suicid\w*|homicid\w*|agitat\w*|violent|restraint|psychiatric emergency)\b/gi],
  ['Forensic psychiatry and ethics', /\b(capacity|competenc\w*|confidential\w*|informed consent|malpractice|duty to warn|forensic|insanity defense|ethic\w*)\b/gi],
  ['Human development', /\b(attachment|developmental stage|piaget|erikson|object permanence|temperament|bonding)\b/gi],
  ['Research methods and statistics', /\b(sensitivity|specificity|relative risk|odds ratio|confidence interval|p.value|statistical|study design|randomized controlled)\b/gi],
]);

export function inferClinicalSubject(question) {
  const explicit = String(question?.subjectTitle || question?.subject || question?.domain || question?.topic || '').trim();
  if (explicit) return explicit;
  const localText = [question?.question, ...(question?.choices || []), question?.answerText, question?.explanation]
    .filter(Boolean).join(' ');
  let best = { title: 'General psychiatry', score: 0 };
  for (const [title, pattern] of CLINICAL_SUBJECT_RULES) {
    pattern.lastIndex = 0;
    const score = [...localText.matchAll(pattern)].length;
    if (score > best.score) best = { title, score };
  }
  return best.title;
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
    subjectTitle: inferClinicalSubject(question),
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
      version: `legacy-subjects-${sourceChecksum.slice(0, 12)}`,
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: "Spiegel Test Prep · dancingremote/spiegel-test-prep",
      questions,
    },
  };
}
