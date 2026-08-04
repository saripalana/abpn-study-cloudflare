# ABPN Study Cloudflare

Private, local-first ABPN Psychiatry study application with optional Cloudflare synchronization.

## Project status

Version 1.0 protected production release. Cloudflare Access restricts the application to the approved identity, IndexedDB remains the primary local store, and bounded synchronization uses the verified D1 database with an immediate server-side kill switch and automatic local-only fallback. This repository is separate from and does not modify:

- `saripalana/ks-study-guide`
- `saripalana/abpn-study-lite`

## Design goals

- Preserve the existing ABPN study workflow and K&S deck.
- Treat K&S, Spiegel, and every future imported package as decks in one shared Deck Library.
- Give every deck the same practice, tutor, test, subject-filter, flag, history, backup, reset, and analytics behavior.
- Keep progress, completed tests, and question identifiers isolated by deck ID.
- Work offline using IndexedDB.
- Cache every deck locally and persist user-added decks across authorized devices through Cloudflare Workers and D1.
- Avoid Google OAuth, Google Drive, Google Cloud, and Google-specific dependencies.
- Use one clear synchronization control with connection-aware status.
- Preserve completed sets, timers, flags, answers, analytics, and reset history.
- Never silently overwrite newer study data or a protected built-in deck.

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

K&S and the validation deck are bundled protected packages. User-added file and GitHub decks use the same normalized runtime model, are cached in IndexedDB, and are stored as chunked versioned packages in the protected one-user D1 Deck Library. Existing locally imported decks are promoted automatically after this capability is deployed.

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
8. K&S remains repository-versioned and protected; user-added deck packages are stored only behind the same one-user Cloudflare Access boundary and remain isolated by deck ID.
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
