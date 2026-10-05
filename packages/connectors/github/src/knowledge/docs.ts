// Markdown docs come from the default branch's tree: one listing per run, then
// one blob per file whose sha changed. Spec §GitHub text, "Docs".

// "**" followed by "/" crosses directories (including none); "*" stays inside one segment.
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      out += '(?:[^/]+/)*';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      out += '[^/]*';
    } else {
      out += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** The two octokit.rest.git methods this module calls. */
export interface TreeClient {
  getTree(args: { owner: string; repo: string; tree_sha: string; recursive: 'true' }): Promise<{
    data: {
      truncated?: boolean;
      tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
    };
  }>;
  getBlob(args: {
    owner: string;
    repo: string;
    file_sha: string;
  }): Promise<{ data: { content: string; encoding: string } }>;
}

export async function listDocBlobs(
  git: TreeClient,
  repo: { owner: string; name: string },
  treeSha: string,
  cfg: { paths: string[]; maxFileBytes: number },
): Promise<{ blobs: Array<{ path: string; sha: string }>; truncated: boolean }> {
  const { data } = await git.getTree({
    owner: repo.owner,
    repo: repo.name,
    tree_sha: treeSha,
    recursive: 'true',
  });
  const matchers = cfg.paths.map(globToRegExp);
  const blobs = data.tree
    .filter(
      (e): e is { path: string; type: string; sha: string; size?: number } =>
        e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string',
    )
    .filter((e) => (e.size ?? 0) <= cfg.maxFileBytes && matchers.some((m) => m.test(e.path)))
    .map((e) => ({ path: e.path, sha: e.sha }))
    // Code-point order, not locale order: the same on every machine.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { blobs, truncated: data.truncated === true };
}

export async function fetchBlobText(
  git: TreeClient,
  repo: { owner: string; name: string },
  sha: string,
): Promise<string> {
  const { data } = await git.getBlob({ owner: repo.owner, repo: repo.name, file_sha: sha });
  return decodeText(Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8'));
}

/**
 * Text by its byte-order mark. A UTF-16 file (what Windows PowerShell's `>`
 * writes) read as UTF-8 is one NUL per character, which Postgres cannot store.
 */
function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Big-endian: swap a copy to little-endian (swap16 needs an even length).
    const body = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
    return body.swap16().toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return bytes.toString('utf8');
}
