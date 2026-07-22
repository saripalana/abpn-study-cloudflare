# ABPN Study Cloudflare

Private, local-first ABPN Psychiatry study application with protected Cloudflare synchronization.

## Project status

Protected production release. Cloudflare Access restricts the application to the approved identity, IndexedDB remains the local offline cache, and the protected D1 Deck Library stores every deck as an independent versioned package. Progress, flags, practice sets, answers, and history remain isolated by deck ID.

This repository is separate from and does not modify:

- `saripalana/ks-study-guide`
- `saripalana/abpn-study-lite`

## Deck model

- K&S, Spiegel, file imports, and GitHub imports all use the same Deck Library path.
- No study deck is privileged or bundled into the application runtime.
- K&S is verified from its pinned external source, installed as an ordinary deck, and stored in D1 exactly like every other deck.
- Each authorized device downloads deck packages from D1 and caches them in IndexedDB for offline study.
- Adding, updating, downloading, resetting, and studying a deck uses the same rules regardless of origin.
- Deck content never merges into another deck, and progress is always keyed by deck ID plus question ID.

## Architecture

- Front end: local-first progressive web application
- Local persistence and offline deck cache: IndexedDB
- API: Cloudflare Worker
- Cloud deck and study database: Cloudflare D1
- Authentication: Cloudflare Access
- Deployment: Cloudflare Workers with static assets

## Design goals

- Make adding a deck as straightforward as adding a deck in Anki.
- Preserve completed sets, timers, flags, answers, analytics, and reset history independently for every deck.
- Work offline after a deck has been cached locally.
- Synchronize decks and study records across authorized devices.
- Never silently overwrite a changed deck without a new version.
- Avoid Google OAuth, Google Drive, Google Cloud, and Google-specific dependencies.

## Cost safety

This project is restricted to Cloudflare Zero Trust Free, Workers Free, D1 Free, and static assets. Paid Workers and additional metered Cloudflare products are prohibited. Repository CI blocks prohibited bindings and paid-plan configuration.

The controlling requirements are in [`docs/COST_AND_USAGE_POLICY.md`](docs/COST_AND_USAGE_POLICY.md). Application quotas, the kill switch, fail-closed routing, local-only fallback, billing alerts, and usage checks are release-blocking.

Backup, restore, Worker rollback, and D1 migration recovery are controlled by [`docs/BACKUP_RESTORE_AND_ROLLBACK.md`](docs/BACKUP_RESTORE_AND_ROLLBACK.md).

## Safety rules

1. Development occurs in this repository only.
2. Original source repositories remain untouched.
3. Database migrations are versioned and tested before production use.
4. Local data remains usable during network outages.
5. Sync conflicts are resolved at record level; the complete database is never replaced blindly.
6. Deck updates require a changed version when content changes.
7. Cost guardrails are release-blocking.
8. Portable study backups contain study records and deck references; deck packages remain separately versioned in the Deck Library.
