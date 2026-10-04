import { describe, it, expect } from 'vitest';
import {
  FakeEmbedder,
  assertDimensions,
  isRetryableEmbeddingError,
  withRetry,
} from '../embedder.js';

describe('FakeEmbedder', () => {
  it('is deterministic, unit-length and of the configured dimension', async () => {
    const e = new FakeEmbedder(8);
    const [a] = await e.embedDocuments(['alpha']);
    const [b] = await e.embedDocuments(['alpha']);
    const q = await e.embedQuery('alpha');
    expect(a).toEqual(b);
    expect(a).toEqual(q);
    expect(a).toHaveLength(8);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6);
    expect(e.calls).toBe(3);
  });

  it('ranks the same text closest', async () => {
    const e = new FakeEmbedder(64);
    const [x, y] = await e.embedDocuments(['payments api outage', 'lunch menu']);
    const q = await e.embedQuery('payments api outage');
    const dot = (p: number[], r: number[]) => p.reduce((s, v, i) => s + v * r[i]!, 0);
    expect(dot(q, x!)).toBeGreaterThan(dot(q, y!));
  });
});

describe('assertDimensions', () => {
  it('throws when a vector has the wrong length', () => {
    expect(() => assertDimensions([[1, 2, 3]], 3)).not.toThrow();
    expect(() => assertDimensions([[1, 2]], 3)).toThrow(/expected 3/);
  });
});

describe('withRetry', () => {
  const retryable = Object.assign(new Error('rate limited'), { status: 429 });
  const fatal = Object.assign(new Error('bad request'), { status: 400 });

  it('retries retryable errors with growing delays and returns the eventual value', async () => {
    const delays: number[] = [];
    let n = 0;
    const value = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw retryable;
        return 'ok';
      },
      {
        attempts: 5,
        baseDelayMs: 100,
        isRetryable: isRetryableEmbeddingError,
        sleep: async (ms) => void delays.push(ms),
      },
    );
    expect(value).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  it('gives up after the configured attempts', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw retryable;
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          isRetryable: isRetryableEmbeddingError,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow('rate limited');
    expect(n).toBe(3);
  });

  it('does not retry a non-retryable error', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw fatal;
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          isRetryable: isRetryableEmbeddingError,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow('bad request');
    expect(n).toBe(1);
  });
});

describe('isRetryableEmbeddingError', () => {
  it('classifies by status and network code', () => {
    expect(isRetryableEmbeddingError({ status: 429 })).toBe(true);
    expect(isRetryableEmbeddingError({ statusCode: 503 })).toBe(true);
    expect(isRetryableEmbeddingError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableEmbeddingError({ status: 401 })).toBe(false);
    expect(isRetryableEmbeddingError(new Error('x'))).toBe(false);
  });

  it('looks through the AI SDK RetryError to the last underlying error', () => {
    const wrapped = { name: 'AI_RetryError', lastError: { statusCode: 429 } };
    expect(isRetryableEmbeddingError(wrapped)).toBe(true);
    expect(isRetryableEmbeddingError({ name: 'AI_RetryError', lastError: { status: 400 } })).toBe(
      false,
    );
  });
});
