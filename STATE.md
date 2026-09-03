# ABPN Study Web current state

Last updated: 2026-09-03

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
