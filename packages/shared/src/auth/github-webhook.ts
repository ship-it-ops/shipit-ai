// GitHub webhook HMAC signature verification, shared so the api-server's
// webhook receiver and any other consumer validate deliveries the same way.
//
// GitHub signs each webhook delivery with an HMAC-SHA256 of the raw request
// body, keyed by the per-hook shared secret, and sends it in the
// `x-hub-signature-256` header as `sha256=<hex>`. Verifying that signature is
// the only thing that proves a delivery actually came from GitHub, so this
// lives next to the other security-critical crypto primitives and reuses the
// same length-safe constant-time compare.

import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './token-crypto.js';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verify a GitHub webhook's `x-hub-signature-256` header against the raw body.
 *
 * Fails closed (returns false, never throws) for every invalid case: a
 * missing/empty header, a header that is not in `sha256=<hex>` form, an empty
 * secret, or a digest that does not match. The legacy sha1 `x-hub-signature`
 * format is intentionally unsupported — pass the sha256 header value only.
 *
 * The secret is trimmed before use: it is typically read from a sidecar file
 * written with a trailing newline, and an untrimmed secret would key the HMAC
 * differently from GitHub and reject every otherwise-valid delivery.
 *
 * @param rawBody the exact request body bytes GitHub signed (not re-serialized JSON)
 * @param signatureHeader the value of the `x-hub-signature-256` header, if present
 * @param secret the shared webhook secret (trailing/leading whitespace is ignored)
 */
export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const trimmedSecret = secret.trim();
  if (trimmedSecret.length === 0) {
    return false;
  }

  const digest = createHmac('sha256', trimmedSecret).update(rawBody).digest('hex');
  const expected = `${SIGNATURE_PREFIX}${digest}`;

  return constantTimeEqual(expected, signatureHeader);
}
