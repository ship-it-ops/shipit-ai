import { describe, it, expect } from 'vitest';
import { SetupService, InvalidAdminEmailError } from '../../services/setup-service.js';
import type { LogicalSecret, SecretStore } from '../../secrets/types.js';

function fakeStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: 'gsm',
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name: LogicalSecret, value: string) => {
      values.set(name, value);
    },
  };
}

describe('SetupService.setAdminEmails (CSV-aware)', () => {
  it('trims, drops blanks, joins as CSV, writes the secret + env', async () => {
    const env: NodeJS.ProcessEnv = {};
    const store = fakeStore();
    const svc = new SetupService({ secretStore: store, env });

    await svc.setAdminEmails([' a@example.com ', 'b@example.com', '']);

    expect(store.values.get('auth-admin-emails')).toBe('a@example.com,b@example.com');
    expect(env.SHIPIT_AUTH_ADMINS).toBe('a@example.com,b@example.com');
  });

  it('throws InvalidAdminEmailError on any invalid email', async () => {
    const svc = new SetupService({ secretStore: fakeStore(), env: {} });
    await expect(svc.setAdminEmails(['ok@example.com', 'nope'])).rejects.toBeInstanceOf(
      InvalidAdminEmailError,
    );
  });

  it('throws InvalidAdminEmailError on an empty list', async () => {
    const svc = new SetupService({ secretStore: fakeStore(), env: {} });
    await expect(svc.setAdminEmails([])).rejects.toBeInstanceOf(InvalidAdminEmailError);
    await expect(svc.setAdminEmails(['  '])).rejects.toBeInstanceOf(InvalidAdminEmailError);
  });
});
