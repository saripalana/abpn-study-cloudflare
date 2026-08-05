# ABPN Study Question-Bank Package Format

## Purpose

Question-bank packages add new content without modifying the protected K&S package, the built-in validation bank, or another imported bank. Question content is stored separately from progress, completed tests, answers, analytics, and portable progress backups.

## File limits

- JSON only
- maximum file size: 25 MiB
- maximum questions per bank: 5,000
- unique bank id
- unique question id within the bank
- 2–10 answer choices per question

## Required structure

```json
{
  "format": "abpn-question-bank",
  "schemaVersion": 1,
  "bank": {
    "id": "example-psychiatry-bank",
    "title": "Example Psychiatry Question Bank",
    "shortTitle": "Example Bank",
    "description": "Description shown on the dashboard.",
    "version": "1.0.0",
    "sourceType": "user-imported",
    "contentClass": "source-material",
    "sourceLabel": "Name of the source or author",
    "questions": [
      {
        "id": "example-1",
        "linkedGroupId": "example-case-1",
        "linkedOrder": 0,
        "chapterTitle": "Mood Disorders",
        "question": "Question stem",
        "choices": ["First", "Second", "Third", "Fourth"],
        "choiceLetters": ["A", "B", "C", "D"],
        "correctLetter": "B",
        "explanation": "Explanation"
      }
    ]
  }
}
```

`linkedGroupId` and `linkedOrder` are optional only for independent questions. Questions that share a case, stem, or prerequisite context must use the same stable group ID and consecutive order. A study set selects the complete ordered group; it never guesses linkage from question wording.

This version-1 JSON package is the common installation and portability format. Every accepted package is validated and converted into the universal bank/revision/group/question/choice/rationale contract. Application-supplied seeds such as K&S use this same contract; `application-seed` describes initial supply, not a privileged storage pathway.

## Content classification

Every installed bank must use one of three explicit classifications.

### Application seed

```json
"sourceType": "application-seed",
"contentClass": "source-material"
```

Use this only for a bank supplied with the application. On first use it is installed into the same versioned Deck Library as every other bank, after which its active immutable revision is resolved normally.

### Source material

```json
"sourceType": "user-imported",
"contentClass": "source-material"
```

Use this for a distinct imported source question bank. Its questions and progress remain isolated by bank ID while its installation, versioning, backup, protection, study, and analytics behavior remain identical to K&S.

### Assistant supplemental material

```json
"sourceType": "assistant-supplemental",
"contentClass": "assistant-supplemental"
```

Use this for assistant-created or assistant-expanded cards. It cannot be relabeled as original source material later. A package cannot change classification during an update; use a new bank id instead.

## Version and update rules

- Identical content with the same checksum is treated as already installed.
- Changed content must use a new `version`.
- Prior versions are retained in a local revision store.
- After progress or test history exists, an update may add questions but cannot change or remove existing questions.
- A breaking content revision must use a new bank id, which prevents old progress from attaching to different question text.
- Protected ids such as `ks-psychiatry-core` and `validation-bank` cannot be imported or overwritten.
- Linked-group identity and order are immutable within a revision. Correcting group membership requires a new validated revision.

## Separate backup responsibilities

**Download backup** contains progress, flags, timing, active/completed tests, answers, and recovery snapshots. It excludes original question text.

**Download bank package** appears for a locally imported bank and downloads that bank's versioned question content. Keep both files when moving an imported bank and its study history to another device:

1. Import the question-bank package on the destination device.
2. Restore the portable progress backup.

This separation prevents an imported package from silently replacing protected source content and prevents progress backups from mixing original and assistant-created questions.
