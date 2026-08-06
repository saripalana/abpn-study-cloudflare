import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { convertLegacySpiegelScript } from '../src/client/legacy-spiegel-import.js';

const ksSource = Object.freeze({
  // The original read-only repository is the authoritative K&S source. Pinning
  // an immutable commit keeps builds reproducible even if its main branch moves.
  repository: 'dancingremote/ks-study-guide',
  commit: 'ddfcba21e97973f77c08311400d05310a4ea1ee3',
  path: 'data.js',
  expectedGitBlobSha: 'f4180d69a4a6bbd8a7f764bb88e7f2f404f7431f',
  expectedQuestionCount: 602,
});

const spiegelSource = Object.freeze({
  repository: 'dancingremote/spiegel-test-prep',
  commit: '1b5b44e1363a59a86462eb3df35920c42dd17f39',
  path: 'data.js',
  expectedGitBlobSha: '47c051ccf14b5316ae33ba6a5769c89f6f89b010',
  expectedQuestionCount: 1060,
  expectedVersion: 'legacy-ks-subjects-v2-99cf60400091',
});

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
const questions = sandbox.__QUESTIONS__;
if (!Array.isArray(questions) || questions.length !== ksSource.expectedQuestionCount) {
  throw new Error(`K&S count mismatch: expected ${ksSource.expectedQuestionCount}, received ${Array.isArray(questions) ? questions.length : 'non-array'}`);
}

const ids = new Set();
for (const [index, question] of questions.entries()) {
  const id = String(question?.id || '');
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  const letters = Array.isArray(question?.choiceLetters) ? question.choiceLetters : [];
  if (!id || ids.has(id)) throw new Error(`Missing or duplicate K&S question id at index ${index}: ${id}`);
  if (!String(question?.question || '').trim()) throw new Error(`K&S question ${id} has no prompt`);
  if (choices.length < 2 || choices.length !== letters.length) throw new Error(`K&S question ${id} has invalid choices`);
  if (!letters.includes(String(question?.correctLetter || ''))) throw new Error(`K&S question ${id} has an invalid correct answer`);
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
  version: ksSource.commit,
  source: { ...ksSource, verifiedGitBlobSha: gitBlobSha },
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
const spiegelPackage = await convertLegacySpiegelScript(spiegelPinned.bytes.toString('utf8'), spiegelPinned.url);
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
console.log(`Verified and generated ${spiegelBank.questions.length} Spiegel questions from ${spiegelSource.commit}.`);
