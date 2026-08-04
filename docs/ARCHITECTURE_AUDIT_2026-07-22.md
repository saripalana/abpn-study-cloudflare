# ABPN Psychiatry Study — Architecture Audit

Date: 2026-07-22
Branch: `architecture/universal-decks`
Protected baseline: `backup/pre-architecture-2026-07-22`
Production baseline commit: `4c3cfe568abf6139ca8d0711e91ddcad71560da4`

## Executive conclusion

The current repository already uses the correct high-level service layout and should be improved in place rather than rebuilt:

- GitHub is the private source-code and change-history repository.
- Cloudflare Workers serves the static PWA and API through one deployment and one origin.
- Cloudflare Access protects both application assets and API requests.
- Cloudflare D1 stores bounded synchronized study records and user-added deck packages.
- IndexedDB provides offline-first storage, local recovery snapshots, and cached deck content.

The existing application is substantially closer to the desired architecture than the earlier design discussion suggested. The safest path is to preserve the working deployment and strengthen the data model in staged, backward-compatible migrations.

## Confirmed strengths

### One integrated Cloudflare deployment

`wrangler.toml` runs `src/access-worker.js` before static assets and binds the `public` directory and D1 database to one Worker deployment. This avoids a split GitHub Pages/Cloudflare deployment and keeps the frontend, API, authentication boundary, and database access on one origin.

### Authentication is fail-closed

`src/access-worker.js` verifies the Cloudflare Access JWT before forwarding requests to the application Worker. Missing or invalid authentication returns an error before protected assets or API data are served.

### Decks are normalized peers at runtime

The current Deck Library contract uses a normalized package format and identifies decks by stable deck ID. User-added decks use the same practice runtime rather than receiving separate K&S-only behavior.

### Imported content is isolated by deck ID

Study progress uses the compound key `(bankId, questionId)`. Practice sets and answers retain deck/question identifiers, preventing one deck from overwriting another deck's progress.

### Local revisions are preserved

IndexedDB contains separate stores for active deck content and archived deck revisions. Before a local package update, the existing package is archived by deck ID and checksum.

### Unsafe updates are blocked

An update that changes or removes existing questions is rejected when progress or test history already exists. The user must import the changed material under a new deck ID, protecting completed results from silently changing meaning.

### Cloud limits and local fallback exist

The cloud Deck Library has explicit limits for package size, question count, chunks, and deck count. The application can remain usable from IndexedDB when Cloudflare is temporarily unavailable.

## Material gaps to correct

### 1. Cloud storage retains only the current package

The cloud API deletes the current package chunks and replaces them during an update. IndexedDB archives prior revisions locally, but D1 does not currently retain the prior cloud package revision.

Risk: a new device can retrieve the current package but cannot independently restore an older imported source version if the original device is unavailable.

Required correction: add immutable cloud deck revisions keyed by `(user_id, deck_id, checksum)` and a separate current-version pointer. A successful update must write a new revision before changing the pointer. Old revisions must not be deleted by ordinary updates.

### 2. Original source and user modification layers are not yet explicit card-level entities

The package model preserves an original deck package and classifies assistant-created decks separately. However, ordinary card edits are not yet represented as a formal card-level override layer in D1.

Required correction: preserve imported source questions as immutable versioned package content; store future user edits as separate overrides keyed by deck ID and question ID. Removing an override must restore the source card without reconstructing it manually.

### 3. Practice-set historical snapshots need explicit verification

Completed sets preserve answers and identifiers. The audit must confirm whether the exact displayed question, choices, correct answer, and explanation are snapshotted when the set is created or submitted.

Required correction if absent: store a bounded presentation snapshot for each practice-set question so later deck edits cannot rewrite historical test review.

### 4. Backup scope is incomplete for full disaster recovery

Local recovery snapshots currently include deck metadata, progress, sets, and answers, but not all active deck content and revision packages.

Required correction: provide two separate exports:

- Complete application backup: settings, progress, history, active user-added decks, revisions, and overrides.
- Per-deck export: immutable source package, revision metadata, and optional overrides.

### 5. Naming remains partially bank-oriented internally

Internal names such as `QUESTION_BANKS`, `BANK_CONTENT`, and `bankId` remain. This does not currently make K&S special, but it raises future maintenance risk.

Required correction: migrate public-facing language first, then introduce compatibility aliases or a staged internal rename. Avoid a large destructive rename while the application is working.

### 6. URL importing must remain adapter-based

The app supports a normalized package contract and GitHub raw-package access. An arbitrary GitHub Pages URL cannot be assumed to expose importable structured data.

Required correction: use source adapters that extract and validate a package, then show a preview before installation. Spiegel must be converted into the same normalized package contract and stored as its own deck.

## Recommended implementation sequence

1. Preserve the current production branch and database export.
2. Add immutable D1 deck revision tables and current-version pointers.
3. Update the cloud Deck Library API to create revisions transactionally and retain old versions.
4. Add revision listing and restore endpoints.
5. Verify or add exact practice-question snapshots.
6. Add card override storage without altering source packages.
7. Expand complete and per-deck backups.
8. Add adapter-based Spiegel import and import preview.
9. Run unit, browser, offline, second-device, rollback, and Cloudflare dry-deploy tests.
10. Apply the D1 migration only after a production database export and explicit checkpoint approval.

## Change-control rules

- No changes are made directly on `main` during implementation.
- New database migrations are additive and backward-compatible.
- The existing tables are not dropped or rewritten during the first migration.
- Production D1 migration is a user checkpoint because it changes live account data.
- Production merge is a separate user checkpoint after preview testing.
- K&S remains one protected bundled deck, not the platform identity.
- Spiegel and every future import use the same package, versioning, progress, backup, and recovery rules.

## 2026-08-03 canonical source and data-path correction

This section supersedes any earlier implication that runtime normalization alone makes every deck a fully equivalent persisted question bank. The current D1 package/chunk model is a compatibility layer; the target is one queryable content contract for K&S, Spiegel, file/GitHub imports, and future sources.

### Canonical entities

- Content: `Bank`, immutable `BankRevision`, ordered `QuestionGroup`, ordered `Question`, ordered `Choice`, `Rationale`, and `Provenance`.
- Study: `StudySession`, ordered revision-pinned `SessionQuestion`, append-safe `Attempt`, selection/correctness/timing, flag/note, and cumulative progress/history.
- Source adapters may differ only at ingestion and provenance. They must emit the same validated content contract. Ambiguous linked questions are quarantined rather than guessed.
- D1 is canonical cloud persistence. IndexedDB mirrors the versioned contract and retains a bounded offline outbox. Frontend and administrative tools use the same authenticated repository/API layer rather than querying D1 directly.

### Repeatable modification pathway

- Editable browser assets live under `src/browser` and `src/client`.
- Corresponding `public` files are deterministic deployment outputs produced by `npm run build`; do not hand-edit generated copies.
- `npm run build:check` rejects source/output drift. `npm run build:idempotence` proves a repeated generation produces identical bytes.
- The existing `npm run verify` is the single consolidated validation path. Do not add another validator or patch chain.
- Historical `scripts/patch-*.mjs` files are no longer invoked by package scripts. They remain only as accounted transition history until separately approved archival; new behavior must be implemented in canonical source.
- GitHub validation rejects a checkout when generation changes committed `src`, `public`, or package metadata.
- Local validation, the sole private staging environment with isolated data, user acceptance, migration, and production deployment are sequential gates. Automation does not grant approval for later gates.
