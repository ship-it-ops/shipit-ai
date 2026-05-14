#!/usr/bin/env bash
# Probe Neo4j; if the graph is empty, offer to seed the Acme Pay demo data.
#
# Designed to slot between `infra.sh` (which waits for Neo4j to be healthy)
# and `turbo dev`. A no-op when the graph already has data, so returning
# users never see the prompt — only fresh checkouts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); DIM=$(tput dim); BOLD=$(tput bold); RESET=$(tput sgr0)
else
  GREEN=""; YELLOW=""; DIM=""; BOLD=""; RESET=""
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
    printf "  ${YELLOW}!${RESET} Couldn't reach Neo4j to check for data — skipping seed prompt.\n"
    exit 0
    ;;
esac

# status == 1 → graph is empty.
if [ ! -t 0 ]; then
  printf "\n  ${DIM}·${RESET} Neo4j is empty. Run \`pnpm seed\` to load demo data.\n"
  exit 0
fi

printf "\n${BOLD}Demo data${RESET}\n"
printf "  Neo4j is empty. Seed the Acme Pay sample dataset (~170 entities, ~300 edges)? [Y/n]: "
read -r answer
case "${answer:-Y}" in
  [Nn]*)
    printf "  ${DIM}·${RESET} Skipping seed. Run \`pnpm seed\` later if you change your mind.\n"
    ;;
  *)
    pnpm seed
    printf "  ${GREEN}✓${RESET} Demo data loaded.\n"
    ;;
esac
