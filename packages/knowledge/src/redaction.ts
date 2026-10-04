// Secrets are redacted BEFORE a segment is stored or embedded (spec decision
// 14), so neither Postgres nor Vertex ever sees them. The rule set is the same
// secretlint recommended preset the repo's pre-commit hook runs, used as a
// library. The repo's .secretlintrc.json allow-list (local dev database URLs)
// is deliberately NOT applied here: content is not our source tree.
import { lintSource } from '@secretlint/core';
import { creator as recommendedPreset } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfig } from '@secretlint/types';
import type { DocumentSegment } from '@shipit-ai/connector-sdk';

const CONFIG: SecretLintCoreConfig = {
  rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: recommendedPreset }],
};

// The preset bundles the filter-comments rule: a `secretlint-disable` comment
// switches detection off for what follows. That is for source trees; in
// ingested content it would let the text's author (or a pasted config file)
// turn redaction off. The preset offers no way to drop that rule, so the
// linter is shown a copy with the directive word blanked out, same length, and
// the ranges it reports are cut from the original.
const DIRECTIVE = /secretlint-(?:disable|enable)/g;
const blankDirectives = (text: string): string =>
  text.replace(DIRECTIVE, (match) => 'x'.repeat(match.length));

const RULE_PREFIX = '@secretlint/secretlint-rule-';

function shortRule(ruleId: string): string {
  return ruleId.startsWith(RULE_PREFIX) ? ruleId.slice(RULE_PREFIX.length) : ruleId;
}

export interface Redacted {
  text: string;
  count: number;
}

/**
 * Postgres cannot store U+0000 in text or jsonb, and one such character would
 * fail a whole batch on every run. A UTF-16 file read as UTF-8 is full of them.
 */
export function stripNul(text: string): string {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
}

export async function redactText(input: string): Promise<Redacted> {
  const text = stripNul(input);
  if (text.length === 0) return { text, count: 0 };
  const result = await lintSource({
    source: {
      content: blankDirectives(text),
      filePath: 'segment.txt',
      ext: '.txt',
      contentType: 'text',
    },
    options: { config: CONFIG, locale: 'en', maskSecrets: false, noPhysicFilePath: true },
  });
  const ranges = result.messages
    .filter((m) => m.type === 'message')
    .map((m) => ({ start: m.range[0], end: m.range[1], rule: shortRule(m.ruleId) }))
    .sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return { text, count: 0 };

  // Merge overlaps (two rules can flag the same bytes), then splice from the end
  // so earlier offsets stay valid.
  const merged: typeof ranges = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = text;
  for (const r of [...merged].reverse()) {
    out = `${out.slice(0, r.start)}[redacted:${r.rule}]${out.slice(r.end)}`;
  }
  return { text: out, count: merged.length };
}

export async function redactSegments(
  segments: DocumentSegment[],
): Promise<{ segments: DocumentSegment[]; count: number }> {
  let count = 0;
  const out: DocumentSegment[] = [];
  for (const segment of segments) {
    const redacted = await redactText(segment.text);
    count += redacted.count;
    out.push(redacted.text !== segment.text ? { ...segment, text: redacted.text } : segment);
  }
  return { segments: out, count };
}
