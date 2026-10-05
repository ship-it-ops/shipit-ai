import { describe, it, expect } from 'vitest';
import { splitMarkdownByHeading } from '../markdown.js';

describe('splitMarkdownByHeading', () => {
  it('gives each section its heading path', () => {
    const out = splitMarkdownByHeading(
      [
        'intro line',
        '# Deploy',
        'how to deploy',
        '## Rollback',
        'drain first',
        '# FAQ',
        'q and a',
      ].join('\n'),
    );
    expect(out.map((s) => [s.headingPath, s.text])).toEqual([
      [[], 'intro line'],
      [['Deploy'], 'how to deploy'],
      [['Deploy', 'Rollback'], 'drain first'],
      [['FAQ'], 'q and a'],
    ]);
  });

  it('does not read a # inside a code fence as a heading', () => {
    const out = splitMarkdownByHeading(
      ['# Setup', '```sh', '# not a heading', 'make', '```'].join('\n'),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('# not a heading');
  });

  it('drops sections with no text and keeps keys unique', () => {
    const out = splitMarkdownByHeading(['# A', '# A', 'one', '# A', 'two'].join('\n'));
    expect(out.map((s) => s.text)).toEqual(['one', 'two']);
    expect(new Set(out.map((s) => s.key)).size).toBe(2);
  });

  it('strips closing hashes and surrounding space from a heading', () => {
    expect(splitMarkdownByHeading('##  Title ##\nbody')[0]!.headingPath).toEqual(['Title']);
  });

  it('reads a heading in linear time, however much whitespace follows it', () => {
    // The first heading pattern backtracked polynomially on a line like this
    // one (8 s at 4,000 spaces, hours at the 200 KB a doc may be) and held the
    // api-server's event loop for it. Long enough here that a regression takes
    // seconds and fails, short enough that it does not hang the suite.
    const line = '# a' + ' '.repeat(5_000) + 'x';
    const started = performance.now();
    const out = splitMarkdownByHeading(`${line}\nbody`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out).toHaveLength(1);
    expect(out[0]!.headingPath[0]!.startsWith('a')).toBe(true);
    expect(out[0]!.text).toBe('body');
  });

  it('keeps hashes that are part of the title and drops only a closing run', () => {
    expect(splitMarkdownByHeading('# C# and F#\nbody')[0]!.headingPath).toEqual(['C# and F#']);
    expect(splitMarkdownByHeading('## Title ##   \nbody')[0]!.headingPath).toEqual(['Title']);
    expect(splitMarkdownByHeading('#\tTabbed\nbody')[0]!.headingPath).toEqual(['Tabbed']);
  });

  it('does not take a line with no space after the hashes for a heading', () => {
    const out = splitMarkdownByHeading('#hashtag\n#123 fixed');
    expect(out).toHaveLength(1);
    expect(out[0]!.headingPath).toEqual([]);
  });

  it('returns nothing for an empty file', () => {
    expect(splitMarkdownByHeading('  \n\n')).toEqual([]);
  });
});
