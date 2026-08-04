# Deployment trigger

This documentation-only file records the first production deployment that uses the repository-managed deploy command (`npm run deploy`) so pending D1 migrations run before the Worker is deployed.

The application remains in protected setup mode and cloud synchronization remains disabled.

## Current controlled pathway

The sentence above records the original deployment state and is retained as history. Current production is full and protected by Cloudflare Access. Future changes follow this sequence:

1. Edit canonical browser source under `src/browser` or `src/client`.
2. Generate `public` outputs with `npm run build`.
3. Pass the single `npm run verify` gate, including deterministic/idempotent asset checks.
4. Validate the sole `release-candidate` in one private staging environment with isolated non-production data.
5. Obtain explicit user acceptance and separate approvals for merge, database migration, and production deployment.

`npm run deploy` remains production-affecting because it includes remote D1 migration application. It must never be used merely to preview a candidate.

Staging uses the separately versioned `wrangler.staging.toml`. `npm run staging:check` validates the complete candidate and performs a staging-configured dry build without deployment. Any staging migration or Worker deployment remains a separately approved action. The staging configuration must never contain the production D1 identifier, and production must never enable `STAGING_DISPOSABLE_ENABLED`.
