export interface PropertyClaim {
  property_key: string;
  value: unknown;
  source: string;
  source_id: string;
  ingested_at: string; // ISO 8601
  confidence: number; // 0.0-1.0
  evidence: string | null;
  // Verification metadata (present only on `verified:<user>` claims). All optional
  // so existing stored `_claims` JSON deserializes unchanged.
  verified_by?: string | null;
  verified_at?: string | null; // ISO 8601
  /** Snapshot of the value at verification time; verification is value-bound. */
  verified_value?: unknown;
}

export type ResolutionStrategy =
  | 'MANUAL_OVERRIDE_FIRST'
  | 'HIGHEST_CONFIDENCE'
  | 'AUTHORITATIVE_ORDER'
  | 'LATEST_TIMESTAMP'
  | 'MERGE_SET';

export interface EdgeClaim {
  source: string;
  confidence: number;
  ingested_at: string;
  retracted: boolean;
  retracted_at?: string;
}

export interface ClaimResolutionResult {
  effective_value: unknown;
  winning_claim: PropertyClaim;
  strategy: ResolutionStrategy;
  all_claims: PropertyClaim[];
}
