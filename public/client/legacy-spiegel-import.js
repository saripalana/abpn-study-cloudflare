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
// Use the exact K&S clinical taxonomy for every Spiegel question so combined
// analytics and subject filters have one shared vocabulary across both banks.
// Rules are deterministic and run locally; no source content leaves the app.
export const KS_CLINICAL_SUBJECTS = Object.freeze([
  'Examination and Diagnosis of the Psychiatric Patient',
  'Neurodevelopmental Disorders and Other Childhood Disorders',
  'Neurocognitive Disorders',
  'Substance Use and Addictive Disorders',
  'Schizophrenia Spectrum and Other Psychotic Disorders',
  'Bipolar Disorders',
  'Depressive Disorder',
  'Anxiety Disorders',
  'Obsessive-Compulsive and Related Disorders',
  'Trauma- and Stressor-Related Disorders',
  'Dissociative Disorders',
  'Somatic Symptom and Related Disorders',
  'Feeding and Eating Disorders',
  'Elimination Disorders',
  'Sleep-Wake Disorders',
  'Human Sexuality and Sexual Dysfunctions',
  'Gender Dysphoria, Gender Identity, and Related Conditions',
  'Disruptive, Impulse Control, and Conduct Disorders',
  'Personality Disorders',
  'Other Conditions that May Be a Focus of Clinical Attention',
  'Psychopharmacology',
  'Other Somatic Therapies',
  'Psychotherapy',
  'Psychiatric Rehabilitation and Other Interventions',
  'Consult to Other Disciplines',
  'Level of Care',
  'Ethics and Professionalism',
  'Forensic and Legal Issues',
  'End-of-Life Issues and Palliative Care',
  'Community Psychiatry',
  'Global and Cultural Issues in Psychiatry',
  'Normal Development and Aging',
  'Contributions from the Neurosciences',
  'Contributions from the Behavioral and Social Sciences',
]);

const CLINICAL_SUBJECT_RULES = Object.freeze([
  [KS_CLINICAL_SUBJECTS[1], /\b(autis\w*|adhd|attention.deficit|intellectual disab\w*|learning disorder|tourette|tic disorder|childhood disorder)\b/gi],
  [KS_CLINICAL_SUBJECTS[2], /\b(dementia|delirium|alzheimer\w*|neurocognitive|memory loss|frontotemporal|lewy bod\w*)\b/gi],
  [KS_CLINICAL_SUBJECTS[3], /\b(alcohol|opioid|cocaine|amphetamine|substance|intoxicat\w*|withdrawal|addict\w*|nicotine|cannabis|hallucinogen)\b/gi],
  [KS_CLINICAL_SUBJECTS[4], /\b(psychos\w*|psychotic|schizophren\w*|delusion\w*|hallucinat\w*)\b/gi],
  [KS_CLINICAL_SUBJECTS[5], /\b(mania|manic|bipolar|cyclothymi\w*|lithium)\b/gi],
  [KS_CLINICAL_SUBJECTS[6], /\b(depress\w*|dysthymi\w*|bereavement|melanchol\w*)\b/gi],
  [KS_CLINICAL_SUBJECTS[7], /\b(anxiety|panic|phobi\w*|agoraphobi\w*|generalized anxiety)\b/gi],
  [KS_CLINICAL_SUBJECTS[8], /\b(obsess\w*|compuls\w*|body dysmorph\w*|hoarding|trichotillomania|excoriation)\b/gi],
  [KS_CLINICAL_SUBJECTS[9], /\b(ptsd|posttraumatic|post-traumatic|acute stress|trauma\w*|adjustment disorder)\b/gi],
  [KS_CLINICAL_SUBJECTS[10], /\b(dissociat\w*|depersonal\w*|derealiz\w*|dissociative identity|fugue)\b/gi],
  [KS_CLINICAL_SUBJECTS[11], /\b(somatic|conversion disorder|factitious|malinger\w*|illness anxiety)\b/gi],
  [KS_CLINICAL_SUBJECTS[12], /\b(anorexi\w*|bulimi\w*|binge.eating|feeding disorder|body mass index|pica|rumination disorder)\b/gi],
  [KS_CLINICAL_SUBJECTS[13], /\b(enuresis|encopresis|elimination disorder|bedwetting)\b/gi],
  [KS_CLINICAL_SUBJECTS[14], /\b(insomnia|narcolep\w*|parasomnia|sleep apnea|sleep.walk|night terror|rem sleep|circadian)\b/gi],
  [KS_CLINICAL_SUBJECTS[15], /\b(sexual dysfunction|erectile|orgasm|ejaculat\w*|paraphili\w*|sexual arousal|sexual desire)\b/gi],
  [KS_CLINICAL_SUBJECTS[16], /\b(gender dysphoria|gender identity|transgender|gender incongruence)\b/gi],
  [KS_CLINICAL_SUBJECTS[17], /\b(conduct disorder|oppositional|impulse.control|intermittent explosive|pyromania|kleptomania)\b/gi],
  [KS_CLINICAL_SUBJECTS[18], /\b(personality disorder|borderline|narcissis\w*|antisocial|histrionic|schizoid|schizotypal|avoidant personality|dependent personality|obsessive.compulsive personality)\b/gi],
  [KS_CLINICAL_SUBJECTS[19], /\b(relational problem|academic problem|occupational problem|homeless\w*|victim of abuse|focus of clinical attention)\b/gi],
  [KS_CLINICAL_SUBJECTS[20], /\b(antidepressant|antipsychotic|ssri|snri|maoi|benzodiazepine|psychotropic|pharmacokinetic|side effect|drug interaction|clozapine|valproate|carbamazepine)\b/gi],
  [KS_CLINICAL_SUBJECTS[21], /\b(ect|electroconvulsive|transcranial magnetic|vagus nerve stimulation|light therapy|deep brain stimulation)\b/gi],
  [KS_CLINICAL_SUBJECTS[22], /\b(psychotherap\w*|cognitive.behavior|psychoanaly\w*|transference|countertransference|defense mechanism|motivational interview|group therapy|family therapy)\b/gi],
  [KS_CLINICAL_SUBJECTS[23], /\b(rehabilitation|supported employment|assertive community treatment|social skills training|case management|recovery model)\b/gi],
  [KS_CLINICAL_SUBJECTS[24], /\b(transplant|dialysis|cancer|hiv|pregnan\w*|postpartum|medical illness|consultation.liaison|consult to)\b/gi],
  [KS_CLINICAL_SUBJECTS[25], /\b(inpatient|outpatient|partial hospital|residential treatment|level of care|hospitali[sz]\w*)\b/gi],
  [KS_CLINICAL_SUBJECTS[26], /\b(confidential\w*|informed consent|malpractice|boundary violation|ethic\w*|professionalism|dual relationship)\b/gi],
  [KS_CLINICAL_SUBJECTS[27], /\b(capacity|competenc\w*|duty to warn|forensic|insanity defense|criminal responsib\w*|commitment|court order)\b/gi],
  [KS_CLINICAL_SUBJECTS[28], /\b(end.of.life|palliative|hospice|terminal illness|advance directive|do.not.resuscitate|death and dying)\b/gi],
  [KS_CLINICAL_SUBJECTS[29], /\b(community psychiatry|public mental health|epidemiolog\w*|prevention program|community mental health)\b/gi],
  [KS_CLINICAL_SUBJECTS[30], /\b(cultur\w*|race|racial|ethnic\w*|immigrant|refugee|global mental health|cross-cultural)\b/gi],
  [KS_CLINICAL_SUBJECTS[31], /\b(attachment|developmental stage|piaget|erikson|object permanence|temperament|bonding|normal aging|adolescen\w*)\b/gi],
  [KS_CLINICAL_SUBJECTS[32], /\b(seizure|epilep\w*|stroke|migraine|parkinson\w*|multiple sclerosis|neuropath\w*|movement disorder|huntington\w*|neurotransmitter|brain region|neuroanatom\w*)\b/gi],
  [KS_CLINICAL_SUBJECTS[33], /\b(sensitivity|specificity|relative risk|odds ratio|confidence interval|p.value|statistical|study design|randomized controlled|conditioning|learning theory|social psychology)\b/gi],
]);

export function inferClinicalSubject(question) {
  const explicit = String(question?.subjectTitle || question?.subject || question?.domain || question?.topic || '').trim();
  if (explicit) return explicit;
  const localText = [question?.question, ...(question?.choices || []), question?.answerText, question?.explanation]
    .filter(Boolean).join(' ');
  let best = { title: KS_CLINICAL_SUBJECTS[0], score: 0 };
  for (const [title, pattern] of CLINICAL_SUBJECT_RULES) {
    pattern.lastIndex = 0;
    const score = [...localText.matchAll(pattern)].length;
    if (score > best.score) best = { title, score };
  }
  return best.title;
}

function convertQuestion(question, index, resolveImagePath) {
  const choices = Array.isArray(question?.choices) ? question.choices.map(String) : [];
  const choiceLetters = Array.isArray(question?.choiceLetters) && question.choiceLetters.length === choices.length
    ? question.choiceLetters.map(String)
    : choices.map((_, choiceIndex) => String.fromCharCode(65 + choiceIndex));
  const correctLetters = Array.isArray(question?.correctLetters) && question.correctLetters.length
    ? [...new Set(question.correctLetters.map(String))]
    : question?.correctLetter
      ? [String(question.correctLetter)]
      : [];
  // Spiegel source test/vignette labels are a distinct analytics dimension
  // from inferred clinical subjects. A source item without a section belongs
  // to the bank-wide fallback test rather than becoming a false subject.
  const section = String(question?.section || question?.vignetteName || "Test 1").trim();
  const explanation = String(question?.explanation || question?.answerText || "No explanation provided.");

  return {
    id: sourceQuestionId(question, index),
    chapter: String(question?.sectionType || ""),
    chapterTitle: section || "Test 1",
    subjectTitle: inferClinicalSubject(question),
    question: String(question?.question || ""),
    vignetteStem: String(question?.vignetteStem || ""),
    image: resolveImagePath(String(question?.image || "")),
    choices,
    choiceLetters,
    correctLetter: correctLetters[0] || "",
    correctLetters,
    isMultiSelect: Boolean(question?.isMultiSelect || correctLetters.length > 1),
    answerText: String(question?.answerText || ""),
    explanation,
  };
}

export async function convertLegacySpiegelScript(source, sourceUrl, { resolveImagePath = () => "" } = {}) {
  const questions = parseLegacySpiegelQuestions(source)
    .map((question, index) => convertQuestion(question, index, resolveImagePath));
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
      version: `legacy-ks-subjects-v2-${sourceChecksum.slice(0, 12)}`,
      sourceType: "user-imported",
      contentClass: "source-material",
      sourceLabel: "Spiegel Test Prep · dancingremote/spiegel-test-prep",
      questions,
    },
  };
}
