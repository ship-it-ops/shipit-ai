import { createHash } from 'node:crypto';
import type { DocumentSegment } from '@shipit-ai/connector-sdk';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The content fingerprint that decides whether a document is re-indexed. It
 * covers what the chunker reads (title, structure, authorship, time, text) and
 * ignores display names, which drift without the content changing.
 */
export function contentHashOf(title: string, segments: DocumentSegment[]): string {
  const canonical = JSON.stringify({
    title,
    segments: segments.map((s) => ({
      key: s.key,
      headingPath: s.headingPath ?? null,
      authorExternalId: s.authorExternalId ?? null,
      at: s.at ?? null,
      url: s.url ?? null,
      text: s.text,
    })),
  });
  return sha256Hex(canonical);
}
