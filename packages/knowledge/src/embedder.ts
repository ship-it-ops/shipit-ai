// The model seam. The library knows the interface, a deterministic fake for
// tests, and how to retry; the Vertex implementation lives in knowledge-worker
// so the AI SDK never enters api-server's dependency closure.
import { createHash } from 'node:crypto';

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /**
   * Document-side embeddings (RETRIEVAL_DOCUMENT). One vector per text, same
   * order. `signal` ends the call early: the worker aborts it when it stops.
   */
  embedDocuments(
    texts: string[],
    options?: { title?: string; signal?: AbortSignal },
  ): Promise<number[][]>;
  /** Query-side embedding (RETRIEVAL_QUERY). */
  embedQuery(text: string): Promise<number[]>;
}

export class EmbeddingDimensionError extends Error {
  constructor(expected: number, actual: number) {
    super(`embedding has ${actual} dimensions, expected ${expected}`);
    this.name = 'EmbeddingDimensionError';
  }
}

export function assertDimensions(vectors: number[][], expected: number): void {
  for (const v of vectors) {
    if (v.length !== expected) throw new EmbeddingDimensionError(expected, v.length);
  }
}

/**
 * Hash-bucketed term vectors: deterministic, unit-length, and texts that share
 * words land closer together, which is all the tests need from similarity.
 */
export class FakeEmbedder implements Embedder {
  calls = 0;
  constructor(
    readonly dimensions: number = 768,
    readonly model: string = 'fake-embedding',
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    this.calls += 1;
    return this.vector(text);
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const term of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      const h = createHash('sha1').update(term).digest();
      const idx = h.readUInt32BE(0) % this.dimensions;
      v[idx] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);

export function isRetryableEmbeddingError(err: unknown): boolean {
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: string;
    name?: string;
    lastError?: unknown;
    isRetryable?: boolean;
    cause?: { code?: string };
  };
  // The AI SDK's own retry wrapper surfaces as RetryError with the last
  // underlying error inside; judge that one.
  if (e?.name === 'AI_RetryError' && e.lastError !== undefined) {
    return isRetryableEmbeddingError(e.lastError);
  }
  const status = e?.status ?? e?.statusCode;
  if (status === 429 || status === 408) return true;
  if (typeof status === 'number') return status >= 500;
  // No HTTP status: a network failure. The AI SDK reports it as an
  // APICallError flagged retryable with the socket error as its cause; plain
  // Node errors carry the code themselves.
  const code = e?.code ?? e?.cause?.code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
  return e?.name === 'AI_APICallError' && e.isRetryable === true;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff: baseDelay × 2^(attempt−1), only for errors `isRetryable` accepts. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  const base = options.baseDelayMs ?? 500;
  const isRetryable = options.isRetryable ?? isRetryableEmbeddingError;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
