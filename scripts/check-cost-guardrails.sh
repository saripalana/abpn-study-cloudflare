#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0

fail() {
  printf 'COST GUARDRAIL FAILURE: %s\n' "$1" >&2
  failures=$((failures + 1))
}

require_file() {
  if [[ ! -f "$1" ]]; then
    fail "Required file is missing: $1"
  fi
}

require_file "docs/COST_AND_USAGE_POLICY.md"
require_file ".github/workflows/cost-guardrails.yml"
require_file "public/client/starter-decks.js"
require_file "migrations/0004_cloud_deck_library.sql"
require_file "migrations/0005_unified_deck_bootstrap.sql"

mapfile -t wrangler_files < <(
  find . -type f \
    \( -name 'wrangler.toml' -o -name 'wrangler.json' -o -name 'wrangler.jsonc' \) \
    -not -path './node_modules/*' \
    -not -path './.git/*' \
    | sort
)

# Only static assets and D1 are permitted Cloudflare runtime bindings.
# Any other product requires an explicit policy change and owner approval.
forbidden_binding_pattern='(^|[[:space:]"'"'"'])(r2_buckets|kv_namespaces|queues|durable_objects|workflows|ai|vectorize|hyperdrive|browser|analytics_engine_datasets|images|logfwdr|services|dispatch_namespaces|mtls_certificates|unsafe|send_email)([[:space:]"'"'"']|=|:|$)'
forbidden_schedule_pattern='(^|[[:space:]"'"'"'])(triggers|crons)([[:space:]"'"'"']|=|:|$)'
forbidden_paid_pattern='workers[[:space:]_-]*paid|plan[[:space:]]*[=:][[:space:]]*["'"'"']?paid|usage_model[[:space:]]*[=:][[:space:]]*["'"'"']?unbound'

for file in "${wrangler_files[@]}"; do
  if grep -Ein "$forbidden_binding_pattern" "$file" >/dev/null; then
    grep -Ein "$forbidden_binding_pattern" "$file" >&2 || true
    fail "Prohibited Cloudflare binding found in $file"
  fi

  if grep -Ein "$forbidden_schedule_pattern" "$file" >/dev/null; then
    grep -Ein "$forbidden_schedule_pattern" "$file" >&2 || true
    fail "Scheduled or cron execution is prohibited in $file"
  fi

  if grep -Ein "$forbidden_paid_pattern" "$file" >/dev/null; then
    grep -Ein "$forbidden_paid_pattern" "$file" >&2 || true
    fail "Paid-plan configuration found in $file"
  fi
done

# Deployment and package configuration must not opt into prohibited products or paid plans.
mapfile -t deployment_files < <(
  find . -type f \
    \( -name 'package.json' -o -name 'package-lock.json' -o -name 'pnpm-lock.yaml' -o -name 'yarn.lock' -o -name '*.tf' -o -name '*.yaml' -o -name '*.yml' \) \
    -not -path './node_modules/*' \
    -not -path './.git/*' \
    -not -path './docs/*' \
    -not -path './.github/workflows/cost-guardrails.yml' \
    | sort
)

prohibited_product_pattern='cloudflare[_ -]?(r2|kv|queue|durable[_ -]?object|workflow|images?|ai|vectorize|browser|hyperdrive|stream)|workers[[:space:]_-]*paid'
for file in "${deployment_files[@]}"; do
  if grep -Ein "$prohibited_product_pattern" "$file" >/dev/null; then
    grep -Ein "$prohibited_product_pattern" "$file" >&2 || true
    fail "Prohibited Cloudflare product or paid plan reference found in deployment configuration: $file"
  fi
done

# Every deck, including K&S, must use the bounded D1 Deck Library. K&S content
# must not be emitted as a generated application asset.
if [[ -e "public/banks/generated/ks-psychiatry-core.js" || -e "public/banks/generated/ks-psychiatry-core.manifest.json" ]]; then
  fail "K&S deck content must not be bundled into application assets"
fi
if ! grep -Eq 'MAX_DECK_PACKAGE_BYTES = 20 \* 1024 \* 1024' src/deck-library-api.js; then
  fail "The 20 MiB Deck Library package limit is missing"
fi
if ! grep -Eq 'MAX_DECKS = 50' src/deck-library-api.js; then
  fail "The 50-deck library limit is missing"
fi
if ! grep -Eq 'KS_STARTER_SOURCE' public/client/starter-decks.js; then
  fail "The external pinned K&S starter descriptor is missing"
fi

# A production configuration must declare the emergency sync kill switch.
if (( ${#wrangler_files[@]} > 0 )); then
  kill_switch_found=0
  for file in "${wrangler_files[@]}"; do
    if grep -Eq 'CLOUD_SYNC_ENABLED' "$file"; then
      kill_switch_found=1
      break
    fi
  done
  if (( kill_switch_found == 0 )); then
    fail "Wrangler configuration exists but CLOUD_SYNC_ENABLED is not declared"
  fi
fi

if (( failures > 0 )); then
  printf '\n%d cost guardrail check(s) failed. Deployment is blocked.\n' "$failures" >&2
  exit 1
fi

printf 'Cost guardrails passed. Free-only Cloudflare configuration and bounded uniform Deck Library storage are enforced.\n'
