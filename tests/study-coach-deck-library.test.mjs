import assert from "node:assert/strict";
import test from "node:test";

import { prepareQuestionBankPackage, analyzeQuestionBankUpdate, isCoachOrganizationUpdate } from "../public/client/question-bank-import.js";
import { focusCoachPractice } from "../public/client/study-coach-practice-selection.js";
import {
  buildStudyCoachDeckLibraryUpdate,
  reconcileStudyCoachBanks,
  STUDY_COACH_BANK_ID,
} from "../public/client/study-coach-deck-library.js";

function question(id, { linkedGroupId = "", linkedOrder = 0, prompt = `Question ${id}?` } = {}) {
  return {
    id,
    chapterTitle: "Original generated section",
    subjectTitle: "Psychiatry",
    question: prompt,
    choices: ["One", "Two"],
    choiceLetters: ["A", "B"],
    correctLetter: "A",
    correctLetters: ["A"],
    isMultiSelect: false,
    explanation: "One is best.",
    ...(linkedGroupId ? { linkedGroupId, linkedOrder } : {}),
  };
}

function generatedDeck(bankId, questions) {
  return {
    bankId,
    package: {
      format: "abpn-question-bank",
      schemaVersion: 1,
      bank: { questions },
    },
  };
}

test("Study Coach outputs append as numbered tests and linked vignettes in one Deck Library bank", async () => {
  const first = buildStudyCoachDeckLibraryUpdate({
    generatedAt: "2026-09-01T14:00:00.000Z",
    generatedDecks: [generatedDeck("cycle-1", [
      question("coach-q1"),
      question("coach-q2", { linkedGroupId: "case-a", linkedOrder: 0 }),
      question("coach-q3", { linkedGroupId: "case-a", linkedOrder: 1 }),
    ])],
  });
  assert.equal(first.changed, true);
  assert.equal(first.testTitle, "Study Coach Test 1");
  assert.equal(first.package.bank.id, STUDY_COACH_BANK_ID);
  assert.equal(first.package.bank.questions[0].chapterTitle, "Study Coach Test 1");
  assert.equal(first.package.bank.questions[1].chapterTitle, "Study Coach Test 1 · Vignette 1");
  assert.equal(first.package.bank.questions[2].linkedGroupId, "study-coach-test-1:vignette-1");

  const installedFirst = (await prepareQuestionBankPackage(first.package)).bank;
  const second = buildStudyCoachDeckLibraryUpdate({
    existingBank: installedFirst,
    generatedAt: "2026-09-02T14:00:00.000Z",
    generatedDecks: [generatedDeck("cycle-2", [question("coach-q4")])],
  });
  assert.equal(second.testTitle, "Study Coach Test 2");
  assert.equal(second.addedQuestions, 1);
  assert.equal(second.package.bank.questions.length, 4);
  assert.equal(second.package.bank.questions[3].chapterTitle, "Study Coach Test 2");
});

test("re-pulling the same output is idempotent and changed question ids are rejected", async () => {
  const deck = generatedDeck("cycle-1", [question("coach-q1")]);
  const first = buildStudyCoachDeckLibraryUpdate({ generatedDecks: [deck] });
  const installed = (await prepareQuestionBankPackage(first.package)).bank;
  const repeated = buildStudyCoachDeckLibraryUpdate({ existingBank: installed, generatedDecks: [deck] });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.addedQuestions, 0);

  assert.throws(() => buildStudyCoachDeckLibraryUpdate({
    existingBank: installed,
    generatedDecks: [generatedDeck("cycle-1", [question("coach-q1", { prompt: "Changed question?" })])],
  }), /changed after it was installed/i);
});

test("reconciliation chooses the cumulative superset without removing questions", async () => {
  const first = buildStudyCoachDeckLibraryUpdate({
    generatedDecks: [generatedDeck("cycle-1", [question("coach-q1")])],
  });
  const remote = (await prepareQuestionBankPackage(first.package)).bank;
  const second = buildStudyCoachDeckLibraryUpdate({
    existingBank: remote,
    generatedDecks: [generatedDeck("cycle-2", [question("coach-q2")])],
  });
  const local = (await prepareQuestionBankPackage(second.package)).bank;

  const localAhead = reconcileStudyCoachBanks({ localBank: local, remoteBank: remote });
  assert.equal(localAhead.status, "local-ahead");
  assert.equal(localAhead.addedRemotely, 1);
  assert.equal(localAhead.bank.questions.length, 2);

  const remoteAhead = reconcileStudyCoachBanks({ localBank: remote, remoteBank: local });
  assert.equal(remoteAhead.status, "remote-ahead");
  assert.equal(remoteAhead.addedLocally, 1);
  assert.equal(remoteAhead.bank.questions.length, 2);
});

test("reconciliation unions compatible branches and rejects changed reused ids", async () => {
  const base = (await prepareQuestionBankPackage(buildStudyCoachDeckLibraryUpdate({
    generatedDecks: [generatedDeck("cycle-1", [question("coach-q1")])],
  }).package)).bank;
  const local = (await prepareQuestionBankPackage(buildStudyCoachDeckLibraryUpdate({
    existingBank: base,
    generatedDecks: [generatedDeck("cycle-local", [question("coach-local")])],
  }).package)).bank;
  const remote = (await prepareQuestionBankPackage(buildStudyCoachDeckLibraryUpdate({
    existingBank: base,
    generatedDecks: [generatedDeck("cycle-remote", [question("coach-remote")])],
  }).package)).bank;

  const merged = reconcileStudyCoachBanks({ localBank: local, remoteBank: remote });
  assert.equal(merged.status, "merged");
  assert.equal(merged.addedLocally, 1);
  assert.equal(merged.addedRemotely, 1);
  assert.deepEqual(merged.bank.questions.map((entry) => entry.id), ["coach-q1", "coach-remote", "coach-local"]);
  assert.match(merged.bank.version, /^1\.2\.3\./);

  const changedRemote = {
    ...remote,
    questions: remote.questions.map((entry) => entry.id === "coach-q1"
      ? { ...entry, question: "Changed after installation?" }
      : entry),
  };
  assert.throws(
    () => reconcileStudyCoachBanks({ localBank: local, remoteBank: changedRemote }),
    /reused question id.*No copy was replaced/i,
  );
});

// Canonical numbering may differ after offline installation, but content must not.
test("Cloudflare organization repairs are replay safe and reject content changes", async () => {
  const local = (await prepareQuestionBankPackage(buildStudyCoachDeckLibraryUpdate({
    generatedDecks: [generatedDeck('batch', [question('coach-a'), question('coach-b')])],
  }).package)).bank;
  const remote = { ...local, checksum: 'canonical-checksum', questions: local.questions.map(q => ({ ...q, chapterTitle: 'Study Coach Test 6', chapter: 6 })) };
  assert.equal(isCoachOrganizationUpdate(local, remote), true);
  assert.equal(reconcileStudyCoachBanks({localBank: local, remoteBank: remote}).status, 'remote-ahead');
  assert.doesNotThrow(() => analyzeQuestionBankUpdate(local, remote, {hasStudyData: true, allowCoachOrganizationUpdate: true}));
  assert.equal(reconcileStudyCoachBanks({localBank: remote, remoteBank: remote}).status, 'current');
  for (const change of [{question: 'Different stem'}, {correctLetter: 'B', correctLetters: ['B']}, {explanation: 'Different explanation'}, {subjectTitle: 'Different subject'}]) {
    const changed = {...remote, questions: remote.questions.map((q, i) => i ? q : {...q, ...change})};
    assert.equal(isCoachOrganizationUpdate(local, changed), false);
    assert.throws(() => reconcileStudyCoachBanks({localBank: local, remoteBank: changed}), /reused question id/i);
    assert.throws(() => analyzeQuestionBankUpdate(local, changed, {hasStudyData: true, allowCoachOrganizationUpdate: true}));
  }
  assert.equal(isCoachOrganizationUpdate(local, {...remote, questions: remote.questions.slice(1)}), false);
});

test("latest coach practice clears restrictive filters without changing history or timing", () => {
  const bank = {id: STUDY_COACH_BANK_ID, questions: [
    {id:'old', chapterTitle:'Study Coach Test 4'},
    {id:'new', chapterTitle:'Study Coach Test 6'},
    {id:'linked', chapterTitle:'Study Coach Test 6 · Vignette 1'},
  ]};
  const key = `abpn-study:builder-settings:${bank.id}`;
  const records = new Map([[key, JSON.stringify({count:40, timing:'custom', secondsPerQuestion:90, categories:['old'], pools:['wrong'], sourceSections:['Study Coach Test 4'], specialCriteria:{range:'1-2'}})], ['history','unchanged']]);
  const storage = {getItem:k=>records.get(k), setItem:(k,v)=>records.set(k,v)};
  assert.deepEqual(focusCoachPractice(bank, storage), ['Study Coach Test 6','Study Coach Test 6 · Vignette 1']);
  assert.deepEqual(JSON.parse(records.get(key)), {count:40, timing:'custom', secondsPerQuestion:90, categories:null, pools:['new'], sourceSections:['Study Coach Test 6','Study Coach Test 6 · Vignette 1'], specialCriteria:null});
  assert.equal(records.get('history'), 'unchanged');
  assert.deepEqual(focusCoachPractice(bank, storage, ['old']), ['Study Coach Test 4']);
});
