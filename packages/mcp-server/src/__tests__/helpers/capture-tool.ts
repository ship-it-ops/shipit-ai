import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Minimal McpServer stand-in that captures the handler a `register*` function
 * registers, so a test can invoke the real tool body instead of re-implementing
 * it against the mock client.
 */
export function captureTool(
  register: (server: McpServer, ...rest: never[]) => void,
  ...rest: never[]
): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  let handler:
    ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  const server = {
    tool: (...args: unknown[]) => {
      handler = args[args.length - 1] as typeof handler;
    },
  } as unknown as McpServer;
  register(server, ...rest);
  if (!handler) throw new Error('register() did not register a tool handler');
  return handler;
}

/** Parse the JSON payload a tool handler returns. */
export function toolPayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}
