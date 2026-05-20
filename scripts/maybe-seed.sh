#!/usr/bin/env bash
# Probe Neo4j and surface a one-line hint when the graph is empty. The web
# UI's onboarding modal is the canonical opt-in surface for first-time
# seeding — this script doesn't prompt, it just nudges.
#
# Designed to slot between `infra.sh` (which waits for Neo4j to be healthy)
# and `turbo dev`. A no-op when the graph already has data, so returning
# users never see anything.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  YELLOW=$(tput setaf 3); DIM=$(tput dim); RESET=$(tput sgr0)
else
  YELLOW=""; DIM=""; RESET=""
fi

# Skip entirely if the user has opted out via env.
if [ "${SHIPIT_SKIP_SEED_PROMPT:-0}" = "1" ]; then
  exit 0
fi

set +e
pnpm tsx scripts/has-graph-data.ts >/dev/null 2>&1
status=$?
set -e

case "$status" in
  0)
    # Graph already has data — silent skip is the right behavior here.
    exit 0
    ;;
  2)
    printf "  ${YELLOW}!${RESET} Couldn't reach Neo4j to check for data — skipping seed hint.\n"
    exit 0
    ;;
esac

# status == 1 → graph is empty.
printf "\n  ${DIM}·${RESET} Neo4j is empty. Use the onboarding modal in the web UI to seed, or run \`pnpm seed\` directly.\n"
