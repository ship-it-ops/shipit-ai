// packages/connectors/github/src/knowledge/markdown.ts
// Splits a Markdown file into one segment per heading section. ATX headings
// only (`# Title`); a `#` inside a fenced code block is content.
export interface MarkdownSection {
  /** Stable within the file: the heading path, numbered when it repeats. */
  key: string;
  headingPath: string[];
  text: string;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

export function splitMarkdownByHeading(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const seen = new Map<string, number>();
  const stack: Array<{ level: number; title: string }> = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    const headingPath = stack.map((h) => h.title);
    const base = headingPath.join(' › ') || '(top)';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    sections.push({ key: n === 1 ? base : `${base} #${n}`, headingPath, text });
  };

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line.trimStart());
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
      buffer.push(line);
      continue;
    }
    const heading = fence === null ? HEADING.exec(line) : null;
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const level = heading[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title: heading[2]! });
  }
  flush();
  return sections;
}
