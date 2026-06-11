import { describe, it, expect } from 'vitest';
import {
  GSM_CONTAINER_DEFAULTS,
  ENV_VAR_FOR,
  WRITABLE_SECRETS,
  SecretWriteForbiddenError,
  assertWritable,
  gsmContainerFor,
} from '../../secrets/types.js';

describe('secret taxonomy', () => {
  it('maps every logical secret to its Terraform container name', () => {
    expect(GSM_CONTAINER_DEFAULTS).toEqual({
      'github-app-private-key': 'shipit-github-app-private-key',
      'github-webhook-secret': 'shipit-github-webhook-secret',
      'github-oauth-client-secret': 'shipit-github-oauth-client-secret',
      'oidc-client-secret': 'shipit-oidc-client-secret',
      'github-app-id': 'shipit-github-app-id',
      'github-oauth-client-id': 'shipit-github-oauth-client-id',
      'auth-admin-emails': 'shipit-auth-admin-emails',
      'neo4j-aura-password': 'shipit-neo4j-aura-password',
      'session-secret': 'shipit-session-secret',
    });
  });

  it('maps env-consumed secrets to their env var names (PEM has none — it is a file)', () => {
    expect(ENV_VAR_FOR['github-webhook-secret']).toBe('GITHUB_WEBHOOK_SECRET');
    expect(ENV_VAR_FOR['github-oauth-client-secret']).toBe('GITHUB_OAUTH_CLIENT_SECRET');
    expect(ENV_VAR_FOR['oidc-client-secret']).toBe('OIDC_CLIENT_SECRET');
    expect(ENV_VAR_FOR['github-app-id']).toBe('GITHUB_APP_ID');
    expect(ENV_VAR_FOR['github-oauth-client-id']).toBe('GITHUB_OAUTH_CLIENT_ID');
    expect(ENV_VAR_FOR['auth-admin-emails']).toBe('SHIPIT_AUTH_ADMINS');
    expect(ENV_VAR_FOR['neo4j-aura-password']).toBe('NEO4J_PASSWORD');
    expect(ENV_VAR_FOR['session-secret']).toBe('SHIPIT_SESSION_SECRET');
    expect(ENV_VAR_FOR['github-app-private-key']).toBeUndefined();
  });

  it('refuses writes to bootstrap secrets, allows feature + public-ID writes', () => {
    expect(() => assertWritable('neo4j-aura-password')).toThrow(SecretWriteForbiddenError);
    expect(() => assertWritable('session-secret')).toThrow(SecretWriteForbiddenError);
    expect(WRITABLE_SECRETS.has('github-app-private-key')).toBe(true);
    expect(() => assertWritable('github-app-id')).not.toThrow();
    expect(() => assertWritable('oidc-client-secret')).not.toThrow();
    // The setup wizard writes the first admin email here.
    expect(() => assertWritable('auth-admin-emails')).not.toThrow();
  });

  it('resolves container names from hard-mapped defaults with per-secret env override', () => {
    expect(gsmContainerFor('github-app-private-key', {} as NodeJS.ProcessEnv)).toBe(
      'shipit-github-app-private-key',
    );
    expect(
      gsmContainerFor('github-app-private-key', {
        SHIPIT_GSM_SECRET_GITHUB_APP_PRIVATE_KEY: 'custom-name',
      } as NodeJS.ProcessEnv),
    ).toBe('custom-name');
    expect(
      gsmContainerFor('github-app-private-key', {
        SHIPIT_GSM_SECRET_GITHUB_APP_PRIVATE_KEY: '   ',
      } as NodeJS.ProcessEnv),
    ).toBe('shipit-github-app-private-key');
  });
});
