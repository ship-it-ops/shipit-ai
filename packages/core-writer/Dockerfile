FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/event-bus/ packages/event-bus/
COPY packages/core-writer/ packages/core-writer/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/core-writer
# Self-contained prod bundle: dist + real (de-symlinked) node_modules
# including workspace deps. Copying the root node_modules instead leaves
# Node unable to resolve anything (pnpm keeps real packages in the
# .pnpm virtual store, reached only via per-package symlinks).
RUN pnpm --filter=@shipit-ai/core-writer deploy --legacy --prod /out

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /out ./
CMD ["node", "dist/main.js"]
