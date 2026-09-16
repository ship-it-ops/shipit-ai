FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# api-server's workspace closure. Each line is one Docker layer, ordered
# roughly from least-changing to most-changing for cache efficiency:
#   shared → event-bus → connector-sdk → mcp-server → connectors/* → api-server
COPY packages/shared/ packages/shared/
COPY packages/event-bus/ packages/event-bus/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/mcp-server/ packages/mcp-server/
COPY packages/connectors/ packages/connectors/
COPY packages/api-server/ packages/api-server/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/api-server
# Self-contained prod bundle: dist + real (de-symlinked) node_modules
# including workspace deps. Copying the root node_modules instead leaves
# Node unable to resolve anything (pnpm keeps real packages in the
# .pnpm virtual store, reached only via per-package symlinks).
RUN pnpm --filter=@shipit-ai/api-server deploy --legacy --prod /out

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
EXPOSE 3001
CMD ["node", "dist/index.js"]
