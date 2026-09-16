FROM node:22-alpine AS base
RUN corepack enable pnpm

FROM base AS builder
WORKDIR /app
# shipit.config.yaml: next.config.mjs loads it at build time to flatten
# frontend.* into NEXT_PUBLIC_SHIPIT_* vars (throws if missing).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json shipit.config.yaml ./
# web-ui's workspace closure, least-changing first: shared → mcp-server → web-ui
COPY packages/shared/ packages/shared/
COPY packages/mcp-server/ packages/mcp-server/
COPY packages/web-ui/ packages/web-ui/
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time overrides for shipit.config.yaml ${VAR} placeholders. Anything
# referenced from frontend.* must be present here or fall back to its
# YAML-defined default. Backend.* placeholders aren't substituted during the
# frontend build (see next.config.mjs).
ARG SHIPIT_API_URL
ENV SHIPIT_API_URL=${SHIPIT_API_URL}
RUN pnpm turbo build --filter=@shipit-ai/web-ui

FROM base AS runner
# Runtime-stage hygiene (this is the only stage that ships and gets scanned):
#  - `apk upgrade` picks up Alpine security patches released after the base
#    tag was built (e.g. openssl/libcrypto3 CVE-2026-14456).
#  - strip the npm CLI bundled with the node image. The server runs `node`
#    against the standalone bundle and never invokes npm, but npm's vendored
#    deps (tar, pacote, sigstore, brace-expansion, ...) lag upstream fixes for
#    months and fail the image gate. The corepack pnpm shim `base` enabled is
#    a separate package and is untouched. Must run before `USER nextjs`.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Next standalone output mirrors the monorepo layout: server.js lives at
# packages/web-ui/server.js inside the standalone tree, with public/ and
# .next/static expected as siblings.
COPY --from=builder --chown=nextjs:nodejs /app/packages/web-ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/web-ui/.next/static ./packages/web-ui/.next/static
COPY --from=builder /app/packages/web-ui/public ./packages/web-ui/public

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "packages/web-ui/server.js"]
