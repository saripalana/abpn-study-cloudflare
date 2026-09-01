import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { convertLegacySpiegelScript } from '../src/client/legacy-spiegel-import.js';

const ksSource = Object.freeze({
  // The original read-only repository is the authoritative K&S source. Pinning
  // an immutable commit keeps builds reproducible even if its main branch moves.
  repository: 'dancingremote/ks-study-guide',
  commit: '020aae0f5c55ad3bb0c122760c7b7d3fe26f1b46',
  path: 'data.js',
  expectedGitBlobSha: 'da048a097ee9d2bca4142a0e2e7444fe21b5da2e',
  expectedQuestionCount: 602,
});

const ksChoiceNormalization = Object.freeze({
  id: 'exact-duplicate-choice-dedup-v1',
  expectedQuestionIds: Object.freeze(['k-33.18', 'k-34.28']),
});

const spiegelSource = Object.freeze({
  repository: 'dancingremote/spiegel-test-prep',
  commit: '67922b76a181f7aaa15e9b74e18850019add360b',
  path: 'data.js',
  expectedGitBlobSha: '2a39e53c784d9067892197018186375500116abd',
  expectedQuestionCount: 1060,
  expectedVersion: 'legacy-ks-subjects-v2-f5c34b4ef2ad',
});

const spiegelImages = Object.freeze([
  ['images/test1-q143.png', '6a1c4cd2964c1ccae94f25ad6b5a15833cd1afac'],
  ['images/test2-q32.png', '64ff3efcf1ae0a051fb338d018f084227600c856'],
  ['images/test3-q22.png', '3cdb78bb08ee06ee777ece885d222bfe05c2b80c'],
  ['images/test3-q56.png', 'a940d6e2a062a9cf475369f3697b79aa4c5088f6'],
  ['images/test4-q32.png', 'bd097574d0bb54be530e941cd953ac33d313a733'],
  ['images/test4-q92.png', 'acdb815b57814e300aaab358aec7781d678cb8d5'],
  ['images/test5-q10.png', 'dc05d7d6ae0adb8e0ab15f15ab6d189008d87ae3'],
  ['images/test5-q62.png', 'a0512eca656ede6a965f03cb1171053c1ba2421c'],
  ['images/test5-q70.png', '27b577a70a19e67abd18aa1aa85072f687a62f77'],
  ['images/test5-q77.png', '0c6f715d42696c05549892ea82b923923d408a3c'],
].map(([imagePath, expectedGitBlobSha]) => Object.freeze({
  ...spiegelSource,
  path: imagePath,
  expectedGitBlobSha,
})));

async function readPinnedSource(source, label) {
  const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
  const response = await fetch(url, { headers: { 'user-agent': 'abpn-study-cloudflare-bank-import' } });
  if (!response.ok) throw new Error(`Unable to retrieve pinned ${label} source: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const gitBlobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (gitBlobSha !== source.expectedGitBlobSha) {
    throw new Error(`${label} source hash mismatch: expected ${source.expectedGitBlobSha}, received ${gitBlobSha}`);
  }
  return { bytes, gitBlobSha, url };
}

const { bytes, gitBlobSha } = await readPinnedSource(ksSource, 'K&S');

const code = bytes.toString('utf8').replace(/^\uFEFF/, '');
const sandbox = Object.create(null);
vm.createContext(sandbox);
vm.runInContext(`${code}\n;globalThis.__QUESTIONS__ = QUESTIONS;`, sandbox, { timeout: 5000 });
const sourceQuestions = sandbox.__QUESTIONS__;
if (!Array.isArray(sourceQuestions) || sourceQuestions.length !== ksSource.expectedQuestionCount) {
  throw new Error(`K&S count mismatch: expected ${ksSource.expectedQuestionCount}, received ${Array.isArray(sourceQuestions) ? sourceQuestions.length : 'non-array'}`);
}

function choiceIdentity(value) {
  return String(value ?? '').normalize('NFC').trim();
}

function collapseExactDuplicateChoices(question) {
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  const letters = Array.isArray(question?.choiceLetters) ? question.choiceLetters.map(String) : [];
  const correctLetters = Array.isArray(question?.correctLetters) && question.correctLetters.length
    ? question.correctLetters.map(String)
    : [String(question?.correctLetter || '')];
  const correct = new Set(correctLetters);
  const groups = new Map();
  choices.forEach((choice, index) => {
    const key = choiceIdentity(choice);
    const indexes = groups.get(key) || [];
    indexes.push(index);
    groups.set(key, indexes);
  });
  const duplicateGroups = [...groups.values()].filter((indexes) => indexes.length > 1);
  if (!duplicateGroups.length) return { question, changed: false };

  const retainedIndexes = new Set();
  const letterRemap = new Map();
  for (const indexes of groups.values()) {
    const retainedIndex = indexes.find((index) => correct.has(letters[index])) ?? indexes[0];
    retainedIndexes.add(retainedIndex);
    for (const index of indexes) letterRemap.set(letters[index], letters[retainedIndex]);
  }
  const nextCorrectLetters = [...new Set(correctLetters.map((letter) => letterRemap.get(letter) || letter))];
  return {
    changed: true,
    question: {
      ...question,
      choices: choices.filter((_, index) => retainedIndexes.has(index)),
      choiceLetters: letters.filter((_, index) => retainedIndexes.has(index)),
      correctLetter: nextCorrectLetters[0],
      correctLetters: nextCorrectLetters,
      isMultiSelect: nextCorrectLetters.length > 1,
    },
  };
}

const choiceNormalizationResults = sourceQuestions.map(collapseExactDuplicateChoices);
const normalizedQuestionIds = choiceNormalizationResults
  .filter((result) => result.changed)
  .map((result) => String(result.question.id))
  .sort();
if (JSON.stringify(normalizedQuestionIds) !== JSON.stringify([...ksChoiceNormalization.expectedQuestionIds].sort())) {
  throw new Error(`K&S duplicate-choice scope changed: expected ${ksChoiceNormalization.expectedQuestionIds.length} reviewed records, received ${normalizedQuestionIds.length}`);
}
const questions = choiceNormalizationResults.map((result) => result.question);

const ids = new Set();
for (const [index, question] of questions.entries()) {
  const id = String(question?.id || '');
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  const letters = Array.isArray(question?.choiceLetters) ? question.choiceLetters : [];
  if (!id || ids.has(id)) throw new Error(`Missing or duplicate K&S question id at index ${index}: ${id}`);
  if (!String(question?.question || '').trim()) throw new Error(`K&S question ${id} has no prompt`);
  if (choices.length < 2 || choices.length !== letters.length) throw new Error(`K&S question ${id} has invalid choices`);
  const correctLetters = Array.isArray(question?.correctLetters) && question.correctLetters.length
    ? question.correctLetters.map(String)
    : [String(question?.correctLetter || '')];
  if (!correctLetters.length || new Set(correctLetters).size !== correctLetters.length) {
    throw new Error(`K&S question ${id} has invalid correct-answer cardinality`);
  }
  if (correctLetters.some((letter) => !letters.includes(letter))) {
    throw new Error(`K&S question ${id} has an invalid correct answer`);
  }
  if (Boolean(question?.isMultiSelect) !== (correctLetters.length > 1)) {
    throw new Error(`K&S question ${id} has inconsistent multi-select metadata`);
  }
  ids.add(id);
}

// These pairs are explicitly linked by the pinned source wording: each second
// prompt refers to the immediately previous case. Keep the mapping narrow and
// reviewed rather than inferring relationships from unrelated clinical terms.
const linkedQuestionGroups = [
  ["k-25.21", "k-25.22"],
  ["k-25.23", "k-25.24"],
];
for (const [groupIndex, questionIds] of linkedQuestionGroups.entries()) {
  questionIds.forEach((questionId, linkedOrder) => {
    const question = questions.find((candidate) => candidate.id === questionId);
    if (!question) throw new Error(`Linked K&S question is missing: ${questionId}`);
    question.linkedGroupId = `ks-linked-${groupIndex + 1}`;
    question.linkedOrder = linkedOrder;
  });
}

const bank = {
  id: 'ks-psychiatry-core',
  title: 'K&S Psychiatry Question Bank',
  shortTitle: 'K&S Psychiatry',
  description: 'Kaplan & Sadock psychiatry review questions for personal board preparation.',
  version: `${ksSource.commit}-dedupe-v1`,
  source: {
    ...ksSource,
    verifiedGitBlobSha: gitBlobSha,
    transformations: [ksChoiceNormalization.id],
  },
  questions,
};

await mkdir('public/banks/generated', { recursive: true });
await writeFile('public/banks/generated/ks-psychiatry-core.js', `export const KS_PSYCHIATRY_BANK = ${JSON.stringify(bank)};\n`, 'utf8');
await writeFile('public/banks/generated/ks-psychiatry-core.manifest.json', `${JSON.stringify({ ...bank.source, bankId: bank.id, questionCount: questions.length }, null, 2)}\n`, 'utf8');
console.log(`Verified and generated ${questions.length} K&S questions from ${ksSource.commit}.`);

// Spiegel is an approved catalog deck, not disposable study state. Generate the
// exact same normalized package produced by the existing browser importer so a
// future production promotion remains compatible with its installed revision.
const spiegelPinned = await readPinnedSource(spiegelSource, 'Spiegel');
const spiegelImageBySourcePath = new Map(spiegelImages.map((image) => [
  image.path,
  `/banks/generated/spiegel-images/${path.basename(image.path)}`,
]));
const spiegelPackage = await convertLegacySpiegelScript(spiegelPinned.bytes.toString('utf8'), spiegelPinned.url, {
  resolveImagePath: (sourcePath) => spiegelImageBySourcePath.get(sourcePath) || '',
});
const spiegelBank = spiegelPackage.bank;
if (spiegelBank.questions.length !== spiegelSource.expectedQuestionCount) {
  throw new Error(`Spiegel count mismatch: expected ${spiegelSource.expectedQuestionCount}, received ${spiegelBank.questions.length}`);
}
if (spiegelBank.version !== spiegelSource.expectedVersion) {
  throw new Error(`Spiegel version mismatch: expected ${spiegelSource.expectedVersion}, received ${spiegelBank.version}`);
}
await writeFile('public/banks/generated/spiegel-test-prep.js', `export const SPIEGEL_TEST_PREP_BANK = ${JSON.stringify(spiegelBank)};\n`, 'utf8');
await writeFile('public/banks/generated/spiegel-test-prep.manifest.json', `${JSON.stringify({
  ...spiegelSource,
  verifiedGitBlobSha: spiegelPinned.gitBlobSha,
  bankId: spiegelBank.id,
  version: spiegelBank.version,
  questionCount: spiegelBank.questions.length,
}, null, 2)}\n`, 'utf8');
const spiegelImageOutputDirectory = 'public/banks/generated/spiegel-images';
await rm(spiegelImageOutputDirectory, { recursive: true, force: true });
await mkdir(spiegelImageOutputDirectory, { recursive: true });
for (const imageSource of spiegelImages) {
  const image = await readPinnedSource(imageSource, `Spiegel image ${path.basename(imageSource.path)}`);
  if (!image.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`Spiegel image ${imageSource.path} is not a PNG`);
  }
  await writeFile(path.join(spiegelImageOutputDirectory, path.basename(imageSource.path)), image.bytes);
}
console.log(`Verified and generated ${spiegelBank.questions.length} Spiegel questions from ${spiegelSource.commit}.`);
