export enum McpErrorCode {
  NODE_NOT_FOUND = 'NODE_NOT_FOUND',
  INVALID_CANONICAL_ID = 'INVALID_CANONICAL_ID',
  INVALID_PARAMETER = 'INVALID_PARAMETER',
  DEPTH_EXCEEDED = 'DEPTH_EXCEEDED',
  HOP_LIMIT_EXCEEDED = 'HOP_LIMIT_EXCEEDED',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
  ROW_LIMIT_EXCEEDED = 'ROW_LIMIT_EXCEEDED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  RBAC_DENIED = 'RBAC_DENIED',
  TOOL_NOT_AVAILABLE = 'TOOL_NOT_AVAILABLE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface McpError {
  error: {
    code: McpErrorCode;
    message: string;
    suggestions?: string[];
  };
}

export function createError(code: McpErrorCode, message: string, suggestions?: string[]): McpError {
  return {
    error: {
      code,
      message,
      ...(suggestions?.length ? { suggestions } : {}),
    },
  };
}

export function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0) as number[]);

  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[la][lb];
}

export function findSuggestions(
  input: string,
  candidates: string[],
  maxDistance: number = 2,
  maxSuggestions: number = 3,
): string[] {
  return candidates
    .map((c) => ({
      candidate: c,
      distance: levenshteinDistance(input.toLowerCase(), c.toLowerCase()),
    }))
    .filter((r) => r.distance <= maxDistance && r.distance > 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxSuggestions)
    .map((r) => `Did you mean '${r.candidate}'?`);
}
