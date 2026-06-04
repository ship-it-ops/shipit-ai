'use client';

import { useCallback, useState } from 'react';
import { Button, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { runCypherQuery, type CypherQueryResult, type CypherApiError } from '@/lib/api';
import { QueryEditor } from '@/components/query/query-editor';
import { ResultGrid } from '@/components/query/result-grid';
import { SavedQueries } from '@/components/query/saved-queries';

const DEFAULT_QUERY = `MATCH (n)
RETURN labels(n)[0] AS label, count(*) AS count
ORDER BY count DESC`;

export default function QueryPlaygroundPage() {
  const [cypher, setCypher] = useState(DEFAULT_QUERY);
  const [result, setResult] = useState<CypherQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<CypherApiError['code'] | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    if (!cypher.trim() || running) return;
    setRunning(true);
    setError(null);
    setErrorCode(null);
    try {
      const r = await runCypherQuery(cypher);
      setResult(r);
    } catch (err) {
      const e = err as Error & { code?: CypherApiError['code'] };
      setError(e.message);
      setErrorCode(e.code ?? null);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [cypher, running]);

  return (
    <div className="mx-auto flex h-full max-w-[1400px] flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-text text-[22px] font-semibold tracking-tight">Query Playground</h1>
          <p className="text-text-muted mt-1 text-[13px]">
            Read-only Cypher against the live knowledge graph.
          </p>
        </div>
        <Button
          onClick={run}
          disabled={!cypher.trim() || running}
          icon={running ? <Spinner size="sm" /> : <IconGlyph name="expand" size={12} />}
        >
          {running ? 'Running…' : 'Run query'}
        </Button>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <div className="flex min-w-0 flex-col gap-4">
          <QueryEditor value={cypher} onChange={setCypher} onSubmit={run} disabled={running} />
          {errorCode === 'WRITE_BLOCKED' && (
            <div className="border-err/40 text-err rounded-base flex items-start gap-2 border bg-[color:var(--color-err)]/10 px-3 py-2 text-[12px]">
              <IconGlyph name="warn" size={14} />
              <span>
                {error} The Query Playground is read-only — use the Schema Editor or a connector
                sync for graph changes.
              </span>
            </div>
          )}
          <ResultGrid result={result} error={errorCode === 'WRITE_BLOCKED' ? null : error} />
        </div>

        <aside className="min-w-0">
          <SavedQueries currentCypher={cypher} onLoad={setCypher} />
        </aside>
      </div>
    </div>
  );
}
