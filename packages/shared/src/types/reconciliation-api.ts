export interface ReconciliationCandidate {
  id: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'distinct';
  leftId: string;
  leftName: string;
  leftSource: string | null;
  rightId: string;
  rightName: string;
  rightSource: string | null;
  label: string;
  confidence: number;
  scoreBreakdown: {
    name: number;
    namespace: number;
    tags: number;
    labels: number;
  };
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface CandidateDetail extends ReconciliationCandidate {
  leftProperties: Record<string, unknown>;
  rightProperties: Record<string, unknown>;
}

export interface MergeEventSummary {
  id: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  actor: string;
  timestamp: string;
  method: 'primary_key' | 'linking_key' | 'fuzzy' | 'manual';
  confidence: number;
}

export interface ReconciliationStats {
  pending: number;
  recentMerges: number;
  lastScanAt: string | null;
}
