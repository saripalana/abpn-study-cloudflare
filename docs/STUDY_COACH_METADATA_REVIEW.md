# Study Coach scope and subject metadata

Purpose: record the 2026-09-06 correction boundary without storing private bank
text or production study data.

## Architecture

- Dashboard totals use `banksForOverallMetrics` and the user's preference.
- Coaching snapshots and package exports use `banksForStudyCoach`: source and
  supplemental decks are learning evidence; system-validation decks are not.
- Package creation repeats that eligibility check at the export boundary.
- Mixed source/supplemental tests remain available to coaching. Tests containing
  excluded fixture banks retain the existing conservative whole-set exclusion.
- No new database, exchange endpoint, storage lane, or schema migration is added.

## Subject correction policy

The legacy classifier counts terms across prompts, distractors and explanations.
It provides inferred labels, not a verified clinical classification. Replacing it
globally without question-level review would silently relabel unreviewed material.

`spiegel-reviewed-subjects.js` records 15 reviewed ID-to-subject corrections for
the pinned source checksum prefix. The converter applies these before fallback
inference. Both GitHub import and bundled seed generation share this converter.
New source revisions require review; IDs alone do not activate the overrides.
The v3 bank revision uses the existing immutable revision and seed reconciliation
path. No historical answer data is rewritten for a label-only correction.

The content-free digest regression proves all other question fields and ordering
match the pre-correction bank. A browser regression verifies label refresh leaves
completed tests, answer records and progress unchanged. Allowed taxonomy and
coverage checks remain, but are not treated as proof of semantic accuracy.

## Remaining review, not silently corrected

Unreviewed subject labels remain inferred. Content concerns identified in the
prior private coaching review require separate source-level adjudication:
`k-32.8`, `k-14.5`, `test3-q40`, `test3-q96`, `test3-q127`, `test4-q53`,
`vign20-q3`, `vign20-q4`, `test6-q96`, `k-29.8`.
These are review holds, not a declaration that every answer key is wrong.
No clinical key or source wording is changed in this metadata correction.

## Release

Local verification is not production acceptance. Commit, PR, merge and deployment
remain separate authorization gates. After an approved release, normal verified
seed reconciliation loads the reviewed metadata. A newly sent coaching package
can then include supplemental history that earlier checkbox-filtered exports
omitted; existing private packages are historical snapshots and are not rewritten.
