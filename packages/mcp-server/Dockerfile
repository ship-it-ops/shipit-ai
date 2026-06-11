FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/mcp-server/ packages/mcp-server/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/mcp-server
# Self-contained prod bundle: dist + real (de-symlinked) node_modules
# including workspace deps. Copying the root node_modules instead leaves
# Node unable to resolve anything (pnpm keeps real packages in the
# .pnpm virtual store, reached only via per-package symlinks).
RUN pnpm --filter=@shipit-ai/mcp-server deploy --legacy --prod /out

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /out ./
EXPOSE 3002
CMD ["node", "dist/index.js"]
