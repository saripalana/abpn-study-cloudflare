# ABPN Study Web current state

Purpose: concise implementation status and explicit release boundaries.

Last updated: 2026-09-06

## Current local work: Cloud-authoritative coach installation

- Diagnosis: latest output was present, but saved New + older-test filters hid
  it. Browser-local numbering also differed from the cumulative Cloudflare bank.
- Cloud output installation now reconciles the canonical cumulative bank before
  selecting the output's existing question IDs; replay does not append a new test.
  Cloud section organization wins only when content, keys, subject, linked order,
  and vignette membership agree. Actual content conflicts still stop installation.
- Added Practice latest coach test (New questions). It clears stale subject/range/
  status filters, preserves timing and count preferences, and never starts a test.
- Verification: 257 Node tests, 21 desktop browser checks passed (one iPhone-only
  check excluded). Real IndexedDB regression verifies organization repair and
  replay preserve progress, answers, completed tests, and outbox byte-for-byte.
  Build idempotence and diff whitespace checks passed.
- NOT deployed; no live records altered. Release together with Tutor Submit/Reset
  only through separately approved commit/PR, staging migration/release, and
  production gates below. Do not include unrelated Gemini runner/dependency edits.

## Current local work: Tutor Submit and Reset

- All active tutor questions require Submit answer to reveal feedback. Reset
  answer clears only the current test response and hides feedback. Completed
  review is read-only; test-mode behavior is unchanged.
- Browser owns drafts; an IndexedDB transaction commits tutor answer, progress,
  and sync outbox together. Per-test progressRecorded/progressTimeMs watermarks
  prevent reset/retry from increasing attempts or counting elapsed time twice.
  Reset retains the last submitted global progress until resubmission; it does
  not rewrite previous completed tests. Whole-set submission commits drafts too.
- Cloud sync previously omitted finalized. Additive migration
  0013_tutor_answer_state.sql and Worker push/pull preserve tutor state and retry
  accounting. Legacy single-choice tutor answers retain their graded behavior.
  No source questions, keys, prior migrations, or live study records changed.
- Verification: 255 Node tests pass, including real Worker SQL push/pull against
  in-memory SQLite and existing-row preservation during upgrade. 20 desktop
  tutor, multi-answer, reset/reload, retest, and timer regression checks passed;
  one iPhone-only test was skipped. Generated browser assets match source.
- NOT deployed. Next gates: scoped commit/PR/CI approval; verify migration
  identity against the target registry; approved staging migration then Worker
  and browser release and acceptance; separately approved production release.
  Apply the additive column before the new Worker. Rollback code only, retaining
  the nullable column and user data. Do not bundle unrelated dirty work by default.

## Current local work: Sync progress and coach handoff clarity

- Status-only changes: Sync displays batch counts and remaining outbox work,
  including after reload; no quota, merge, retry, or record-schema changes.
- Coach handoff derives waiting/ready/installed from existing permission metadata
  and exact output-to-package lineage. Explicit Check coach status performs a
  metadata read, not model generation, download, or installation. No polling added.
- Existing ABPN exchange/learning skills now gate generation on validated local
  workbench freshness, source/coach coverage, and duplicate-output checks.
- Verified locally: 254 Node tests and 14 desktop browser tests passed, including
  501-change capped sync and reload, metadata-only coach refresh, and history
  preservation. Skill frontmatter passed Ruby validation; official Python skill
  validator unavailable because its yaml dependency is absent.
- Next approval gate: commit/PR/CI, staging acceptance, then production release.
  These local website changes have NOT been deployed. No production data touched.

## Previous work: coaching scope and reviewed subject metadata

- Release candidate: 15 reviewed Spiegel subject corrections,
  source-checksum-bound registry, bank version v3, shared coaching export scope.
- Coaching exports and automatic snapshots now include supplemental learning
  history independently of dashboard metrics preferences, excluding system fixtures.
- No question content, keys, stable IDs, source sections, or study records changed.
- Build consistency/idempotence, all 253 Node tests, cost guardrails, and all six
  desktop Deck Library tests passed, including exact label-history preservation.
- Deployed through PR #60 on 2026-09-06; release and subsequent Sync recovery
  receipts are in the canonical governance ledger.
- Unreviewed labels remain heuristic; disputed clinical content remains unchanged.
  See docs/STUDY_COACH_METADATA_REVIEW.md for scope and follow-up boundaries.
- iPhone remains excluded. Historical checkpoint below is not current release status.

## Historical checkpoint: 2026-09-03

## Current local gate

K&S answer-key correction architecture was merged to protected `main` through PR #56 at commit `4c695247b3b4b30d878c4f3562d32f7036a4e209` and deployed to production Worker version `71f61775-3431-4ac3-ac6c-0ce47b6b094c`.

The current follow-up branch `fix/web-only-ci-scope` narrows the required GitHub `test` job to hosted desktop-web validation. Physical iPhone validation remains deliberately excluded from the active checklist until it is explicitly reactivated.

## What changed

- K&S approved-bank generation now applies a named reviewed answer-key overlay when the pinned upstream source rationale and stored key conflict.
- The generated K&S seed version is `020aae0f5c55ad3bb0c122760c7b7d3fe26f1b46-ak1`.
- Verified seed installation now archives prior revisions and repairs derived `isCorrect` metadata for matching progress rows and completed-test answer-log rows.
- The repair preserves selected answers, dates, timing, flags, notes, set IDs, and completed test history.
- The upper-right Sync control runs verified-seed reconciliation before the normal Cloudflare push/pull flow so repaired metadata enters the existing sync outbox.

## Validation completed

- `npm run build:check`
- `node --test --test-reporter=dot`
- `PLAYWRIGHT_REUSE_SERVER=false npx playwright test tests/e2e/deck-library.spec.js --project=chromium-desktop`
- K&S generated-content check: 602 questions, 8 reviewed answer-key corrections present, 0 rationale/key mismatches under the content-safe validator.
- PR #56 required checks passed on GitHub before merge: `test` and `enforce-free-only-cloudflare-policy`.
- Production deploy dry-run passed against `wrangler.toml`.
- Production deploy completed with Cloudflare Access still required and production D1 binding intact.
- Unauthenticated production smoke check returned Cloudflare Access redirect, confirming public access remains protected.

## Not done

- No production D1 migration was needed or run for the K&S answer-key reconciliation release.
- No protected question text, answers, explanations, notes, production study records, recovery bundles, D1 exports, or credentials were inspected or placed in chat.
- Authenticated production browser acceptance remains a separate same-lane check if required; the current command-line smoke only verifies Access protection.
- Physical iPhone verification remains excluded from current scope.

## Next safest action

Finish the `fix/web-only-ci-scope` CI follow-up through the protected PR path so the required web validation no longer spends time on deferred iPhone Safari flows.
