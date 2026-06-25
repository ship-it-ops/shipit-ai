// Bounded ring buffer of recent console output + uncaught errors, captured so
// the "Report a problem" widget can attach diagnostics to a filed issue.
//
// The app has no global logger or error boundary, so this is the only capture
// surface. Install once (idempotent); the buffer is module-level, so it
// survives client-side route changes and accumulates across the session.

export interface CapturedLog {
  level: string;
  message: string;
  ts: number;
}

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];

const MAX_ENTRIES = 100;
const MAX_MESSAGE = 2000;
const buffer: CapturedLog[] = [];
let installed = false;
const originals: Partial<Record<Level, (...args: unknown[]) => void>> = {};

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function push(level: string, args: unknown[]): void {
  const message = args.map(safeStringify).join(' ').slice(0, MAX_MESSAGE);
  buffer.push({ level, message, ts: Date.now() });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

// Wrap console.* (preserving the originals) and listen for uncaught errors +
// unhandled rejections. No-op on the server and on a second call.
export function installConsoleCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    originals[level] = original;
    console[level] = (...args: unknown[]) => {
      push(level, args);
      original(...args);
    };
  }

  window.addEventListener('error', (e) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
    push('error', [`${e.message}${where}`]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    push('error', ['Unhandled promise rejection:', safeStringify(e.reason)]);
  });
}

export function getRecentLogs(): CapturedLog[] {
  return buffer.slice();
}

// Test-only: restore the original console methods + clear the buffer so a
// subsequent install doesn't double-wrap.
export function __resetConsoleCapture(): void {
  for (const level of LEVELS) {
    const original = originals[level];
    if (original) console[level] = original as (typeof console)[Level];
    delete originals[level];
  }
  buffer.length = 0;
  installed = false;
}
