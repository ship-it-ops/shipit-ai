import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NextResponse } from 'next/server';
import { parseDocument } from 'yaml';
import { findConfigPaths } from '@/lib/onboarding/repo-root';
import {
  devUserYamlSnippet,
  validateDevUser,
  type DevUserPayload,
} from '@/lib/onboarding/dev-user-payload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ErrorBody {
  ok: false;
  code: 'production_disabled' | 'validation' | 'config_missing' | 'write_failed' | 'parse_failed';
  message: string;
  errors?: Array<{ field: string; message: string }>;
  manualYaml?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return json<ErrorBody>(
      {
        ok: false,
        code: 'production_disabled',
        message: 'Onboarding writes are disabled in production builds.',
      },
      403,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json<ErrorBody>(
      { ok: false, code: 'validation', message: 'Request body must be JSON.' },
      400,
    );
  }

  const validated = validateDevUser(body);
  if (!validated.ok) {
    return json<ErrorBody>(
      {
        ok: false,
        code: 'validation',
        message: 'Invalid devUser payload.',
        errors: validated.errors,
      },
      400,
    );
  }
  const payload = validated.value;

  let localPath: string;
  try {
    ({ localPath } = findConfigPaths());
  } catch (err) {
    return json<ErrorBody>(
      {
        ok: false,
        code: 'config_missing',
        message: (err as Error).message,
        manualYaml: devUserYamlSnippet(payload),
      },
      500,
    );
  }

  // If shipit.config.local.yaml is absent, preflight should have copied it.
  // Don't try to bootstrap from inside the route — surfacing the missing-file
  // state lets the user understand the actual state of their checkout.
  if (!existsSync(localPath)) {
    return json<ErrorBody>(
      {
        ok: false,
        code: 'config_missing',
        message: `${localPath} doesn't exist. Run \`pnpm preflight\` to bootstrap it.`,
        manualYaml: devUserYamlSnippet(payload),
      },
      500,
    );
  }

  try {
    writeDevUser(localPath, payload);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return json<ErrorBody>(
      {
        ok: false,
        code: e.code === 'EACCES' || e.code === 'EPERM' ? 'write_failed' : 'parse_failed',
        message: `${e.message} (${e.code ?? 'unknown'})`,
        manualYaml: devUserYamlSnippet(payload),
      },
      500,
    );
  }

  return json({ ok: true } as const, 200);
}

// Round-trips through yaml's Document API so comments survive. Atomic via
// tempfile + rename — half-written YAML would crash next.config.mjs on restart.
function writeDevUser(localPath: string, payload: DevUserPayload): void {
  const raw = readFileSync(localPath, 'utf-8');
  const doc = parseDocument(raw);

  doc.setIn(['frontend', 'devUser', 'firstName'], payload.firstName);
  doc.setIn(['frontend', 'devUser', 'lastName'], payload.lastName);
  doc.setIn(['frontend', 'devUser', 'email'], payload.email);
  doc.setIn(['frontend', 'devUser', 'role'], payload.role);
  doc.setIn(['frontend', 'devUser', 'team'], payload.team);
  doc.setIn(['frontend', 'devUser', 'joinedAt'], payload.joinedAt);
  doc.setIn(['frontend', 'devUser', 'capabilities'], payload.capabilities);

  const next = String(doc);
  const tmp = join(dirname(localPath), `.${Date.now()}.shipit-local.tmp`);
  writeFileSync(tmp, next, 'utf-8');
  renameSync(tmp, localPath);
}

function json<T>(body: T, status: number): NextResponse {
  return NextResponse.json(body, { status });
}
