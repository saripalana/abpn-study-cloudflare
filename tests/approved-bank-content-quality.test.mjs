import test from 'node:test';
import assert from 'node:assert/strict';

import { KS_PSYCHIATRY_BANK } from '../public/banks/generated/ks-psychiatry-core.js';
import { SPIEGEL_TEST_PREP_BANK } from '../public/banks/generated/spiegel-test-prep.js';
import { normalizeBank } from '../src/client/study-engine.js';

const approvedBanks = [KS_PSYCHIATRY_BANK, SPIEGEL_TEST_PREP_BANK];
const unsafeCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF\uFFFD]/;

for (const definition of approvedBanks) {
  test(`${definition.id} has structurally valid, cleanly formatted display content`, () => {
    const bank = normalizeBank(definition);
    assert.equal(new Set(bank.questions.map((question) => question.id)).size, bank.questions.length);

    for (const question of bank.questions) {
      const fields = [
        question.question,
        question.vignetteStem,
        question.answerText,
        question.explanation,
        ...question.choices,
      ];
      for (const field of fields) {
        assert.equal(field, field.trim(), `Edge whitespace in ${question.id}`);
        assert.doesNotMatch(field, unsafeCharacters, `Unsafe character in ${question.id}`);
        assert.doesNotMatch(field, /[ \t]+[,.;:!?]/, `Space before punctuation in ${question.id}`);
        assert.equal(field, field.normalize('NFC'), `Non-normalized Unicode in ${question.id}`);
      }
      assert.equal(new Set(question.choiceLetters).size, question.choiceLetters.length);
      assert.equal(
        new Set(question.choices.map((choice) => choice.normalize('NFC').trim())).size,
        question.choices.length,
        `Exact duplicate choice in ${question.id}`,
      );
      assert.equal(new Set(question.correctLetters).size, question.correctLetters.length);
      assert.ok(question.correctLetters.every((letter) => question.choiceLetters.includes(letter)));
      assert.equal(question.isMultiSelect, question.correctLetters.length > 1);
    }
  });
}

test("K&S answer keys agree with rationale-led answer text", () => {
  const bank = normalizeBank(KS_PSYCHIATRY_BANK);
  const mismatches = [];
  const compact = (value) => String(value || "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  for (const question of bank.questions) {
    const rationale = compact(question.explanation);
    const rationaleChoiceLetters = question.choices
      .map((choice, index) => ({ letter: question.choiceLetters[index], choice: compact(choice) }))
      .filter(({ choice }) => choice && rationale.startsWith(choice))
      .map(({ letter }) => letter);
    if (
      rationaleChoiceLetters.length
      && !rationaleChoiceLetters.some((letter) => question.correctLetters.includes(letter))
    ) {
      mismatches.push({
        id: question.id,
        storedCorrect: question.correctLetters.join(","),
        rationaleChoice: rationaleChoiceLetters.join(","),
      });
    }
  }

  assert.deepEqual(mismatches, []);
});
