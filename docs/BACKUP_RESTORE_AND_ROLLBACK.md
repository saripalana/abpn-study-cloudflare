# Backup, Restore, and Rollback Plan

## Scope

This document controls recovery for the private ABPN Study Cloudflare application. It does not apply to, modify, or replace the original repositories:

- `dancingremote/ks-study-guide` (authoritative read-only K&S source)
- `saripalana/abpn-study-lite`

## Complete local recovery bundle

The active user-facing recovery path downloads a complete JSON recovery bundle.
It is the same recovery contract used for device download, protected Cloudflare
backup, and restricted Google Drive recovery.

The complete recovery bundle includes:

- installed question-bank metadata
- installed question-bank package content
- question-bank revision records
- question progress, flags, accuracy inputs, and timing totals
- active, abandoned, and completed practice sets
- practice-set answers
- local recovery snapshots
- allowed local settings needed to rebuild the study workspace

The complete recovery bundle intentionally excludes:

- authentication or Cloudflare Access identity state
- API tokens, OAuth credentials, or secrets
- device identifiers
- staging-session identifiers
- synchronization outbox state or transport failure state

The recovery bundle is integrity-protected and validated before any restore is
accepted.

## Backup validation

A backup is accepted only when all of the following are true:

1. The format is `abpn-study-complete-recovery`.
2. The schema version is supported.
3. The creation timestamp is valid.
4. Every required data collection is present and valid.
5. Record keys are present and unique inside each collection.
6. The SHA-256 integrity digest matches the exact JSON-safe transport payload.
7. The file is no larger than 100 MiB for local import/export.

Protected cloud destinations enforce their own smaller upload limits:

- Cloudflare recovery route: 25 MiB
- Google Drive recovery route: 25 MiB

Malformed or unsupported files are rejected before any local record is written.

## Non-destructive restore rules

Restore is a merge, never a database replacement.

- A recovery snapshot is created before the first imported write.
- Existing local records are not cleared.
- Higher progress revision wins.
- When revisions are equal, the later update timestamp wins.
- Newer local practice sets and answers are preserved.
- Question-bank content and revision rows are restored through the same
  IndexedDB contract as local study data.
- Practice sets with missing question references are retained only as `invalid` and cannot become resumable.
- An imported active timed set keeps its saved remaining time; the restore timestamp is reset so elapsed time before the restore is not subtracted.
- Device-specific synchronization state is not restored.
- Existing local settings win; missing allowed settings are added back.

On staging, restore may intentionally skip app-supplied deck-package records so
progress and history can be recovered without overwriting the exact deck
packages shipped by the current candidate.

After a successful restore, the page reloads so active-set and analytics state are reconstructed from IndexedDB.

## Local recovery procedure

1. Open the app on the device containing the desired data.
2. From **Data protection**, select **Download backup**.
3. Keep the downloaded JSON file outside the browser profile.
4. On the destination device, confirm the target build is the intended recovery target.
5. Select **Restore backup** and review the manifest counts.
6. Confirm the merge.
7. Verify deck availability, dashboard counts, flags, active-set restoration, history, and analytics.
8. Keep the pre-restore recovery snapshot until the restored state has been verified.

## Study Coach boundary

The complete recovery bundle restores the local study workspace that the app
derives analytics from, including question-bank content, progress, tests,
answers, settings, and local snapshots.

Study Coach server-side sharing state is separate from that bundle:

- local full coach-package download/import is a separate analysis workflow
- restricted Google Drive coach-package exchange is a separate workflow
- server-side Study Coach permission, published snapshot state, and audit state
  are not part of the standard local recovery bundle unless a later migration
  explicitly adds them

## Worker rollback

If a production Worker release is defective:

1. Keep `CLOUD_SYNC_ENABLED` disabled or disable it immediately.
2. Confirm the application remains usable locally.
3. In the Worker deployment history, return traffic to the most recent known-good version.
4. Do not delete the D1 database or its bindings.
5. Verify Cloudflare Access still permits only the approved email address.
6. Re-run desktop Chrome and iPhone Safari tests before deploying a corrected version.

A Worker rollback does not automatically reverse a database migration.

## D1 migration safety

- Production migrations must be versioned in `migrations/`.
- Deployments apply only pending migrations before the Worker release.
- Migrations must be additive unless a separate reviewed recovery plan exists.
- A migration must not drop tables or delete study records.
- Before any future destructive migration, create and verify both a portable local backup and a D1 recovery point/export using the then-current Cloudflare recovery procedure.
- If migration application fails, the Worker deployment must stop.
- If a migration succeeds but the application fails, disable synchronization, roll back the Worker, and restore D1 only after reviewing which records were written after the migration.

The current guardrail migration is additive: it creates one `app_usage` table and one internal quota-status row.

## Activation gate

Cloud synchronization must remain disabled until all of the following are complete:

- portable backup download tested in desktop Chrome and iPhone Safari
- non-destructive restore tested in desktop Chrome and iPhone Safari
- newer-local-wins behavior tested
- active timed-set restoration tested
- malformed and question-content-containing backups rejected
- Worker rollback procedure reviewed
- D1 migration recovery procedure reviewed
- first controlled synchronization performed only with validation-bank data
- D1 and Workers usage reviewed immediately after the controlled test
- no paid Cloudflare product or unexpected billable usage present

Activation requires a separate reviewed change to both `APP_RELEASE_MODE` and `CLOUD_SYNC_ENABLED`. Neither variable may be changed as part of backup/restore implementation.
# Archive and backup retention

- Active development and official runtime workspaces contain no archive directories.
- Retired workspace files may remain in one external temporary archive for no more than three calendar days.
- Before temporary archive removal, its contents and checksum manifest must be recoverable from both the official local backup area and Google Drive.
- Keep all backups during their first three calendar days. For older dates, keep only the latest backup created on each calendar day and move earlier same-day backups to recoverable Trash.
- Apply the same daily retention result locally and in Google Drive. Never claim Drive parity until the Drive copy is read back or otherwise verified.
- Production database exports associated with a deployment remain identified in the ledger by filename, size, checksum, source commit, and deployment version.
- GitHub is the durable source/version-history recovery layer for tracked code, reviews, tags, and exact release commits. Do not apply the three-day rotating-file retention rule to Git commits or prune history. GitHub complements but does not replace local and Drive backups for databases, generated recovery bundles, or files that were never committed.
