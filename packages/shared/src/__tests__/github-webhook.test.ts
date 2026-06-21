import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyGitHubWebhookSignature } from '../auth/github-webhook.js';

const SECRET = 'super-secret-webhook-key';
const PAYLOAD = Buffer.from(JSON.stringify({ action: 'opened', number: 42 }));

/** Produce the header GitHub would send for a given body + secret. */
function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGitHubWebhookSignature', () => {
  it('accepts a valid signature', () => {
    const header = sign(PAYLOAD, SECRET);
    expect(verifyGitHubWebhookSignature(PAYLOAD, header, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = sign(PAYLOAD, SECRET);
    const tampered = Buffer.from(JSON.stringify({ action: 'closed', number: 42 }));
    expect(verifyGitHubWebhookSignature(tampered, header, SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const header = sign(PAYLOAD, 'a-different-secret');
    expect(verifyGitHubWebhookSignature(PAYLOAD, header, SECRET)).toBe(false);
  });

  it('rejects a missing/undefined header', () => {
    expect(verifyGitHubWebhookSignature(PAYLOAD, undefined, SECRET)).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(verifyGitHubWebhookSignature(PAYLOAD, '', SECRET)).toBe(false);
  });

  it('rejects a malformed header without the sha256= prefix', () => {
    const bareHex = createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');
    expect(verifyGitHubWebhookSignature(PAYLOAD, bareHex, SECRET)).toBe(false);
  });

  it('rejects the legacy sha1 header format', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(PAYLOAD).digest('hex')}`;
    expect(verifyGitHubWebhookSignature(PAYLOAD, sha1, SECRET)).toBe(false);
  });

  it('rejects an empty secret', () => {
    const header = sign(PAYLOAD, '');
    expect(verifyGitHubWebhookSignature(PAYLOAD, header, '')).toBe(false);
  });

  it('rejects a whitespace-only secret', () => {
    // Even if a header were computed with the literal whitespace key, a
    // whitespace-only secret trims to empty and must fail closed.
    const header = sign(PAYLOAD, '   ');
    expect(verifyGitHubWebhookSignature(PAYLOAD, header, '   \n\t ')).toBe(false);
  });

  it('verifies when the secret has surrounding whitespace, against a trimmed-secret signature', () => {
    // The signature is computed with the trimmed secret (as GitHub would),
    // but the caller supplies the secret with a trailing newline (as read
    // from a sidecar file). Trimming must reconcile the two.
    const header = sign(PAYLOAD, SECRET);
    expect(verifyGitHubWebhookSignature(PAYLOAD, header, `  ${SECRET}\n`)).toBe(true);
  });

  it('handles an empty raw body without throwing', () => {
    const empty = Buffer.alloc(0);
    const header = sign(empty, SECRET);
    expect(verifyGitHubWebhookSignature(empty, header, SECRET)).toBe(true);
    expect(verifyGitHubWebhookSignature(empty, sign(empty, 'wrong'), SECRET)).toBe(false);
  });
});
