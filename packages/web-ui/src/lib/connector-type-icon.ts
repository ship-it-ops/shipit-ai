import { iconData } from '@ship-it-ui/icons';

export type ConnectorTypeIcon = { name: string; kind: 'logo' | 'default' };

// Which icon set to draw a connector type from. `DynamicIconGlyph kind="logo"`
// resolves `logo:<type>` and otherwise draws the literal name as text — fine
// for GitHub, which the DS ships as `logo:github`, but the Kubernetes mark only
// exists as the plain `kubernetes` glyph, so the card rendered "rn". Prefer the
// logo when the DS has one and fall back to a same-named glyph; an unknown type
// keeps asking for a logo so the text fallback still names it.
export function connectorTypeIcon(type: string): ConnectorTypeIcon {
  if (iconData[`logo:${type}`]) return { name: type, kind: 'logo' };
  if (iconData[type]) return { name: type, kind: 'default' };
  return { name: type, kind: 'logo' };
}
