import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../is-main.js';

describe('isMainModule', () => {
  let dir: string;
  let serverEntry: string;
  let otherEntry: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'is-main-'));
    mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
    mkdirSync(join(dir, 'api-server', 'dist'), { recursive: true });
    serverEntry = join(dir, 'mcp-server', 'dist', 'index.js');
    otherEntry = join(dir, 'api-server', 'dist', 'index.js');
    writeFileSync(serverEntry, '');
    writeFileSync(otherEntry, '');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true when node was started with this module', () => {
    expect(isMainModule(pathToFileURL(serverEntry).href, serverEntry)).toBe(true);
  });

  it('is false when another program whose entry is also index.js imports it', () => {
    // The api-server runs `node dist/index.js` and imports this package: it
    // must not start a second MCP server inside the api-server.
    expect(isMainModule(pathToFileURL(serverEntry).href, otherEntry)).toBe(false);
  });

  it('is true for a TypeScript entry run through tsx', () => {
    const source = join(dir, 'mcp-server', 'index.ts');
    writeFileSync(source, '');
    expect(isMainModule(pathToFileURL(source).href, source)).toBe(true);
  });

  it('follows a symlinked script path', () => {
    const link = join(dir, 'mcp-bin.js');
    symlinkSync(serverEntry, link);
    expect(isMainModule(pathToFileURL(serverEntry).href, link)).toBe(true);
  });

  it('is false with no script path, or one that does not exist', () => {
    expect(isMainModule(pathToFileURL(serverEntry).href, undefined)).toBe(false);
    expect(isMainModule(pathToFileURL(serverEntry).href, join(dir, 'missing.js'))).toBe(false);
  });
});
