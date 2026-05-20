#!/usr/bin/env bash
# Preflight: verify the local environment is ready to run ShipIt-AI.
#
# Auto-fixes what's safely auto-fixable (creates .env from .env.example,
# enables pnpm via corepack, runs pnpm install if node_modules is missing).
# For everything else (no docker, wrong Node version, missing config) it
# prints a concrete next step and exits non-zero.
#
# Run on its own: `bash scripts/preflight.sh`
# Auto-invoked by: `pnpm setup`, `pnpm start:all`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── tty-aware formatting ────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  RED=$(tput setaf 1)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  BLUE=$(tput setaf 4)
  DIM=$(tput dim)
  BOLD=$(tput bold)
  RESET=$(tput sgr0)
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; DIM=""; BOLD=""; RESET=""
fi

ok()      { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()    { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
fail()    { printf "  ${RED}✗${RESET} %s\n" "$1"; }
info()    { printf "  ${DIM}·${RESET} %s\n" "$1"; }
section() { printf "\n${BOLD}%s${RESET}\n" "$1"; }
fix()     { printf "    ${BLUE}→${RESET} %s\n" "$1"; }

errors=0

# ── prerequisites ───────────────────────────────────────────────────────────
section "Prerequisites"

# Node >= 22 (matches the engines field in root package.json)
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 22 ]; then
    fail "node $(node -v) — need Node 22 or newer"
    fix "Install via nvm: nvm install 22 && nvm use 22"
    errors=$((errors + 1))
  else
    ok "node $(node -v)"
  fi
else
  fail "node not found"
  fix "Install Node 22 from https://nodejs.org/ (or via nvm)"
  errors=$((errors + 1))
fi

# pnpm — auto-enable via corepack if missing
if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not on PATH — trying corepack enable…"
  if command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1; then
    ok "pnpm enabled via corepack ($(pnpm -v))"
  else
    fail "pnpm not available and corepack couldn't enable it"
    fix "Install manually: brew install pnpm   (or: npm i -g pnpm@10)"
    errors=$((errors + 1))
  fi
else
  ok "pnpm $(pnpm -v)"
fi

# Docker — installed AND running
if ! command -v docker >/dev/null 2>&1; then
  fail "docker not found"
  fix "Install Docker Desktop: https://www.docker.com/products/docker-desktop"
  errors=$((errors + 1))
elif ! docker info >/dev/null 2>&1; then
  fail "docker installed but daemon isn't running"
  fix "Start Docker Desktop, wait for the whale icon to settle, then re-run"
  errors=$((errors + 1))
else
  ok "docker $(docker --version | awk '{print $3}' | tr -d ',') (running)"
fi

if [ "$errors" -gt 0 ]; then
  printf "\n${RED}${BOLD}Preflight failed — fix the issues above and try again.${RESET}\n"
  exit 1
fi

# ── repo state ──────────────────────────────────────────────────────────────
section "Repo state"

if [ ! -f shipit.config.yaml ]; then
  fail "shipit.config.yaml missing — this file ships with the repo. Did the checkout fail?"
  exit 1
fi
ok "shipit.config.yaml present"

if [ ! -f shipit.config.local.example.yaml ]; then
  fail "shipit.config.local.example.yaml missing — needed to bootstrap local overrides"
  exit 1
fi
ok "shipit.config.local.example.yaml present"

if [ ! -f config/shipit-schema.yaml ]; then
  fail "config/shipit-schema.yaml missing — required for api-server"
  fix "Restore from git: git checkout -- config/shipit-schema.yaml"
  exit 1
fi
ok "config/shipit-schema.yaml present"

if [ ! -d node_modules ]; then
  warn "node_modules missing — running pnpm install (one-time, ~30s)…"
  pnpm install
  ok "dependencies installed"
else
  ok "node_modules present"
fi

# ── shipit.config.local.yaml ────────────────────────────────────────────────
section "Local config"

if [ ! -f shipit.config.local.yaml ]; then
  cp shipit.config.local.example.yaml shipit.config.local.yaml
  ok "Created shipit.config.local.yaml from the example"
  info "Personalize your dev identity from the onboarding modal on first load of the web UI (or edit the file directly)."
else
  ok "shipit.config.local.yaml exists"
fi

printf "\n${GREEN}${BOLD}Preflight complete.${RESET}\n"
