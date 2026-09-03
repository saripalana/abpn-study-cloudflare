# ABPN Study Web current state

Last updated: 2026-09-02

## Current local gate

K&S answer-key correction architecture is implemented locally in the authorized checkout on `main`, with uncommitted changes only. No commit, push, pull request, deployment, migration, production sync, production data mutation, or browser acceptance has been performed in this gate.

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

## Not done

- No GitHub branch/PR/CI gate yet.
- No staging deployment or authenticated staging acceptance yet.
- No production deployment, migration, or production data/sync mutation yet.
- Physical iPhone verification remains excluded from current scope.

## Next safest action

Create a non-main work branch or otherwise move these uncommitted local changes into the protected PR path, then run GitHub/CI and staging gates separately.
