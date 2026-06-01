import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';
import { findConfigPaths } from '@/lib/onboarding/repo-root';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Seed against the ShipItOps sample dataset (~170 entities). Local Neo4j
// writes typically finish in 5–10s; cap at 60 to keep a runaway from holding
// the route open.
export const maxDuration = 90;

const SEED_TIMEOUT_MS = 60_000;

type SeedStatus = 'empty' | 'has-data' | 'unreachable';

export async function GET(): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ status: 'unreachable' satisfies SeedStatus }, { status: 403 });
  }
  let repoRoot: string;
  try {
    ({ repoRoot } = findConfigPaths());
  } catch {
    return NextResponse.json({ status: 'unreachable' satisfies SeedStatus }, { status: 200 });
  }

  // has-graph-data.ts exits 0 (data), 1 (empty), 2 (unreachable). Anything
  // else maps to 'unreachable' so the modal degrades safely.
  const code = await runScript(repoRoot, ['tsx', 'scripts/has-graph-data.ts'], 10_000);
  const status: SeedStatus = code === 0 ? 'has-data' : code === 1 ? 'empty' : 'unreachable';
  return NextResponse.json({ status }, { status: 200 });
}

export async function POST(): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { ok: false, code: 'production_disabled', message: 'Disabled in production builds.' },
      { status: 403 },
    );
  }

  let repoRoot: string;
  try {
    ({ repoRoot } = findConfigPaths());
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: 'config_missing', message: (err as Error).message },
      { status: 500 },
    );
  }

  const started = Date.now();
  const result = await runScriptWithStderr(repoRoot, ['seed'], SEED_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  if (result.code === 0) {
    return NextResponse.json({ ok: true, durationMs }, { status: 200 });
  }
  return NextResponse.json(
    {
      ok: false,
      code: result.timedOut ? 'timeout' : 'seed_failed',
      message: result.timedOut
        ? `Seed timed out after ${SEED_TIMEOUT_MS / 1000}s.`
        : `Seed exited with code ${result.code}.`,
      stderr: result.stderr.slice(-2000),
      durationMs,
    },
    { status: 500 },
  );
}

function runScript(cwd: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd, stdio: 'ignore', env: process.env });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(2);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(typeof code === 'number' ? code : 2);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(2);
    });
  });
}

interface ScriptResult {
  code: number;
  stderr: string;
  timedOut: boolean;
}

function runScriptWithStderr(
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd, env: process.env });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    // stdout is captured but not forwarded — the seed script logs progress
    // there; we don't surface it to the client to keep the response small.
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : 1, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stderr: stderr + String(err), timedOut });
    });
  });
}
