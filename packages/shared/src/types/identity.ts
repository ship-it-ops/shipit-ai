export interface RenameSignal {
  old_linking_key: string;
  new_linking_key: string;
  source: string;
  timestamp: string;
}

export interface MergeEvent {
  source_id: string;
  target_id: string;
  actor: string;
  timestamp: string;
  method: 'primary_key' | 'linking_key' | 'fuzzy' | 'manual';
  confidence_score: number;
}

export type IdentityMatchStep = 'primary_key' | 'linking_key' | 'fuzzy' | 'manual';
