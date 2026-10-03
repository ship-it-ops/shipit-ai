'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Banner,
  Button,
  Card,
  Spinner,
  Tab,
  Tabs,
  TabsContent,
  TabsList,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  MCP_TOOLS,
  type McpToolMetadata,
  type McpToolParamSpec,
} from '@shipit-ai/mcp-server/metadata';
import { fetchMcpInfo, type McpServerInfo } from '@/lib/api';

type ClientId = 'claude-desktop' | 'claude-code' | 'cursor';

interface ClientSpec {
  id: ClientId;
  label: string;
  // Where the user pastes the snippet. Mac path; other platforms documented in mcp-tools.md.
  configPath: string;
}

const CLIENTS: readonly ClientSpec[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    configPath: '~/Library/Application Support/Claude/claude_desktop_config.json',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    configPath: '.mcp.json (in your project root)',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    configPath: '~/.cursor/mcp.json',
  },
];

// Remote MCP config: all three clients reach the hosted server over HTTP via
// the `mcp-remote` stdio bridge (broadest client support). When auth is
// enforced, the user pastes a personal access token into the Authorization
// header. `mcpUrl` is this instance's `/mcp` endpoint.
function buildSnippet(mcpUrl: string, authRequired: boolean): string {
  const args = ['-y', 'mcp-remote', mcpUrl];
  if (authRequired) {
    args.push('--header', 'Authorization: Bearer <PASTE_YOUR_TOKEN>');
  }
  return JSON.stringify(
    {
      mcpServers: {
        'shipit-ai': {
          command: 'npx',
          args,
        },
      },
    },
    null,
    2,
  );
}

// Same-origin `/mcp` endpoint (single-origin Ingress). Falls back to the
// documented path when rendered without a window (SSR).
function mcpEndpointUrl(): string {
  return typeof window !== 'undefined' ? `${window.location.origin}/mcp` : '/mcp';
}

export default function McpAccessPage() {
  const { data: info, isLoading } = useQuery<McpServerInfo>({
    queryKey: ['mcp-info'],
    queryFn: fetchMcpInfo,
    // Auth status flips only when an operator restarts the server with a new
    // env var, so refetching constantly buys nothing.
    staleTime: 60_000,
  });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <Header />
      <AuthStatusBanner info={info} loading={isLoading} />
      <ConnectionSection authRequired={info?.authRequired ?? false} />
      <ToolsSection />
    </div>
  );
}

function Header() {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h1 className="text-text text-[22px] font-semibold tracking-tight">MCP Access</h1>
      </div>
      <p className="text-text-muted text-[13px]">
        Connect AI agents to the ShipIt-AI knowledge graph via the{' '}
        <a
          href="https://modelcontextprotocol.io/"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          Model Context Protocol
        </a>
        . Connect a remote MCP client to this instance and it gets {MCP_TOOLS.length} read-only
        graph tools.
      </p>
    </header>
  );
}

function AuthStatusBanner({
  info,
  loading,
}: {
  info: McpServerInfo | undefined;
  loading: boolean;
}) {
  if (loading || !info) {
    return (
      <Banner tone="accent" icon={<Spinner size="sm" />}>
        Checking MCP server status…
      </Banner>
    );
  }
  if (info.authRequired) {
    return (
      <Banner tone="accent" icon={<IconGlyph name="key" size={14} />}>
        <strong>A personal access token is required.</strong> Mint one under{' '}
        <a href="/settings" className="underline">
          Settings → API Keys
        </a>{' '}
        (scope <code className="font-mono">mcp:invoke</code>) and paste it into the{' '}
        <code className="font-mono">Authorization</code> header in the snippet below. Each token is
        tied to your account and can be revoked anytime.
      </Banner>
    );
  }
  return (
    <Banner tone="ok" icon={<IconGlyph name="check" size={14} />}>
      <strong>No authentication required (local dev).</strong> This instance has sign-in disabled.
      In production, sign-in is enforced and the MCP endpoint requires a per-user token.
    </Banner>
  );
}

function ConnectionSection({ authRequired }: { authRequired: boolean }) {
  const mcpUrl = mcpEndpointUrl();
  const snippet = buildSnippet(mcpUrl, authRequired);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-text text-[15px] font-semibold">Connection</h2>
      <p className="text-text-muted text-[12px]">
        Paste the snippet into your MCP client&apos;s config. It connects to this instance at{' '}
        <code className="font-mono">{mcpUrl}</code> over the{' '}
        <code className="font-mono">mcp-remote</code> bridge.{' '}
        {authRequired
          ? 'Replace <PASTE_YOUR_TOKEN> with a token from Settings → API Keys.'
          : 'No token needed on this instance (sign-in disabled).'}{' '}
        The config shape is identical across all three clients; only the file location differs.
      </p>
      <Tabs defaultValue="claude-desktop" variant="pill">
        <TabsList className="w-fit">
          {CLIENTS.map((c) => (
            <Tab key={c.id} value={c.id}>
              {c.label}
            </Tab>
          ))}
        </TabsList>
        {CLIENTS.map((c) => (
          <TabsContent key={c.id} value={c.id} className="mt-3">
            <Card>
              <div className="flex flex-col gap-3">
                <div className="text-text-muted flex items-center gap-2 text-[12px]">
                  <IconGlyph name="file" size={12} />
                  <span>Add to</span>
                  <code className="text-text font-mono text-[12px]">{c.configPath}</code>
                </div>
                <CodeSnippet code={snippet} />
              </div>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

function CodeSnippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="relative">
      <pre className="border-border bg-panel-2 text-text overflow-x-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed">
        {code}
      </pre>
      <div className="absolute top-2 right-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          icon={<IconGlyph name={copied ? 'check' : 'copy'} />}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function ToolsSection() {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-text text-[15px] font-semibold">Available tools</h2>
      <p className="text-text-muted text-[12px]">
        Once connected, your agent can call any of these. See{' '}
        <a
          href="https://github.com/ship-it-ops/ShipIt-AI/blob/main/docs/mcp-tools.md"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          docs/mcp-tools.md
        </a>{' '}
        for full parameter reference and response shapes.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {MCP_TOOLS.map((tool) => (
          <ToolCard key={tool.name} tool={tool} />
        ))}
      </div>
    </section>
  );
}

function ToolCard({ tool }: { tool: McpToolMetadata }) {
  const requiredParams = tool.params.filter((p) => p.required);
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <code className="text-text font-mono text-[13px] font-medium">{tool.name}</code>
          {tool.params.length === 0 && <Badge variant="neutral">no params</Badge>}
        </div>
        <p className="text-text-muted text-[12px] leading-snug">{tool.description}</p>
        {requiredParams.length > 0 && (
          <div className="border-border border-t pt-2">
            <div className="text-text-dim mb-1 text-[10px] tracking-wide uppercase">Required</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {requiredParams.map((p) => (
                <ParamRow key={p.name} param={p} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function ParamRow({ param }: { param: McpToolParamSpec }) {
  return (
    <li className="flex items-baseline gap-2 text-[11px]">
      <code className="text-text font-mono">{param.name}</code>
      <span className="text-text-dim font-mono">{param.type}</span>
      <span className="text-text-muted">— {param.description}</span>
    </li>
  );
}
