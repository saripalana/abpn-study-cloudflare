# ABPN Study Cloudflare

Private, local-first ABPN Psychiatry study application with optional Cloudflare synchronization.

## Project status

Version 1.0 protected production release. Cloudflare Access restricts the application to the approved identity, IndexedDB remains the primary local store, and bounded synchronization uses the verified D1 database with an immediate server-side kill switch and automatic local-only fallback. This repository is separate from and does not modify:

- `dancingremote/ks-study-guide` (authoritative read-only K&S source)
- `saripalana/abpn-study-lite`

## Design goals

- Preserve the existing ABPN study workflow and K&S deck.
- Treat K&S, Spiegel, and every future imported package as decks in one shared Deck Library.
- Give every deck the same practice, tutor, test, subject-filter, flag, history, backup, reset, and analytics behavior.
- Make question order explicit: All defaults to randomized, filtered pools default to source order, and the user can override either choice without separating linked-question groups.
- Keep progress, completed tests, and question identifiers isolated by deck ID.
- Work offline using IndexedDB.
- Cache every deck locally and persist every installed Deck Library package across authorized devices through Cloudflare Workers and D1.
- Avoid Google OAuth, Google Drive, Google Cloud, and Google-specific dependencies.
- Use one clear synchronization control with connection-aware status.
- Preserve completed sets, timers, flags, answers, analytics, and reset history.
- The private application offers optional Study Coach access that remains enabled until explicitly revoked. With fresh consent, it automatically refreshes a strictly allowlisted coaching dataset after study activity: category and test-section performance, bounded completed-test history, timing and flags, plus the attempted, flagged, or annotated question details needed for targeted coaching. Credentials and unrelated browser or device data are excluded. Revocation blocks access but preserves the shared study data; only the separate delete control removes it. Publication, access, deletion, and last-update state are visible and audited. Production remains unchanged until the private staging candidate is accepted and separately authorized for promotion.
- Never silently overwrite newer study data or an installed immutable deck revision.

## Architecture

- Front end: local-first progressive web application
- Local persistence and offline deck cache: IndexedDB
- API: Cloudflare Worker
- Cloud database: Cloudflare D1
- Deck model: one normalized, versioned package contract for bundled and imported decks
- Authentication: Cloudflare Access
- Deployment: Cloudflare Workers with static assets

The current package/chunk Deck Library remains a backward-compatible persistence layer while the canonical question-level model is introduced additively. The target contract is shared by every source: immutable bank revisions, ordered linked-question groups, questions, choices, rationales, provenance, revision-pinned study sessions, attempts, timing, flags, notes, and history. K&S is protected, but it is not a separate runtime or persistence architecture.

## Repeatable development pathway

- Edit browser assets only under `src/browser` and `src/client`.
- Run `npm run build` to generate their deployment copies under `public`.
- Run `npm run build:check` to detect stale or manually edited deployment copies.
- Run `npm run build:idempotence` to prove repeated generation is byte-stable.
- Run `npm run verify` as the single consolidated local gate. It imports the pinned K&S source, generates browser assets, verifies idempotence, enforces free-tier guardrails, runs the complete unit/architecture suite, and performs a Cloudflare dry build without deployment.
- Do not add another `patch-*` workflow. Existing historical patch scripts are no longer invoked; their required behavior has been captured in canonical source.
- Generated dependencies, Wrangler state, test reports, logs, and generated K&S assets are ignored and must not be committed.

The environment progression is local verification, the sole private staging environment with isolated test data, user acceptance, and only then separately approved merge, migration, and production deployment.

### Parallel staging environment

`wrangler.staging.toml` defines the sole production-equivalent staging stack. It uses the same Worker, generated assets, source adapters, APIs, and migrations while binding only the staging hostname, Access audience, test identity, and `abpn-study-db-staging` database. Production configuration contains no disposable-session switch.

Each new staging browser session clears the prior staging user's D1 rows, IndexedDB database, local storage, and Cache Storage before the application loads. Reloads in the same tab retain that isolated session so reload/resume behavior remains testable. A bounded server TTL provides cleanup when browser-close delivery is unavailable. The cleanup endpoint exists only when `APP_ENV=staging`, `STAGING_DISPOSABLE_ENABLED=true`, and `STUDY_USER_ID=staging-user`; otherwise it returns not found without touching D1.

Generated dependencies, browser-test downloads, screenshots, reports, Wrangler output, and logs remain test-harness artifacts and must be removed after validation. A webpage cannot delete arbitrary files from a user's Downloads folder, so manual exports are treated as user-owned files rather than silently removed.

GitHub remains the permanent source/version-history recovery layer and is not pruned by local/Drive backup retention. Local and Google Drive backups cover database exports, temporary-archive recovery bundles, and other non-Git artifacts.

K&S and Spiegel are approved catalog decks generated from immutable original `dancingremote` revisions through the same normalized, immutable-revision Deck Library contract as file and GitHub packages. Their adapters verify the pinned Git blobs, question counts, stable identities, and answer structure before generating packages; they never modify the source repositories. A fresh staging session therefore mirrors the deck catalog proposed for production while its progress, history, flags, sets, and other writable state remain disposable and isolated. Every user-facing bank is cached in IndexedDB and stored as a chunked versioned package in the protected one-user D1 library. The hidden validation fixture remains test-only and is not a user question bank. Existing locally imported decks are promoted automatically.

## Cost safety

This project is restricted to Cloudflare Zero Trust Free, Workers Free, D1 Free, and static assets. Paid Workers and additional metered Cloudflare products are prohibited. Repository CI blocks prohibited bindings and paid-plan configuration.

The controlling requirements are in [`docs/COST_AND_USAGE_POLICY.md`](docs/COST_AND_USAGE_POLICY.md). The application quotas, kill switch, fail-closed routing, local-only fallback, billing alerts, and usage checks in that policy are release-blocking.

Backup, restore, Worker rollback, and D1 migration recovery are controlled by [`docs/BACKUP_RESTORE_AND_ROLLBACK.md`](docs/BACKUP_RESTORE_AND_ROLLBACK.md).

## Safety rules

1. Development occurs in this repository only.
2. The original study repositories remain untouched.
3. Database migrations are versioned and tested before production use.
4. Existing progress is migrated from an exported copy, never from the sole live copy.
5. Local data and cached decks remain usable during network outages.
6. Sync conflicts are resolved at record level and are never handled by replacing the entire database blindly.
7. Cost guardrails are release-blocking and cannot be bypassed for production deployment.
8. K&S is an application-supplied seed that is installed through the same versioned Deck Library contract as Spiegel and future imports; every package is stored behind the same one-user Cloudflare Access boundary and isolated by deck ID.
9. Portable study backups omit question content; each imported deck can be exported separately as its own versioned package.

## Development stages

1. Establish protected baseline and audit existing application.
2. Generalize the application around multiple decks.
3. Remove all Google-specific code and interface elements.
4. Implement IndexedDB storage and local recovery.
5. Add Worker API and D1 schema.
6. Add synchronization, conflict handling, authentication, and persistent Deck Library storage.
7. Add migration and backup/restore tools.
8. Implement and verify cost, quota, kill-switch, and fail-closed safeguards.
9. Run functional, data-integrity, offline, multi-device, security, and cost-safety tests.
10. Activate only after a separate controlled validation and release review.
11. Replace the transitional package/chunk content layer with the additive canonical question-level model; preserve compatibility and rollback until parity is proven.
