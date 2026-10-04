// packages/connectors/github/src/knowledge/__tests__/markdown.test.ts
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

  it('returns nothing for an empty file', () => {
    expect(splitMarkdownByHeading('  \n\n')).toEqual([]);
  });
});
