// Splits a document into the units that are embedded and searched. Shapes per
// kind follow spec §Index pipeline, "Chunking". Everything here is pure: no I/O,
// no model calls. The structural prefix (title, heading path, channel, date) is
// embedded and indexed with the text, which gives each chunk its context
// without a model call.
import type { DocumentKind, DocumentSegment } from '@shipit-ai/connector-sdk';
import { sha256Hex } from './hash.js';

export interface ChunkingOptions {
  /** Target size. A chunk is closed once the next segment would exceed it. */
  chunkTokens: number;
  /** Hard ceiling. A single segment above it is split. */
  maxChunkTokens: number;
  /** Slack channel days split where messages pause longer than this. Default 10. */
  gapMinutes?: number;
}

export interface ChunkableDocument {
  kind: DocumentKind;
  title: string;
  segments: DocumentSegment[];
  attributes: Record<string, unknown>;
  containerName: string;
}

export interface ChunkDraft {
  seq: number;
  segmentKeys: string[];
  url?: string;
  occurredAt?: string;
  prefix: string;
  text: string;
  /** sha256 of `prefix + "\n" + text`: exactly what is embedded. */
  textHash: string;
  tokenEstimate: number;
}

/** Four characters per token: cheap, no tokenizer dependency, stable across models. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// A rendered segment: what goes into the chunk text for one source segment.
interface Piece {
  key: string;
  url?: string;
  at?: string;
  text: string;
}

interface Group {
  prefix: string;
  pieces: Piece[];
  /** Pieces carried from the previous window into the next (Slack threads: 1). */
  overlap: number;
}

export function chunkDocument(doc: ChunkableDocument, options: ChunkingOptions): ChunkDraft[] {
  const groups = groupSegments(doc, options);
  const drafts: Omit<ChunkDraft, 'seq'>[] = [];
  for (const group of groups) {
    for (const window of pack(group.pieces, options, group.overlap)) {
      const text = window.map((p) => p.text).join('\n');
      drafts.push({
        segmentKeys: [...new Set(window.map((p) => p.key))],
        url: window.find((p) => p.url)?.url,
        occurredAt: window.find((p) => p.at)?.at,
        prefix: group.prefix,
        text,
        // The prefix is embedded with the text, so it is part of what decides
        // whether an existing embedding can be reused.
        textHash: sha256Hex(`${group.prefix}\n${text}`),
        tokenEstimate: estimateTokens(text),
      });
    }
  }
  return drafts.map((d, seq) => ({ seq, ...d }));
}

// ── Grouping per kind ──────────────────────────────────────────────────────

function groupSegments(doc: ChunkableDocument, options: ChunkingOptions): Group[] {
  switch (doc.kind) {
    case 'confluence_page':
    case 'github_doc':
      return groupByHeading(doc);
    case 'jira_issue':
    case 'github_pull_request':
    case 'github_issue':
      return groupIssue(doc);
    case 'slack_thread':
      return groupThread(doc);
    case 'slack_channel_day':
      return groupChannelDay(doc, options.gapMinutes ?? 10);
  }
}

function groupByHeading(doc: ChunkableDocument): Group[] {
  const groups: Group[] = [];
  let currentPath: string | null = null;
  for (const segment of doc.segments) {
    const path = (segment.headingPath ?? []).join(' › ');
    if (path !== currentPath || groups.length === 0) {
      groups.push({
        prefix: [doc.title, ...(segment.headingPath ?? [])].join(' › '),
        pieces: [],
        overlap: 0,
      });
      currentPath = path;
    }
    groups[groups.length - 1]!.pieces.push(piece(segment, segment.text));
  }
  return groups;
}

function issuePrefix(doc: ChunkableDocument): string {
  const key = doc.attributes.key;
  const number = doc.attributes.number;
  const ref =
    typeof key === 'string' && key ? key : number !== undefined ? `#${String(number)}` : '';
  return [ref, doc.title].filter(Boolean).join(' ') + ` · ${doc.containerName}`;
}

function groupIssue(doc: ChunkableDocument): Group[] {
  const prefix = issuePrefix(doc);
  const [header, ...comments] = doc.segments;
  const groups: Group[] = [];
  if (header) groups.push({ prefix, pieces: [piece(header, header.text)], overlap: 0 });
  if (comments.length > 0) {
    groups.push({
      prefix,
      pieces: comments.map((c) => piece(c, renderAuthored(c, 'date-time'))),
      overlap: 0,
    });
  }
  return groups;
}

function groupThread(doc: ChunkableDocument): Group[] {
  const first = doc.segments[0];
  const date = first?.at ? first.at.slice(0, 10) : '';
  const firstLine = (first?.text ?? '').split('\n')[0]!.slice(0, 80);
  const prefix = [`#${doc.containerName}`, date, firstLine].filter(Boolean).join(' · ');
  return [
    {
      prefix,
      pieces: doc.segments.map((s) => piece(s, renderAuthored(s, 'time'))),
      overlap: 1,
    },
  ];
}

function groupChannelDay(doc: ChunkableDocument, gapMinutes: number): Group[] {
  const date = doc.segments[0]?.at ? doc.segments[0].at.slice(0, 10) : '';
  const prefix = [`#${doc.containerName}`, date].filter(Boolean).join(' · ');
  const groups: Group[] = [];
  let lastAt: number | null = null;
  for (const segment of doc.segments) {
    const at = segment.at ? Date.parse(segment.at) : null;
    const pause = lastAt !== null && at !== null && at - lastAt > gapMinutes * 60_000;
    if (groups.length === 0 || pause) groups.push({ prefix, pieces: [], overlap: 0 });
    groups[groups.length - 1]!.pieces.push(piece(segment, renderAuthored(segment, 'time')));
    if (at !== null) lastAt = at;
  }
  return groups;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function piece(segment: DocumentSegment, text: string): Piece {
  return { key: segment.key, url: segment.url, at: segment.at, text };
}

/** `Name (HH:MM): text` for chat, `Name (YYYY-MM-DD HH:MM):\ntext` for comments. */
function renderAuthored(segment: DocumentSegment, style: 'time' | 'date-time'): string {
  const stamp = segment.at ? formatStamp(segment.at, style) : '';
  const who = segment.authorName ?? '';
  if (!who && !stamp) return segment.text;
  const head = `${who}${stamp ? ` (${stamp})` : ''}:`;
  return style === 'time' ? `${head} ${segment.text}` : `${head}\n${segment.text}`;
}

function formatStamp(iso: string, style: 'time' | 'date-time'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return style === 'time' ? `${hh}:${mm}` : `${iso.slice(0, 10)} ${hh}:${mm}`;
}

// ── Packing ────────────────────────────────────────────────────────────────

function pack(pieces: Piece[], options: ChunkingOptions, overlap: number): Piece[][] {
  // First make every piece fit under the ceiling on its own.
  const fitted: Piece[] = [];
  for (const p of pieces) {
    if (estimateTokens(p.text) <= options.maxChunkTokens) fitted.push(p);
    else {
      for (const part of splitLongText(p.text, options.maxChunkTokens)) {
        fitted.push({ ...p, text: part });
      }
    }
  }

  const windows: Piece[][] = [];
  let current: Piece[] = [];
  let tokens = 0;
  for (const p of fitted) {
    const t = estimateTokens(p.text) + 1; // the joining newline
    if (current.length > 0 && tokens + t > options.chunkTokens) {
      windows.push(current);
      const carried = overlap > 0 ? current.slice(-overlap) : [];
      current = [...carried];
      tokens = carried.reduce((n, c) => n + estimateTokens(c.text) + 1, 0);
    }
    current.push(p);
    tokens += t;
  }
  // A trailing window that holds only the carried overlap repeats the previous
  // window's tail and nothing new: drop it.
  const onlyCarried = overlap > 0 && windows.length > 0 && current.length === overlap;
  if (current.length > 0 && !onlyCarried) windows.push(current);
  return windows;
}

/** Paragraphs first, then sentences, then a hard cut. Every part fits under maxTokens. */
export function splitLongText(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  const out: string[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer.trim().length > 0) out.push(buffer.trim());
    buffer = '';
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    const units = paragraph.length <= maxChars ? [paragraph] : paragraph.split(/(?<=[.!?])\s+/);
    for (const unit of units) {
      if (unit.length > maxChars) {
        flush();
        for (let i = 0; i < unit.length; i += maxChars) out.push(unit.slice(i, i + maxChars));
        continue;
      }
      if ((buffer + '\n\n' + unit).length > maxChars) flush();
      buffer = buffer ? `${buffer}\n\n${unit}` : unit;
    }
  }
  flush();
  return out;
}
