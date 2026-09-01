import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

import { KS_PSYCHIATRY_BANK } from '../public/banks/generated/ks-psychiatry-core.js';
import { SPIEGEL_TEST_PREP_BANK } from '../public/banks/generated/spiegel-test-prep.js';
import { normalizeBank } from '../src/client/study-engine.js';

const approvedBanks = [
  { bank: KS_PSYCHIATRY_BANK, expectedTotal: 602, expectedMultiSelect: 3, expectedImages: 0 },
  { bank: SPIEGEL_TEST_PREP_BANK, expectedTotal: 1060, expectedMultiSelect: 97, expectedImages: 10 },
];

for (const { bank, expectedTotal, expectedMultiSelect, expectedImages } of approvedBanks) {
  test(`${bank.id} enables multi-select only for source records with multiple correct answers`, async () => {
    assert.equal(bank.questions.length, expectedTotal);
    const normalized = normalizeBank(bank);
    const multiSelect = normalized.questions.filter((question) => question.isMultiSelect);
    assert.equal(multiSelect.length, expectedMultiSelect);

    for (const question of normalized.questions) {
      const source = bank.questions.find((candidate) => String(candidate.id) === question.id);
      const sourceCorrectLetters = Array.isArray(source.correctLetters) && source.correctLetters.length
        ? [...new Set(source.correctLetters.map(String))]
        : [String(source.correctLetter)];
      assert.equal(question.isMultiSelect, sourceCorrectLetters.length > 1, `Unexpected answer mode for ${question.id}`);
      assert.equal(question.correctLetters.length, sourceCorrectLetters.length, `Incorrect answer cardinality for ${question.id}`);
      assert.ok(question.correctLetters.every((letter) => question.choiceLetters.includes(letter)), `Invalid answer letter for ${question.id}`);
    }

    const images = normalized.questions.map((question) => question.image).filter(Boolean);
    assert.equal(images.length, expectedImages);
    for (const image of images) {
      assert.match(image, /^\/banks\/generated\/spiegel-images\/[a-z0-9._-]+\.png$/i);
      await access(new URL(`../public${image}`, import.meta.url));
    }
  });
}

test('Spiegel preserves six source tests and twenty indivisible vignette groups', () => {
  const normalized = normalizeBank(SPIEGEL_TEST_PREP_BANK);
  const tests = normalized.questions.filter((question) => question.chapter === 'test');
  const vignettes = normalized.questions.filter((question) => question.chapter === 'vignette');
  assert.equal(tests.length, 900);
  assert.equal(new Set(tests.map((question) => question.chapterTitle)).size, 6);
  assert.equal(vignettes.length, 160);
  assert.equal(new Set(vignettes.map((question) => question.chapterTitle)).size, 20);
  assert.ok(vignettes.every((question) => question.vignetteStem && question.linkedGroupId));
  for (const title of new Set(vignettes.map((question) => question.chapterTitle))) {
    const group = vignettes.filter((question) => question.chapterTitle === title);
    assert.equal(new Set(group.map((question) => question.linkedGroupId)).size, 1);
  }
});
