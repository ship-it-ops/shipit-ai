import { describe, it, expect } from 'vitest';
import { wrapResponse } from '../envelope.js';
import type { McpResponse } from '../envelope.js';

describe('Envelope', () => {
  describe('wrapResponse', () => {
    it('should wrap data with _meta', () => {
      const data = { foo: 'bar' };
      const result = wrapResponse('test_tool', data) as McpResponse<typeof data>;

      expect(result._meta).toBeDefined();
      expect(result._meta.tool).toBe('test_tool');
      expect(result._meta.version).toBe('1.0');
      expect(result._meta.truncated).toBe(false);
      expect(result._meta.cache_hit).toBe(false);
      expect(result.data).toEqual(data);
    });

    it('should return raw data when compact is true', () => {
      const data = { foo: 'bar' };
      const result = wrapResponse('test_tool', data, { compact: true });

      expect(result).toEqual(data);
      expect((result as McpResponse<typeof data>)._meta).toBeUndefined();
    });

    it('should include query time and node count', () => {
      const data = { items: [] };
      const result = wrapResponse('test_tool', data, {
        queryTimeMs: 142,
        nodeCount: 12,
      }) as McpResponse<typeof data>;

      expect(result._meta.query_time_ms).toBe(142);
      expect(result._meta.node_count).toBe(12);
    });

    it('should include warnings when provided', () => {
      const result = wrapResponse(
        'test_tool',
        {},
        {
          warnings: ['Some warning'],
        },
      ) as McpResponse<object>;

      expect(result._meta.warnings).toEqual(['Some warning']);
    });

    it('should not include empty warnings', () => {
      const result = wrapResponse(
        'test_tool',
        {},
        {
          warnings: [],
        },
      ) as McpResponse<object>;

      expect(result._meta.warnings).toBeUndefined();
    });

    it('should include suggested_follow_up when provided', () => {
      const result = wrapResponse(
        'test_tool',
        {},
        {
          suggestedFollowUp: ['Try entity_detail for more info'],
        },
      ) as McpResponse<object>;

      expect(result._meta.suggested_follow_up).toEqual(['Try entity_detail for more info']);
    });

    it('should include next_cursor when provided', () => {
      const result = wrapResponse(
        'test_tool',
        {},
        {
          nextCursor: 'abc123',
        },
      ) as McpResponse<object>;

      expect(result._meta.next_cursor).toBe('abc123');
    });

    it('should set truncated flag', () => {
      const result = wrapResponse(
        'test_tool',
        {},
        {
          truncated: true,
        },
      ) as McpResponse<object>;

      expect(result._meta.truncated).toBe(true);
    });
  });
});
