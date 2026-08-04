import { KS_PSYCHIATRY_BANK } from './generated/ks-psychiatry-core.js';
import { SPIEGEL_TEST_PREP_BANK } from './generated/spiegel-test-prep.js';

// Application-supplied seeds use the same versioned Deck Library package
// contract as file and GitHub installs. "Seed" describes only how the first
// revision is supplied; it does not create a separate storage pathway.
const KS_SEED_BANK = {
  ...KS_PSYCHIATRY_BANK,
  sourceType: 'application-seed',
  contentClass: 'source-material',
  sourceLabel: 'K&S source package',
  protected: false
};

// Approved catalog decks are always present in a fresh staging session and in
// the proposed production build. Their study activity remains environment-
// specific, while their immutable source package is deterministic.
const SPIEGEL_SEED_BANK = {
  ...SPIEGEL_TEST_PREP_BANK,
  protected: false
};

const VALIDATION_BANK = {
  id: 'validation-bank',
  title: 'System Validation Question Bank',
  shortTitle: 'Validation Bank',
  description: 'A small non-production bank retained for regression testing of test, tutor, timing, storage, analytics, and synchronization behavior.',
  version: '1',
  sourceType: 'system-validation',
  contentClass: 'system-validation',
  sourceLabel: 'Built-in regression test content',
  protected: true,
  questions: [
    { id: 'validation-1', chapterTitle: 'Application Safety', question: 'In test mode, when should the correct answer be revealed?', choices: ['Before selecting an answer', 'Immediately after each answer', 'After the set is submitted', 'Only after deleting the set'], choiceLetters: ['A','B','C','D'], correctLetter: 'C', explanation: 'Test mode should delay feedback until submission.' },
    { id: 'validation-2', chapterTitle: 'Application Safety', question: 'Which storage design best protects progress during a brief loss of internet access?', choices: ['Cloud-only writes', 'Local-first storage with a sync outbox', 'Refreshing the page repeatedly', 'Storing progress only in the URL'], choiceLetters: ['A','B','C','D'], correctLetter: 'B', explanation: 'Local-first storage saves immediately and synchronizes when connectivity returns.' },
    { id: 'validation-3', chapterTitle: 'Question Banks', question: 'How should progress from two different question banks be stored?', choices: ['In one shared question namespace', 'Only in memory', 'Using bank-bound identifiers', 'By question number alone'], choiceLetters: ['A','B','C','D'], correctLetter: 'C', explanation: 'Every progress record must include the bank identifier and question identifier.' }
  ]
};

export const QUESTION_BANKS = [KS_SEED_BANK, SPIEGEL_SEED_BANK, VALIDATION_BANK];
