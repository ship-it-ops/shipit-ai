import { describe, it, expect } from 'vitest';
import { iconData } from '@ship-it-ui/icons';
import { connectorTypeIcon } from './connector-type-icon';

describe('connectorTypeIcon', () => {
  it('uses the logo set when the design system ships a logo for the type', () => {
    expect(iconData['logo:github']).toBeDefined();
    expect(connectorTypeIcon('github')).toEqual({ name: 'github', kind: 'logo' });
  });

  // The DS has the Kubernetes mark only as a plain glyph. Asking for
  // kind="logo" makes DynamicIconGlyph draw the literal word instead, which
  // clipped to "rn" on the connector card.
  it('falls back to the plain glyph when there is no logo but a glyph exists', () => {
    expect(iconData['logo:kubernetes']).toBeUndefined();
    expect(iconData['kubernetes']).toBeDefined();
    expect(connectorTypeIcon('kubernetes')).toEqual({ name: 'kubernetes', kind: 'default' });
  });

  it('still asks for a logo for an unknown type so the text fallback is at least attempted', () => {
    expect(connectorTypeIcon('nonexistent-type')).toEqual({
      name: 'nonexistent-type',
      kind: 'logo',
    });
  });
});
