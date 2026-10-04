FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# knowledge-worker's workspace closure, least-changing first:
#   shared → agents → event-bus → connector-sdk → knowledge → knowledge-worker
# (connector-sdk depends on event-bus; knowledge depends on connector-sdk for its types.)
COPY packages/shared/ packages/shared/
COPY packages/agents/ packages/agents/
COPY packages/event-bus/ packages/event-bus/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/knowledge/ packages/knowledge/
COPY packages/knowledge-worker/ packages/knowledge-worker/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/knowledge-worker
# Self-contained prod bundle: dist + real (de-symlinked) node_modules.
RUN pnpm --filter=@shipit-ai/knowledge-worker deploy --legacy --prod /out

FROM node:22-alpine
# Runtime-stage hygiene, same as core-writer: Alpine security patches, and the
# bundled npm CLI removed because its vendored deps fail the image gate.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /out ./
CMD ["node", "dist/main.js"]
