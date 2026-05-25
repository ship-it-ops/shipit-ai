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

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/api-server/dist ./dist
COPY --from=builder /app/packages/api-server/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3001
CMD ["node", "dist/index.js"]
