import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type McpServerConfig } from './config.js';
import { createNeo4jClient, type Neo4jClient } from './neo4j-client.js';
import { createMcpServer } from './server.js';

export { createMcpServer } from './server.js';
export { loadConfig } from './config.js';
export type { McpServerConfig } from './config.js';
export { createNeo4jClient } from './neo4j-client.js';
export type { Neo4jClient, CypherResult } from './neo4j-client.js';
export { wrapResponse } from './envelope.js';
export type { McpResponse, McpResponseMeta } from './envelope.js';
export { McpErrorCode, createError, findSuggestions, levenshteinDistance } from './errors.js';
export type { McpError } from './errors.js';
export { MCP_TOOLS, MCP_TOOL_BY_NAME } from './tools/metadata.js';
export type { McpToolMetadata, McpToolParamSpec } from './tools/metadata.js';

const DEFAULT_HTTP_PORT = 3002;
const MCP_PATH = '/mcp';
// Hard cap on POST body size. Real MCP JSON-RPC envelopes are <10 KB in
// practice; the server also serves `Access-Control-Allow-Origin: *` so a
// cross-origin page can drive an upload here. Bounding the buffer prevents
// memory amplification (CodeQL js/resource-exhaustion). 1 MB is comfortable
// headroom for any realistic tool argument payload.
const MAX_BODY_BYTES = 1_000_000;

class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(public readonly limitBytes: number) {
    super(`Request body exceeds ${limitBytes}-byte limit`);
    this.name = 'PayloadTooLargeError';
  }
}

async function startStdio(neo4j: Neo4jClient, config: McpServerConfig): Promise<void> {
  const server = createMcpServer(neo4j, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp(neo4j: Neo4jClient, config: McpServerConfig, port: number): Promise<void> {
  // Stateless mode: one transport + one server reused across requests. The
  // graph tools have no per-session state, so sharing avoids the cost of
  // re-registering all 8 tools on every request.
  const server = createMcpServer(neo4j, config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Permissive CORS — the MCP server is read-only and the auth boundary
    // (when it lands in Stage 2) will be the Authorization header, not origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200).end(JSON.stringify({ status: 'ok', transport: 'http' }));
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end('Not found');
      return;
    }

    try {
      // Body parsing: for POSTs the transport expects pre-parsed JSON.
      // GET/DELETE pass through without a body.
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      // Body-cap exceedance: respond 413 with a generic message before
      // anything else so a noisy/malicious client can't drive memory
      // amplification by retrying past the limit.
      if (err instanceof PayloadTooLargeError) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'PAYLOAD_TOO_LARGE',
                message: `Request body exceeds the ${err.limitBytes}-byte limit.`,
              },
            }),
          );
        }
        return;
      }
      // Log the full error (including stack) server-side; never echo
      // err.toString() or err.stack back to the caller — CodeQL flags
      // it as information exposure (js/stack-trace-exposure) and it
      // can leak internal paths, dep versions, secrets that landed in
      // an error message, etc. Surface a generic message + log the
      // detail so operators can correlate by timestamp.
      console.error('mcp request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal error processing MCP request. See server logs for details.',
            },
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  // Log to stderr so it doesn't pollute any tooling that pipes stdout.
  console.error(`shipit-ai MCP server listening on http://localhost:${port}${MCP_PATH}`);
}

// Exported for tests; the production transport never calls it directly.
export async function readJsonBody(
  req: IncomingMessage,
  limitBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > limitBytes) {
      // Stop reading immediately. `destroy()` aborts the socket so the
      // sender can't keep streaming bytes we'd buffer and then discard.
      req.destroy();
      throw new PayloadTooLargeError(limitBytes);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const neo4j = createNeo4jClient(config.neo4jUri, config.neo4jUser, config.neo4jPassword);

  const transport = (process.env.MCP_TRANSPORT ?? 'http').toLowerCase();
  if (transport !== 'http' && transport !== 'stdio') {
    throw new Error(`Unknown MCP_TRANSPORT '${transport}'. Expected 'http' or 'stdio'.`);
  }

  if (transport === 'stdio') {
    await startStdio(neo4j, config);
  } else {
    const port = parsePort(process.env.MCP_HTTP_PORT) ?? DEFAULT_HTTP_PORT;
    await startHttp(neo4j, config, port);
  }

  process.on('SIGINT', async () => {
    await neo4j.close();
    process.exit(0);
  });
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT '${value}' — must be an integer in 1..65535`);
  }
  return n;
}

// Only run main when executed directly (not imported)
const isMainModule = process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
