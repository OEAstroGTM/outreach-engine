#!/bin/bash
# Push all required secrets to Cloudflare Workers.
# Set each var in your shell (or a local .env you `source`) before running —
# nothing is hardcoded here so this script is safe to commit.
#
# Run once: bash setup-secrets.sh

set -euo pipefail

put() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "Skipping $name — not set in the environment." >&2
    return
  fi
  echo "$value" | npx wrangler secret put "$name"
}

echo "Setting Cloudflare Worker secrets for oe-slack-bot..."

put SLACK_BOT_TOKEN            "${SLACK_BOT_TOKEN:-}"
put SLACK_SIGNING_SECRET       "${SLACK_SIGNING_SECRET:-}"
put ANTHROPIC_API_KEY          "${ANTHROPIC_API_KEY:-}"
put PORKBUN_API_KEY            "${PORKBUN_API_KEY:-}"
put PORKBUN_SECRET_API_KEY     "${PORKBUN_SECRET_API_KEY:-}"
put INBOXING_API_KEY           "${INBOXING_API_KEY:-}"
put INBOXING_CONN_SEND         "${INBOXING_CONN_SEND:-}"
put INBOXING_CONN_PERSONAL     "${INBOXING_CONN_PERSONAL:-}"
put EMAILBISON_SEND_API_KEY    "${EMAILBISON_SEND_API_KEY:-}"
put EMAILBISON_PERSONAL_API_KEY "${EMAILBISON_PERSONAL_API_KEY:-}"

echo "Done! All secrets pushed."
