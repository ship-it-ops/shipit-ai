export interface DevUserPayload {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  team: string;
  joinedAt: string;
  capabilities: string[];
}

export interface ValidationError {
  field: string;
  message: string;
}

const STRING_FIELDS: Array<keyof Omit<DevUserPayload, 'capabilities'>> = [
  'firstName',
  'lastName',
  'email',
  'role',
  'team',
  'joinedAt',
];

// Excluding `.` from the middle segment removes the polynomial-backtracking
// ambiguity flagged by CodeQL: when the literal `\.` appears, there's only one
// way to split the input across the two domain groups. Multi-dot TLDs like
// `co.uk` still match through the trailing `[^\s@]+`.
//
// Exported so the dialog's canAdvance gate uses the same pattern — keeping
// validation in lockstep on both sides of the network boundary.
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDevUser(body: unknown):
  | {
      ok: true;
      value: DevUserPayload;
    }
  | {
      ok: false;
      errors: ValidationError[];
    } {
  const errors: ValidationError[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: '(root)', message: 'Body must be a JSON object' }] };
  }
  const b = body as Record<string, unknown>;
  const out: Partial<DevUserPayload> = {};

  for (const field of STRING_FIELDS) {
    const value = b[field];
    if (typeof value !== 'string') {
      errors.push({ field, message: `${field} is required` });
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      errors.push({ field, message: `${field} cannot be empty` });
      continue;
    }
    out[field] = trimmed;
  }

  if (out.email && !EMAIL_RE.test(out.email)) {
    errors.push({ field: 'email', message: 'email must look like an address' });
  }
  if (out.joinedAt && !DATE_RE.test(out.joinedAt)) {
    errors.push({ field: 'joinedAt', message: 'joinedAt must be YYYY-MM-DD' });
  }

  const capsRaw = b.capabilities;
  if (!Array.isArray(capsRaw)) {
    errors.push({ field: 'capabilities', message: 'capabilities must be an array of strings' });
  } else {
    const caps: string[] = [];
    for (let i = 0; i < capsRaw.length; i++) {
      const c = capsRaw[i];
      if (typeof c !== 'string' || c.trim() === '') {
        errors.push({
          field: `capabilities[${i}]`,
          message: 'capabilities entries must be non-empty strings',
        });
      } else {
        caps.push(c.trim());
      }
    }
    out.capabilities = caps;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out as DevUserPayload };
}

// YAML snippet for the manual-paste fallback. Indented under `frontend.devUser:`
// the way it appears in shipit.config.local.example.yaml.
export function devUserYamlSnippet(p: DevUserPayload): string {
  const caps = p.capabilities.map((c) => `      - ${c}`).join('\n');
  return [
    'frontend:',
    '  devUser:',
    `    firstName: ${p.firstName}`,
    `    lastName: ${p.lastName}`,
    `    email: ${p.email}`,
    `    role: ${p.role}`,
    `    team: ${p.team}`,
    `    joinedAt: ${p.joinedAt}`,
    '    capabilities:',
    caps,
    '',
  ].join('\n');
}
