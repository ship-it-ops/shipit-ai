import { describe, it, expect } from 'vitest';
import { McpErrorCode, createError, levenshteinDistance, findSuggestions } from '../errors.js';

describe('Errors', () => {
  describe('createError', () => {
    it('should create error with code and message', () => {
      const error = createError(McpErrorCode.NODE_NOT_FOUND, 'Entity not found');
      expect(error.error.code).toBe('NODE_NOT_FOUND');
      expect(error.error.message).toBe('Entity not found');
      expect(error.error.suggestions).toBeUndefined();
    });

    it('should include suggestions when provided', () => {
      const error = createError(McpErrorCode.NODE_NOT_FOUND, 'Not found', [
        "Did you mean 'payments-api'?",
      ]);
      expect(error.error.suggestions).toEqual(["Did you mean 'payments-api'?"]);
    });

    it('should not include suggestions key when empty array', () => {
      const error = createError(McpErrorCode.INTERNAL_ERROR, 'Error', []);
      expect(error.error.suggestions).toBeUndefined();
    });
  });

  describe('levenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('test', 'test')).toBe(0);
    });

    it('should return correct distance for single character difference', () => {
      expect(levenshteinDistance('test', 'tast')).toBe(1);
    });

    it('should return correct distance for insertions', () => {
      expect(levenshteinDistance('test', 'tests')).toBe(1);
    });

    it('should return correct distance for deletions', () => {
      expect(levenshteinDistance('tests', 'test')).toBe(1);
    });

    it('should handle empty strings', () => {
      expect(levenshteinDistance('', 'abc')).toBe(3);
      expect(levenshteinDistance('abc', '')).toBe(3);
    });

    it('should return distance of 2 for paymets vs payments', () => {
      expect(levenshteinDistance('paymets-api', 'payments-api')).toBeLessThanOrEqual(2);
    });
  });

  describe('findSuggestions', () => {
    const candidates = [
      'shipit://logical-service/default/payments-api',
      'shipit://logical-service/default/config-service',
      'shipit://logical-service/default/ledger-service',
    ];

    it('should find suggestions within Levenshtein distance', () => {
      const suggestions = findSuggestions(
        'shipit://logical-service/default/paymets-api',
        candidates,
      );
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toContain('payments-api');
    });

    it('should return empty for no close matches', () => {
      const suggestions = findSuggestions('completely-different', candidates);
      expect(suggestions).toEqual([]);
    });

    it('should limit suggestions to maxSuggestions', () => {
      const suggestions = findSuggestions(
        'shipit://logical-service/default/x-service',
        candidates,
        20,
        2,
      );
      expect(suggestions.length).toBeLessThanOrEqual(2);
    });

    it('should not suggest exact matches', () => {
      const suggestions = findSuggestions(candidates[0], candidates);
      expect(suggestions.length).toBe(0);
    });
  });

  describe('McpErrorCode enum', () => {
    it('should have all expected error codes', () => {
      expect(McpErrorCode.NODE_NOT_FOUND).toBe('NODE_NOT_FOUND');
      expect(McpErrorCode.INVALID_CANONICAL_ID).toBe('INVALID_CANONICAL_ID');
      expect(McpErrorCode.INVALID_PARAMETER).toBe('INVALID_PARAMETER');
      expect(McpErrorCode.DEPTH_EXCEEDED).toBe('DEPTH_EXCEEDED');
      expect(McpErrorCode.HOP_LIMIT_EXCEEDED).toBe('HOP_LIMIT_EXCEEDED');
      expect(McpErrorCode.QUERY_TIMEOUT).toBe('QUERY_TIMEOUT');
      expect(McpErrorCode.ROW_LIMIT_EXCEEDED).toBe('ROW_LIMIT_EXCEEDED');
      expect(McpErrorCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
      expect(McpErrorCode.RBAC_DENIED).toBe('RBAC_DENIED');
      expect(McpErrorCode.TOOL_NOT_AVAILABLE).toBe('TOOL_NOT_AVAILABLE');
      expect(McpErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    });
  });
});
