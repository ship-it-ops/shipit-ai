'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Spinner,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  createToken,
  fetchTokens,
  revokeToken,
  type AccessTokenSummary,
  type MintedToken,
} from '@/lib/api';

const AVAILABLE_SCOPES = ['mcp:invoke', 'graph:read', 'catalog:read'] as const;
type AvailableScope = (typeof AVAILABLE_SCOPES)[number];

// Stage D2 of the auth-and-rbac milestone. Wires the existing Settings →
// API Keys tab to the real /api/tokens endpoints. Tokens persist as
// _AccessToken nodes in Neo4j; the api-server returns the plaintext
// exactly once at creation, and the "I've saved it" panel below is the
// user's only chance to grab it. This file also handles the
// "auth disabled" case — /api/tokens returns 503 in that mode, so we
// show a guidance EmptyState instead of an empty table.

export function ApiKeysTab() {
  const queryClient = useQueryClient();
  const tokensQuery = useQuery({
    queryKey: ['tokens'],
    queryFn: fetchTokens,
    retry: false,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeToken(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [minted, setMinted] = useState<MintedToken | null>(null);

  if (tokensQuery.isLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center gap-2 py-8">
          <Spinner size="sm" />
          <span className="text-text-dim text-[12px]">Loading tokens…</span>
        </div>
      </Card>
    );
  }

  if (tokensQuery.error) {
    // 503 TOKENS_DISABLED is the auth-disabled path. We treat any error
    // as "tokens aren't available here" and route the user to the MCP
    // page where the shared-secret option lives.
    return (
      <EmptyState
        tone="accent"
        icon={<IconGlyph name="bolt" size={22} />}
        title="Personal access tokens aren't enabled"
        description="Tokens require accessControl.auth.enabled to be true. Until then, the MCP server can use a shared secret via the apiKeySecret env var."
        action={
          <Button variant="outline" asChild icon={<IconGlyph name="sparkle" />}>
            <a href="/configure/mcp">Open MCP Access</a>
          </Button>
        }
      />
    );
  }

  const tokens = tokensQuery.data ?? [];
  const activeTokens = tokens.filter((t) => !t.revoked);
  const revokedTokens = tokens.filter((t) => t.revoked);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Personal access tokens"
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<IconGlyph name="add" />}
            onClick={() => setCreateOpen(true)}
          >
            New token
          </Button>
        }
      >
        <p className="text-text-muted mb-3 text-[12px]">
          Use a token to authenticate AI agents and CLI tools against the MCP server. The plaintext
          is shown only once — store it somewhere safe before closing the dialog.
        </p>

        {activeTokens.length === 0 ? (
          <p className="text-text-dim m-0 text-[12px]">No active tokens yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {activeTokens.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                onRevoke={() => revokeMutation.mutate(token.id)}
                revoking={revokeMutation.isPending}
              />
            ))}
          </ul>
        )}
      </Card>

      {revokedTokens.length > 0 && (
        <Card title="Revoked">
          <p className="text-text-muted mb-3 text-[12px]">
            Kept for audit. Revoked tokens can no longer authenticate.
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {revokedTokens.map((token) => (
              <TokenRow key={token.id} token={token} />
            ))}
          </ul>
        </Card>
      )}

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) setMinted(null);
        }}
        onMinted={(token) => {
          setMinted(token);
          queryClient.invalidateQueries({ queryKey: ['tokens'] });
        }}
        minted={minted}
      />
    </div>
  );
}

function TokenRow({
  token,
  onRevoke,
  revoking,
}: {
  token: AccessTokenSummary;
  onRevoke?: () => void;
  revoking?: boolean;
}) {
  return (
    <li className="border-border flex items-center justify-between gap-3 rounded border p-3">
      <div className="min-w-0">
        <div className="text-text text-[13px] font-medium">{token.name}</div>
        <div className="text-text-dim mt-[2px] flex flex-wrap items-center gap-2 text-[11px]">
          <span>Created {new Date(token.createdAt).toLocaleDateString()}</span>
          <span aria-hidden>·</span>
          <span>
            {token.lastUsedAt
              ? `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`
              : 'Never used'}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {token.scopes.map((scope) => (
            <Badge key={scope} variant="outline" size="sm">
              {scope}
            </Badge>
          ))}
        </div>
      </div>
      {onRevoke && !token.revoked && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRevoke}
          disabled={revoking}
          icon={<IconGlyph name="trash" />}
        >
          Revoke
        </Button>
      )}
      {token.revoked && (
        <Badge variant="neutral" size="sm">
          Revoked
        </Badge>
      )}
    </li>
  );
}

function CreateTokenDialog({
  open,
  onOpenChange,
  onMinted,
  minted,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onMinted: (token: MintedToken) => void;
  minted: MintedToken | null;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AvailableScope[]>(['mcp:invoke']);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createToken({ name: name.trim(), scopes }),
    onSuccess: (token) => {
      onMinted(token);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not mint token'),
  });

  const reset = () => {
    setName('');
    setScopes(['mcp:invoke']);
    setError(null);
    setCopied(false);
    mutation.reset();
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const copyPlaintext = async () => {
    if (!minted) return;
    await navigator.clipboard.writeText(minted.token);
    setCopied(true);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleClose}
      title={minted ? 'Token created' : 'Create a token'}
      description={
        minted
          ? "Copy the plaintext now. We don't store it — once you close this dialog, you'll only see the metadata."
          : 'Give the token a name and pick which scopes it should grant.'
      }
      width={520}
      footer={
        minted ? (
          <Button variant="primary" onClick={() => handleClose(false)}>
            I&apos;ve saved it
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => mutation.mutate()}
              disabled={name.trim().length === 0 || scopes.length === 0 || mutation.isPending}
            >
              {mutation.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </>
        )
      }
    >
      {minted ? (
        <div className="flex flex-col gap-3">
          <div className="border-border bg-panel-2 rounded border p-3">
            <code className="text-text font-mono text-[12px] break-all">{minted.token}</code>
          </div>
          <Button
            variant="outline"
            size="sm"
            icon={<IconGlyph name={copied ? 'check' : 'copy'} />}
            onClick={copyPlaintext}
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Name" hint="Helps you remember what this token is for.">
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CI bot, my-laptop, Claude Code"
                autoFocus
              />
            )}
          </Field>
          <Field label="Scopes" hint="Pick the capabilities this token grants.">
            {() => (
              <div className="flex flex-col gap-2">
                {AVAILABLE_SCOPES.map((scope) => (
                  <Checkbox
                    key={scope}
                    label={scope}
                    checked={scopes.includes(scope)}
                    onCheckedChange={(checked) => {
                      setScopes((prev) =>
                        checked ? [...prev, scope] : prev.filter((s) => s !== scope),
                      );
                    }}
                  />
                ))}
              </div>
            )}
          </Field>
          {error && (
            <div className="text-err text-[12px]" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
