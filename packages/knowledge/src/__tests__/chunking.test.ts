import { describe, it, expect } from 'vitest';
import type { DocumentSegment } from '@shipit-ai/connector-sdk';
import { chunkDocument, estimateTokens, type ChunkableDocument } from '../chunking.js';

const opts = { chunkTokens: 600, maxChunkTokens: 800 };
const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ');

function docOf(
  kind: ChunkableDocument['kind'],
  segments: DocumentSegment[],
  extra: Partial<ChunkableDocument> = {},
): ChunkableDocument {
  return { kind, title: 'Title', segments, attributes: {}, containerName: 'general', ...extra };
}

describe('estimateTokens', () => {
  it('is ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('chunkDocument: pages and docs', () => {
  it('packs consecutive segments under one heading and prefixes the heading path', () => {
    const doc = docOf('confluence_page', [
      { key: 'h1-1', headingPath: ['Overview'], text: words(100) },
      { key: 'h1-2', headingPath: ['Overview'], text: words(100) },
      { key: 'h2-1', headingPath: ['Overview', 'Rollout'], text: words(100) },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks.map((c) => c.prefix)).toEqual(['Title › Overview', 'Title › Overview › Rollout']);
    expect(chunks[0]!.segmentKeys).toEqual(['h1-1', 'h1-2']);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
  });

  it('splits a heading group at the target size', () => {
    const doc = docOf('github_doc', [
      { key: 'a', headingPath: ['A'], text: words(500, 'abcd') }, // ~625 tokens
      { key: 'b', headingPath: ['A'], text: words(500, 'abcd') },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.tokenEstimate <= 800)).toBe(true);
  });

  it('splits one oversized segment into several chunks that keep its key', () => {
    const doc = docOf('github_doc', [
      { key: 'big', headingPath: ['A'], text: words(3000, 'abcd') },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.tokenEstimate <= 800)).toBe(true);
    expect(chunks.every((c) => c.segmentKeys.includes('big'))).toBe(true);
  });
});

describe('chunkDocument: issues and pull requests', () => {
  it('keeps the header on its own, then windows the comments with key and title in the prefix', () => {
    const doc = docOf(
      'jira_issue',
      [
        { key: 'header', text: 'Payments API returns 502 after deploy' },
        { key: 'c1', authorName: 'Ada', at: '2026-01-01T10:00:00Z', text: words(50) },
        { key: 'c2', authorName: 'Bob', at: '2026-01-01T11:00:00Z', text: words(50) },
      ],
      { attributes: { key: 'PAY-123' }, containerName: 'Payments' },
    );
    const chunks = chunkDocument(doc, opts);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.segmentKeys).toEqual(['header']);
    expect(chunks[0]!.prefix).toBe('PAY-123 Title · Payments');
    expect(chunks[1]!.segmentKeys).toEqual(['c1', 'c2']);
    expect(chunks[1]!.text).toContain('Ada (2026-01-01 10:00):');
  });

  it('uses the pull request number when there is no key', () => {
    const doc = docOf('github_pull_request', [{ key: 'header', text: 'x' }], {
      attributes: { number: 42 },
      containerName: 'acme/api',
    });
    expect(chunkDocument(doc, opts)[0]!.prefix).toBe('#42 Title · acme/api');
  });
});

describe('chunkDocument: Slack', () => {
  const at = (h: number, m = 0) =>
    `2026-03-04T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

  it('keeps a short thread whole, renders Name (HH:MM): text, and prefixes channel, date and first line', () => {
    const doc = docOf('slack_thread', [
      { key: '1', authorName: 'Ada', at: at(9, 5), text: 'payments-api is 502ing' },
      { key: '2', authorName: 'Bob', at: at(9, 6), text: 'rolling back' },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.prefix).toBe('#general · 2026-03-04 · payments-api is 502ing');
    expect(chunks[0]!.text).toBe('Ada (09:05): payments-api is 502ing\nBob (09:06): rolling back');
    expect(chunks[0]!.occurredAt).toBe(at(9, 5));
  });

  it('windows a long thread with one message of overlap', () => {
    const segments = Array.from({ length: 40 }, (_, i) => ({
      key: String(i),
      authorName: 'A',
      at: at(10, i),
      text: words(30, 'abcd'),
    }));
    const chunks = chunkDocument(docOf('slack_thread', segments), opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prevLast = chunks[i - 1]!.segmentKeys.at(-1);
      expect(chunks[i]!.segmentKeys[0]).toBe(prevLast);
    }
  });

  it('splits a channel day where the conversation pauses for more than ten minutes', () => {
    const doc = docOf('slack_channel_day', [
      { key: '1', authorName: 'Ada', at: at(9, 0), text: 'morning' },
      { key: '2', authorName: 'Bob', at: at(9, 4), text: 'hi' },
      { key: '3', authorName: 'Ada', at: at(9, 30), text: 'deploying' },
      { key: '4', authorName: 'Bob', at: at(9, 31), text: 'ack' },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks.map((c) => c.segmentKeys)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(chunks[0]!.prefix).toBe('#general · 2026-03-04');
  });

  it('carries the first message permalink of each chunk', () => {
    const doc = docOf('slack_channel_day', [
      { key: '1', at: at(9, 0), url: 'https://s/1', text: 'a' },
      { key: '2', at: at(9, 1), url: 'https://s/2', text: 'b' },
    ]);
    expect(chunkDocument(doc, opts)[0]!.url).toBe('https://s/1');
  });
});

describe('chunkDocument: hashes', () => {
  it('gives equal text the same hash across documents', () => {
    const a = chunkDocument(
      docOf('github_doc', [{ key: 'k', headingPath: ['A'], text: 'same' }]),
      opts,
    )[0]!;
    const b = chunkDocument(
      docOf('github_doc', [{ key: 'k', headingPath: ['A'], text: 'same' }]),
      opts,
    )[0]!;
    expect(a.textHash).toBe(b.textHash);
  });
});
