import { describe, it, expect } from 'vitest';
import { redactSegments, redactText } from '../redaction.js';

// Shapes secretlint's recommended preset flags BY DEFAULT: a GitHub token and a
// PEM block with a body of 100+ characters (the private-key rule's floor). An
// AWS access key id alone is not flagged unless the aws rule's enableIDScanRule
// is on, so it is not a fixture here. Built by concatenation so the repo's own
// secret scan (pre-commit hook and CI) does not trip on this file.
const GH_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const PEM = (kind: string) => `-----${kind} RSA ` + 'PRIVATE KEY-----';
const PRIVATE_KEY = `${PEM('BEGIN')}\n${'MIIBOgIBAAJBAK3vXyz'.repeat(8)}\n${PEM('END')}`;

describe('redactText', () => {
  it('leaves ordinary text alone', async () => {
    const out = await redactText('deploy went fine, payments-api is back at 14:02');
    expect(out).toEqual({ text: 'deploy went fine, payments-api is back at 14:02', count: 0 });
  });

  it('replaces a GitHub token and names the rule', async () => {
    const out = await redactText(`creds are ${GH_TOKEN} please rotate`);
    expect(out).toEqual({ text: 'creds are [redacted:github] please rotate', count: 1 });
  });

  it('replaces every match and counts them', async () => {
    const out = await redactText(`${GH_TOKEN}\n${PRIVATE_KEY}\n${GH_TOKEN}`);
    expect(out.count).toBe(3);
    expect(out.text).not.toContain(GH_TOKEN);
    expect(out.text).not.toContain(PEM('BEGIN'));
    expect(out.text).toBe('[redacted:github]\n[redacted:privatekey]\n[redacted:github]');
  });

  // secretlint's preset honours `secretlint-disable` comments. In our own
  // source tree that is a feature; in ingested content it would let whoever
  // wrote the text switch redaction off. Built by concatenation for the same
  // reason as the token.
  it('ignores secretlint directives found in the content', async () => {
    const directive = 'secretlint-' + 'disable';
    const out = await redactText(`# ${directive}\ntoken: ${GH_TOKEN}\n# secretlint-` + 'enable');
    expect(out.count).toBe(1);
    expect(out.text).not.toContain(GH_TOKEN);
    // The directive itself is content and stays as written.
    expect(out.text).toContain(directive);
  });

  it('ignores a next-line directive too', async () => {
    const out = await redactText('// secretlint-' + `disable-next-line\n${GH_TOKEN}`);
    expect(out.text).not.toContain(GH_TOKEN);
  });

  it('returns empty text unchanged without calling the linter', async () => {
    expect(await redactText('')).toEqual({ text: '', count: 0 });
  });
});

describe('redactSegments', () => {
  it('redacts each segment and sums the counts', async () => {
    const out = await redactSegments([
      { key: 'a', text: `one ${GH_TOKEN}` },
      { key: 'b', text: 'clean' },
      { key: 'c', text: `two ${GH_TOKEN}` },
    ]);
    expect(out.count).toBe(2);
    expect(out.segments.map((s) => s.key)).toEqual(['a', 'b', 'c']);
    expect(out.segments[1]!.text).toBe('clean');
    expect(out.segments[0]!.text).not.toContain(GH_TOKEN);
  });
});
