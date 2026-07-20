# ABPN Study Cloudflare

Private, local-first ABPN Psychiatry study application with optional Cloudflare synchronization.

## Project status

Active development. This repository is separate from and does not modify:

- `saripalana/ks-study-guide`
- `saripalana/abpn-study-lite`

## Design goals

- Preserve the existing ABPN study workflow and K&S question bank.
- Treat K&S as one question bank within the broader ABPN Study application.
- Support additional question banks without bank-specific labels leaking into site-wide screens.
- Work offline using IndexedDB.
- Synchronize progress across devices through Cloudflare Workers and D1.
- Avoid Google OAuth, Google Drive, Google Cloud, and Google-specific dependencies.
- Use one clear synchronization control with connection-aware status.
- Preserve completed sets, timers, flags, answers, analytics, and reset history.
- Never silently overwrite newer study data.

## Planned architecture

- Front end: local-first progressive web application
- Local persistence: IndexedDB
- API: Cloudflare Worker
- Cloud database: Cloudflare D1
- Authentication: Cloudflare Access
- Deployment: Cloudflare Workers with static assets

## Cost safety

This project is restricted to Cloudflare Zero Trust Free, Workers Free, D1 Free, and static assets. Paid Workers and additional metered Cloudflare products are prohibited. Repository CI blocks prohibited bindings and paid-plan configuration.

The controlling requirements are in [`docs/COST_AND_USAGE_POLICY.md`](docs/COST_AND_USAGE_POLICY.md). Cloud synchronization must not be enabled until the application quotas, kill switch, fail-closed routing, local-only fallback, billing alerts, and usage checks in that policy are implemented and tested.

## Safety rules

1. Development occurs in this repository only.
2. The original study repositories remain untouched.
3. Database migrations are versioned and tested before production use.
4. Existing progress is migrated from an exported copy, never from the sole live copy.
5. Local data remains usable during network outages.
6. Sync conflicts are resolved at record level and are never handled by replacing the entire database blindly.
7. Cost guardrails are release-blocking and cannot be bypassed for production deployment.

## Development stages

1. Establish protected baseline and audit existing application.
2. Generalize the application around multiple question banks.
3. Remove all Google-specific code and interface elements.
4. Implement IndexedDB storage and local recovery.
5. Add Worker API and D1 schema.
6. Add synchronization, conflict handling, and authentication.
7. Add migration and backup/restore tools.
8. Implement and verify cost, quota, kill-switch, and fail-closed safeguards.
9. Run functional, data-integrity, offline, multi-device, security, and cost-safety tests.
10. Deploy only after validation.
