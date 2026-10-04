// packages/connectors/github/src/knowledge/ids.ts
// External ids of GitHub knowledge documents. Built on the repository's
// numeric id, which survives a rename or a transfer; names do not.
export const pullRequestId = (repoId: number, n: number): string => `pr:${repoId}:${n}`;
export const issueId = (repoId: number, n: number): string => `issue:${repoId}:${n}`;
export const docId = (repoId: number, path: string): string => `doc:${repoId}:${path}`;
