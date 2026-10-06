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
  /** How many values came back as null because they were internal nodes. */
  withheld: number;
}

export interface CypherQueryError {
  error: {
    code:
      | 'WRITE_BLOCKED'
      | 'QUERY_TIMEOUT'
      | 'QUERY_BUSY'
      | 'RESULT_TOO_LARGE'
      | 'VALIDATION_ERROR'
      | 'CYPHER_ERROR';
    message: string;
    keyword?: string;
  };
}
