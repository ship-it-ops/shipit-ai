FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# core-writer's workspace closure. Each line is one Docker layer, ordered
# roughly from least-changing to most-changing for cache efficiency:
#   shared → event-bus → connector-sdk → connectors/* → core-writer
# connector-sdk and connectors/* are devDependencies of core-writer, but the
# builder still needs them: `tsc` compiles every file under src/, including
# src/__tests__/acceptance/*, which imports both connector packages. The
# `deploy --legacy --prod` below strips devDependencies, so the runtime image
# is unchanged.
COPY packages/shared/ packages/shared/
COPY packages/event-bus/ packages/event-bus/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/connectors/ packages/connectors/
COPY packages/core-writer/ packages/core-writer/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/core-writer
# Self-contained prod bundle: dist + real (de-symlinked) node_modules
# including workspace deps. Copying the root node_modules instead leaves
# Node unable to resolve anything (pnpm keeps real packages in the
# .pnpm virtual store, reached only via per-package symlinks).
RUN pnpm --filter=@shipit-ai/core-writer deploy --legacy --prod /out

FROM node:22-alpine
# Runtime-stage hygiene (this is the only stage that ships and gets scanned):
#  - `apk upgrade` picks up Alpine security patches released after the base
#    tag was built (e.g. openssl/libcrypto3 CVE-2026-14456).
#  - strip the npm CLI bundled with the node image. The service runs `node`
#    against the pnpm-deployed node_modules above and never invokes npm, but
#    npm's vendored deps (tar, pacote, sigstore, brace-expansion, ...) lag
#    upstream fixes for months and fail the image gate. corepack/pnpm live
#    in the builder stage only and are untouched.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /out ./
CMD ["node", "dist/main.js"]
