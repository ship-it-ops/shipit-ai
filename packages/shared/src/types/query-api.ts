export interface CypherQueryRequest {
  cypher: string;
  params?: Record<string, unknown>;
}

export interface CypherQueryResponse {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  executionTimeMs: number;
  truncated: boolean;
  rowLimit: number;
}

export interface CypherQueryError {
  error: {
    code: 'WRITE_BLOCKED' | 'QUERY_TIMEOUT' | 'VALIDATION_ERROR' | 'CYPHER_ERROR';
    message: string;
    keyword?: string;
  };
}
