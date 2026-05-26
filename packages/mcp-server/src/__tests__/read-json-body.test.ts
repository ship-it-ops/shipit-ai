import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { readJsonBody } from '../index.js';

// `readJsonBody` only relies on two pieces of the IncomingMessage surface:
//   - async iteration over body chunks (`for await (const chunk of req)`)
//   - `req.destroy()` to abort on cap exceedance
// A minimal stand-in lets the test exercise both without spinning up a
// real http server.
function fakeRequest(chunks: Buffer[]): IncomingMessage & { _destroyed: boolean } {
  let destroyed = false;
  const req = {
    destroy(): IncomingMessage {
      destroyed = true;
      return req as unknown as IncomingMessage;
    },
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
    get _destroyed() {
      return destroyed;
    },
  };
  return req as unknown as IncomingMessage & { _destroyed: boolean };
}

describe('readJsonBody — body size cap', () => {
  it('parses an envelope well under the limit', async () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
    const result = await readJsonBody(fakeRequest([Buffer.from(payload, 'utf8')]), 1_000_000);
    expect(result).toEqual({ jsonrpc: '2.0', method: 'ping', id: 1 });
  });

  it('returns undefined for an empty body', async () => {
    const result = await readJsonBody(fakeRequest([]), 1_000_000);
    expect(result).toBeUndefined();
  });

  it('throws PAYLOAD_TOO_LARGE when a single chunk exceeds the cap', async () => {
    const oversized = Buffer.alloc(600_000, 0x61);
    const req = fakeRequest([oversized]);
    await expect(readJsonBody(req, 500_000)).rejects.toMatchObject({
      name: 'PayloadTooLargeError',
      statusCode: 413,
    });
    expect(req._destroyed).toBe(true);
  });

  it('throws when the cap is crossed across multiple chunks', async () => {
    const chunk = Buffer.alloc(400_000, 0x62);
    const req = fakeRequest([chunk, chunk, chunk]);
    await expect(readJsonBody(req, 1_000_000)).rejects.toMatchObject({
      name: 'PayloadTooLargeError',
      statusCode: 413,
    });
    expect(req._destroyed).toBe(true);
  });
});
