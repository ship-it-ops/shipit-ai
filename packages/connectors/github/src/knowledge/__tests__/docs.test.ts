// packages/connectors/github/src/knowledge/__tests__/docs.test.ts
import { describe, it, expect } from 'vitest';
import { fetchBlobText, globToRegExp, listDocBlobs, matchesAny, type TreeClient } from '../docs.js';

const DEFAULTS = ['README.md', 'docs/**/*.md', 'adr/**/*.md', '**/ADR-*.md'];

describe('globs', () => {
  it.each([
    ['README.md', true],
    ['sub/README.md', false],
    ['docs/a.md', true],
    ['docs/deep/er/a.md', true],
    ['docs/a.txt', false],
    ['adr/0001-use-postgres.md', true],
    ['ADR-7.md', true],
    ['services/pay/ADR-12-ledger.md', true],
    ['src/readme.md', false],
    ['docsx/a.md', false],
  ])('%s → %s under the default paths', (path, expected) => {
    expect(matchesAny(path, DEFAULTS)).toBe(expected);
  });

  it('treats a dot and other regex characters literally', () => {
    expect(globToRegExp('a.md').test('axmd')).toBe(false);
    expect(globToRegExp('a+b(1).md').test('a+b(1).md')).toBe(true);
  });

  it('does not let a single star cross a directory', () => {
    expect(globToRegExp('docs/*.md').test('docs/a/b.md')).toBe(false);
  });
});

function gitWith(tree: unknown[], truncated = false, blobs: Record<string, string> = {}) {
  const calls: string[] = [];
  const git: TreeClient = {
    async getTree(args) {
      calls.push(`tree:${args.tree_sha}`);
      return { data: { truncated, tree: tree as never } };
    },
    async getBlob(args) {
      calls.push(`blob:${args.file_sha}`);
      return {
        data: {
          content: Buffer.from(blobs[args.file_sha] ?? '').toString('base64'),
          encoding: 'base64',
        },
      };
    },
  };
  return { git, calls };
}

describe('listDocBlobs', () => {
  it('lists only matching blobs under the size limit, sorted by path', async () => {
    const { git } = gitWith([
      { path: 'docs/b.md', type: 'blob', sha: 's2', size: 10 },
      { path: 'README.md', type: 'blob', sha: 's1', size: 10 },
      { path: 'docs', type: 'tree', sha: 't1' },
      { path: 'docs/huge.md', type: 'blob', sha: 's3', size: 999999 },
      { path: 'src/index.ts', type: 'blob', sha: 's4', size: 10 },
    ]);
    const out = await listDocBlobs(git, { owner: 'acme', name: 'payments' }, 'tree1', {
      paths: DEFAULTS,
      maxFileBytes: 200000,
    });
    expect(out).toEqual({
      blobs: [
        { path: 'README.md', sha: 's1' },
        { path: 'docs/b.md', sha: 's2' },
      ],
      truncated: false,
    });
  });

  it('reports a tree GitHub truncated', async () => {
    const { git } = gitWith([], true);
    const out = await listDocBlobs(git, { owner: 'a', name: 'b' }, 't', {
      paths: DEFAULTS,
      maxFileBytes: 1,
    });
    expect(out.truncated).toBe(true);
  });
});

describe('fetchBlobText', () => {
  it('decodes base64 as UTF-8', async () => {
    const { git } = gitWith([], false, { s1: '# Título\ncuerpo' });
    expect(await fetchBlobText(git, { owner: 'a', name: 'b' }, 's1')).toBe('# Título\ncuerpo');
  });
});
