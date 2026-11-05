#!/bin/bash
# ── dnc-nightly.sh ───────────────────────────────────────────────────────────
# launchd wrapper for the nightly DNC reconciler.
#
# Runs the sync LIVE across every eligible client, appends one compact JSON
# record per run to data/dnc-runs.log, keeps the full report of the most recent
# run in data/dnc-last-run.json, and exits non-zero if anything failed.
#
# Installed by: ~/Library/LaunchAgents/co.outreachengine.dnc-sync.plist
# Run by hand:  bash mcp/scripts/dnc-nightly.sh

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$REPO/data"
LOG="$LOG_DIR/dnc-runs.log"
LAST="$LOG_DIR/dnc-last-run.json"
mkdir -p "$LOG_DIR"

# launchd starts jobs with a near-empty PATH, so `node` is usually not found —
# the single most common reason a job that works in your shell fails at 23:00.
NODE=""
for candidate in \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin/node" \
  "$(command -v node 2>/dev/null)"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ -z "$NODE" ]; then
  printf '{"ran_at":"%s","ok":false,"crash":"node not found on PATH; edit NODE in dnc-nightly.sh"}\n' "$(stamp)" >> "$LOG"
  exit 127
fi

cd "$REPO" || exit 1

# Retain the last 500 runs.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 500 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Keep stdout and stderr apart. The previous version merged them with 2>&1, so
# dotenvx's startup banner ended up inside the payload we tried to parse — and
# that banner contains a `{`, which broke every single parse.
ERR="$(mktemp)"
"$NODE" mcp/scripts/dnc-sync.js --live --json > "$LAST" 2> "$ERR"
CODE=$?

"$NODE" mcp/scripts/dnc-log.mjs "$LAST" "$CODE" "$ERR" >> "$LOG"
rm -f "$ERR"

exit $CODE
