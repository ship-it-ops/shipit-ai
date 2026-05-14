#!/usr/bin/env bash
# Full setup: preflight + dependency install + workspace build.
#
# Use this after a fresh clone, or when the lockfile / TypeScript outputs
# need to be regenerated. For a normal `pnpm dev` cycle the lighter
# `preflight.sh` (auto-invoked by `pnpm start:all`) is enough.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/preflight.sh

echo
echo "Installing dependencies (no-op if up to date)…"
pnpm install

echo
echo "Building packages…"
pnpm turbo build

echo
echo "Setup complete. Next: pnpm start:all"
