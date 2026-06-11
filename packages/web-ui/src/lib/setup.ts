// First-run setup mode helpers. These talk to the api-server's sessionless
// setup surface (/api/health + /api/setup/*), so they use plain fetch
// rather than the fetchApi wrapper — a 401 here must NOT fire the global
// auth-required redirect (it would bounce the wizard to /login, which is
// unusable until setup finishes).
import { clientConfig } from './client-config';

export type HealthMode = 'setup' | 'active' | 'unreachable';

export interface SetupGates {
  oauthClientPresent: boolean;
  adminConfigured: boolean;
  sessionSecretPresent: boolean;
  allowedOriginsConfigured: boolean;
}

export interface SetupStatusResponse {
  mode: 'setup' | 'active';
  gates: SetupGates;
  ready: boolean;
}

// Detection is RUNTIME on purpose: the web-ui image is built once with
// auth enabled, so build-time NEXT_PUBLIC flags can't know whether the
// api-server is in setup mode.
export async function fetchHealthMode(): Promise<HealthMode> {
  try {
    const res = await fetch(`${clientConfig.api.url}/api/health`, { credentials: 'include' });
    if (!res.ok) return 'unreachable';
    const body = (await res.json()) as { mode?: string };
    return body.mode === 'setup' ? 'setup' : 'active';
  } catch {
    return 'unreachable';
  }
}

export async function fetchSetupStatus(): Promise<SetupStatusResponse> {
  const res = await fetch(`${clientConfig.api.url}/api/setup/status`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`GET /api/setup/status returned ${res.status}`);
  return (await res.json()) as SetupStatusResponse;
}

export async function postSetupAdmin(email: string): Promise<void> {
  const res = await fetch(`${clientConfig.api.url}/api/setup/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `POST /api/setup/admin returned ${res.status}`);
  }
}

export type SetupCompleteResult =
  | { ok: true }
  | { ok: false; missing: string[]; messages: string[] };

export async function postSetupComplete(): Promise<SetupCompleteResult> {
  const res = await fetch(`${clientConfig.api.url}/api/setup/complete`, {
    method: 'POST',
    credentials: 'include',
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as {
    error?: { missing?: string[]; messages?: string[]; message?: string };
  } | null;
  if (res.status === 409 && body?.error?.missing) {
    return { ok: false, missing: body.error.missing, messages: body.error.messages ?? [] };
  }
  throw new Error(body?.error?.message ?? `POST /api/setup/complete returned ${res.status}`);
}
