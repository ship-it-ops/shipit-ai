FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# agent-runner's workspace closure. Each line is one Docker layer, ordered
# roughly from least-changing to most-changing for cache efficiency:
#   shared → agents → mcp-server → agent-runner
# A new workspace dependency must be added here, to the package's vitest alias
# list, and to the lockfile (scar docker-builder-copies-fixed-package-set).
COPY packages/shared/ packages/shared/
COPY packages/agents/ packages/agents/
COPY packages/mcp-server/ packages/mcp-server/
COPY packages/agent-runner/ packages/agent-runner/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/agent-runner
# Self-contained prod bundle: dist + real (de-symlinked) node_modules,
# including the workspace dependencies.
RUN pnpm --filter=@shipit-ai/agent-runner deploy --legacy --prod /out

FROM node:22-alpine
# Runtime-stage hygiene, as in the other images: Alpine security patches, and
# no bundled npm CLI (never used at runtime; its vendored deps fail the scan).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /out ./
CMD ["node", "dist/main.js"]
