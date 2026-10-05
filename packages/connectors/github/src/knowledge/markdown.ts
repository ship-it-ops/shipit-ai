// Splits a Markdown file into one segment per heading section. ATX headings
// only (`# Title`); a `#` inside a fenced code block is content.
export interface MarkdownSection {
  /** Stable within the file: the heading path, numbered when it repeats. */
  key: string;
  headingPath: string[];
  text: string;
}

const HASH = 35;
const SPACE = 32;
const TAB = 9;

/**
 * An ATX heading: one to six hashes, then a space or a tab. Parsed by hand: a
 * pattern with optional whitespace on both sides of a lazy title backtracks
 * polynomially on a long run of spaces, and this runs on the api-server's
 * event loop over files anyone with push access can write.
 */
function headingOf(line: string): { level: number; title: string } | null {
  let level = 0;
  while (level < 7 && line.charCodeAt(level) === HASH) level++;
  if (level === 0 || level > 6) return null;
  const after = line.charCodeAt(level);
  if (after !== SPACE && after !== TAB) return null;
  let title = line.slice(level + 1).trim();
  // A closing run of hashes counts only when whitespace precedes it
  // ("## Title ##"); in "# C# and F#" the last hash is part of the title.
  let end = title.length;
  while (end > 0 && title.charCodeAt(end - 1) === HASH) end--;
  if (end < title.length) {
    const before = end === 0 ? SPACE : title.charCodeAt(end - 1);
    if (before === SPACE || before === TAB) title = title.slice(0, end).trimEnd();
  }
  // One space wherever the source had a run of them: the title becomes part
  // of every chunk's prefix.
  return { level, title: title.replace(/\s+/g, ' ') };
}
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
    const heading = fence === null ? headingOf(line) : null;
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    stack.push(heading);
  }
  flush();
  return sections;
}
