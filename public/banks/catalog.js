import { KS_PSYCHIATRY_BANK } from './generated/ks-psychiatry-core.js';

const VALIDATION_BANK = {
  id: 'validation-bank',
  title: 'System Validation Question Bank',
  shortTitle: 'Validation Bank',
  description: 'A small non-production bank retained for regression testing of test, tutor, timing, storage, analytics, and synchronization behavior.',
  version: '1',
  questions: [
    { id: 'validation-1', chapterTitle: 'Application Safety', question: 'In test mode, when should the correct answer be revealed?', choices: ['Before selecting an answer', 'Immediately after each answer', 'After the set is submitted', 'Only after deleting the set'], choiceLetters: ['A','B','C','D'], correctLetter: 'C', explanation: 'Test mode should delay feedback until submission.' },
    { id: 'validation-2', chapterTitle: 'Application Safety', question: 'Which storage design best protects progress during a brief loss of internet access?', choices: ['Cloud-only writes', 'Local-first storage with a sync outbox', 'Refreshing the page repeatedly', 'Storing progress only in the URL'], choiceLetters: ['A','B','C','D'], correctLetter: 'B', explanation: 'Local-first storage saves immediately and synchronizes when connectivity returns.' },
    { id: 'validation-3', chapterTitle: 'Question Banks', question: 'How should progress from two different question banks be stored?', choices: ['In one shared question namespace', 'Only in memory', 'Using bank-bound identifiers', 'By question number alone'], choiceLetters: ['A','B','C','D'], correctLetter: 'C', explanation: 'Every progress record must include the bank identifier and question identifier.' }
  ]
};

export const QUESTION_BANKS = [KS_PSYCHIATRY_BANK, VALIDATION_BANK];
