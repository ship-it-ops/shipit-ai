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

const RULE_PREFIX = '@secretlint/secretlint-rule-';

function shortRule(ruleId: string): string {
  return ruleId.startsWith(RULE_PREFIX) ? ruleId.slice(RULE_PREFIX.length) : ruleId;
}

export interface Redacted {
  text: string;
  count: number;
}

export async function redactText(text: string): Promise<Redacted> {
  if (text.length === 0) return { text, count: 0 };
  const result = await lintSource({
    source: { content: text, filePath: 'segment.txt', ext: '.txt', contentType: 'text' },
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
    out.push(redacted.count > 0 ? { ...segment, text: redacted.text } : segment);
  }
  return { segments: out, count };
}
