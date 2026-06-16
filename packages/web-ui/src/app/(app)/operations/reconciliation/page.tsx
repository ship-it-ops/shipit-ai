'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Spinner,
  Tab,
  Tabs,
  TabsContent,
  TabsList,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  fetchCandidates,
  fetchMerges,
  fetchReconciliationStats,
  fetchReviewQueue,
  resolveReview,
  triggerScan,
  type MergeEventSummary,
  type ReconciliationCandidate,
  type ReconciliationStats,
  type ReviewQueueRow,
} from '@/lib/api';
import { CandidateRow } from '@/components/reconciliation/candidate-row';
import { CompareDrawer } from '@/components/reconciliation/compare-drawer';
import { MergesTable } from '@/components/reconciliation/merges-table';

function fmtVal(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export default function ReconciliationPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'pending' | 'merges' | 'reviews'>('pending');
  const [openCandidateId, setOpenCandidateId] = useState<string | null>(null);

  const { data: stats } = useQuery<ReconciliationStats>({
    queryKey: ['reconciliation-stats'],
    queryFn: fetchReconciliationStats,
  });
  const { data: candidates, isLoading: candLoading } = useQuery<ReconciliationCandidate[]>({
    queryKey: ['candidates', 'pending'],
    queryFn: () => fetchCandidates('pending'),
  });
  const { data: merges, isLoading: mergesLoading } = useQuery<MergeEventSummary[]>({
    queryKey: ['merges'],
    queryFn: fetchMerges,
    enabled: tab === 'merges',
  });
  const { data: reviews, isLoading: reviewsLoading } = useQuery<ReviewQueueRow[]>({
    queryKey: ['review-queue'],
    queryFn: fetchReviewQueue,
    enabled: tab === 'reviews',
  });

  const scan = useMutation({
    mutationFn: triggerScan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation-stats'] });
    },
  });
  const resolve = useMutation({
    mutationFn: (v: { entityId: string; propertyKey: string; action: 'accept' | 'reject' }) =>
      resolveReview(v.entityId, v.propertyKey, v.action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['review-queue'] }),
  });

  return (
    <div className="mx-auto flex h-full max-w-[1200px] flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-text text-[22px] font-semibold tracking-tight">Reconciliation</h1>
            {stats && stats.pending > 0 && <Badge variant="warn">{stats.pending} pending</Badge>}
          </div>
          <p className="text-text-muted mt-1 text-[13px]">
            Fuzzy-matched candidates that fell below the auto-merge threshold. Confirm a merge,
            reject the candidate, or mark the pair distinct so the scan never re-proposes them.
          </p>
        </div>
        <Button
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
          icon={scan.isPending ? <Spinner size="sm" /> : <IconGlyph name="refresh" />}
        >
          {scan.isPending ? 'Scanning…' : 'Run scan'}
        </Button>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'pending' | 'merges' | 'reviews')}>
        <TabsList>
          <Tab value="pending">Pending ({candidates?.length ?? 0})</Tab>
          <Tab value="reviews">Re-reviews{reviews?.length ? ` (${reviews.length})` : ''}</Tab>
          <Tab value="merges">Recent merges</Tab>
        </TabsList>
        <TabsContent value="pending" className="pt-4">
          {candLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : !candidates || candidates.length === 0 ? (
            <EmptyState
              icon={<IconGlyph name="check" size={22} />}
              title="No pending candidates"
              description='Run "Scan" to look for new fuzzy matches across the graph.'
            />
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {candidates.map((c) => (
                <CandidateRow key={c.id} candidate={c} onOpen={setOpenCandidateId} />
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="reviews" className="pt-4">
          {reviewsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : !reviews || reviews.length === 0 ? (
            <EmptyState
              icon={<IconGlyph name="check" size={22} />}
              title="No fields to re-review"
              description="A field you verified that a later sync contradicts shows up here."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {reviews.map((r) => (
                <div
                  key={`${r.entityId}#${r.propertyKey}`}
                  className="border-border bg-panel-2 rounded-base flex items-center justify-between gap-4 border p-4"
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-text text-[13px] font-medium">{r.name}</span>
                      <Badge size="sm" variant="neutral">
                        {r.label}
                      </Badge>
                      <Badge size="sm" variant="warn">
                        needs review
                      </Badge>
                    </div>
                    <div className="text-text-muted font-mono text-[12px]">
                      {r.propertyKey}: verified{' '}
                      <span className="text-text">{fmtVal(r.verifiedValue)}</span> ·{' '}
                      {r.proposedSource} now reports{' '}
                      <span className="text-text">{fmtVal(r.proposedValue)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate({
                          entityId: r.entityId,
                          propertyKey: r.propertyKey,
                          action: 'reject',
                        })
                      }
                    >
                      Keep verified
                    </Button>
                    <Button
                      size="sm"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate({
                          entityId: r.entityId,
                          propertyKey: r.propertyKey,
                          action: 'accept',
                        })
                      }
                    >
                      Accept new
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="merges" className="pt-4">
          {mergesLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : (
            <MergesTable merges={merges ?? []} />
          )}
        </TabsContent>
      </Tabs>

      <CompareDrawer candidateId={openCandidateId} onClose={() => setOpenCandidateId(null)} />
    </div>
  );
}
