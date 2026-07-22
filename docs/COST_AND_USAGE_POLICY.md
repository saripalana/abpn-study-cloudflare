# Cloudflare Cost and Usage Policy

**Project:** ABPN Study Cloudflare  
**Policy owner:** Repository owner  
**Last verified against official Cloudflare documentation:** 2026-07-20

This project is designed to remain on Cloudflare's free tiers. Cost safety is a release requirement, not a best-effort preference.

## 1. Allowed Cloudflare products

Only the following services may be used in production:

1. **Cloudflare Zero Trust Free** for one authorized user.
2. **Cloudflare Workers Free** for the application API and static assets.
3. **Cloudflare D1 on Workers Free** for bounded synchronization records and versioned user-added deck packages.
4. **Cloudflare Access** policies that restrict the application and API to the repository owner's approved identity.

Everything else is prohibited unless this policy is explicitly revised in a reviewed pull request after current pricing and billing behavior are re-verified.

## 2. Prohibited products and changes

The project must not enable or bind any of the following:

- Workers Paid or any paid Workers subscription
- R2
- Workers KV
- Queues
- Durable Objects
- Workflows
- Images or Image Resizing
- Workers AI
- Vectorize
- Browser Rendering
- Hyperdrive
- Stream
- paid logging, Logpush, or analytics add-ons
- cron or scheduled background tasks
- any product not listed in the allowed-products section
- automatic plan upgrades or configuration that asks Cloudflare to increase limits

No deployment may proceed if the Cloudflare dashboard shows a paid Workers subscription or any enabled usage-billed product outside the allowed list.

## 3. Current official free-plan limits used for design

These values are not targets. The app's internal limits must remain far below them.

### Workers Free

- 100,000 Worker requests per day
- 10 milliseconds CPU time per invocation
- 128 MB memory
- When the daily request limit is exceeded, Cloudflare returns Error 1027
- Security-critical routes must be configured **fail closed**, not fail open

Official source: https://developers.cloudflare.com/workers/platform/limits/

### D1 on Workers Free

- 5,000,000 rows read per day
- 100,000 rows written per day
- 5 GB total account storage
- 500 MB maximum size per database
- On the Free plan, exceeding daily read/write limits causes queries to fail rather than creating paid overages
- Reaching the storage limit blocks additional writes until storage is reduced

Official sources:

- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/

### Zero Trust Free

- Free plan intended for teams under 50 users
- This project permits only one authorized user

Official source: https://www.cloudflare.com/plans/zero-trust-services/

## 4. Application-enforced limits

The production application must implement all of the following before cloud synchronization is enabled:

- Maximum authorized user count: **1**
- Maximum accepted record-synchronization request body: **2 MiB**
- Maximum accepted deck-package request body: **20 MiB**
- Maximum persistent user-added decks: **50**
- Maximum questions per deck: **5,000**
- Maximum storage chunks per deck: **96**
- Maximum synchronization write actions: **5 per minute**
- Maximum synchronization and Deck Library API requests: **2,000 per UTC day**
- Maximum D1 rows read by the application: **50,000 per UTC day**
- Maximum D1 rows written by the application: **2,500 per UTC day**
- Maximum automatic retries per operation: **3**
- Exponential backoff with jitter after failures
- Automatic cloud-sync suspension after **3 consecutive failures**
- No polling loop shorter than 15 minutes
- No background synchronization when there are no meaningful local changes
- No cron triggers or scheduled server-side jobs
- No public write endpoint
- No unauthenticated read endpoint containing study data or deck content
- Record-level progress synchronization only; never replace the complete database blindly
- Deck updates must replace only the matching versioned deck package and must never overwrite a protected built-in deck

Deck packages are chunked into bounded D1 rows. K&S remains repository-bundled and is never uploaded through the user-added Deck Library route.

If an internal limit is reached, the app must stop cloud operations and continue in local-only mode. A deck added during a temporary outage is cached locally and queued for later publication.

## 5. Required emergency controls

Production must include:

1. A server-side `CLOUD_SYNC_ENABLED` kill switch. Any value other than the explicit enabled value must reject cloud writes and Deck Library operations.
2. A client-side local-only mode that remains fully usable when the API is unavailable.
3. A single deployment rollback path documented and tested.
4. A database migration rollback or restore plan.
5. A visible status message when cloud synchronization has been disabled.
6. No automatic re-enable after a cost or quota shutdown.

## 6. Required billing and usage monitoring

After Zero Trust activation and before deploying any Worker or D1 database, configure account-wide budget alerts at:

- **$0.01** — any unexpected billable usage
- **$0.25** — elevated warning
- **$1.00** — urgent warning
- **$5.00** — emergency warning

Use at least two reliable email recipients when available. Budget alerts are informational only and do not stop usage, so they are supplemental safeguards rather than the primary control.

Official source: https://developers.cloudflare.com/billing/manage/budget-alerts/

Also required:

- Review Cloudflare **Billing > Billable Usage** after initial deployment
- Review it again after the first successful multi-device synchronization and first persistent deck upload
- Review it weekly during the first month
- Review it monthly thereafter
- Confirm the Workers account remains on Free before every production release
- Confirm no prohibited product appears in billable usage

## 7. Deployment gates

A production deployment is blocked unless all of the following are true:

- Repository cost-guardrail CI passes
- Only allowed bindings exist in Wrangler configuration
- Access policy permits only the approved identity
- Worker routes are fail closed
- D1 schema and queries have bounded row access
- API payload and rate limits are tested
- imported decks are isolated by deck ID and cannot replace protected built-in decks
- a clean second browser profile can retrieve a previously added deck
- kill switch is tested
- local-only operation is tested
- no paid subscription or prohibited service is enabled
- current Cloudflare pricing and limit pages have been rechecked if this policy is more than 90 days old

## 8. Response to any unexpected charge or billable usage

If any alert fires or the billable-usage dashboard shows a nonzero amount:

1. Disable cloud synchronization using the server-side kill switch.
2. Stop production deployments.
3. Identify the product generating usage.
4. Remove or disable the product or route.
5. Confirm the app remains usable locally with cached decks.
6. Do not restore cloud synchronization until the cause is documented and reviewed.

## 9. Policy change control

This file, the automated guardrail script, and the workflow that runs it must be changed together. Any proposal to add another Cloudflare product must include:

- current official pricing documentation
- exact free allowance
- overage behavior
- hard-failure behavior
- application-level quota
- monitoring plan
- rollback plan
- explicit approval by the repository owner
