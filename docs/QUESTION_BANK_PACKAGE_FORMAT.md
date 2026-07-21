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

## Content classification

Every imported bank must use one of two explicit classifications.

### Source material

```json
"sourceType": "user-imported",
"contentClass": "source-material"
```

Use this for a distinct source question bank. It remains separate from K&S and from assistant-created questions.

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

## Separate backup responsibilities

**Download backup** contains progress, flags, timing, active/completed tests, answers, and recovery snapshots. It excludes original question text.

**Download bank package** appears for a locally imported bank and downloads that bank's versioned question content. Keep both files when moving an imported bank and its study history to another device:

1. Import the question-bank package on the destination device.
2. Restore the portable progress backup.

This separation prevents an imported package from silently replacing protected source content and prevents progress backups from mixing original and assistant-created questions.
