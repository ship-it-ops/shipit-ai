// Connector sync-schedule helpers for the UI.
//
// A connector's `schedule` is a 5-field crontab string fed to BullMQ as the
// repeatable-job pattern (see api-server SyncScheduler). The UI presents it as a
// small set of friendly presets plus a raw "custom cron" escape hatch, and warns
// — without blocking — when the cadence is frequent enough to strain the system.
//
// This is intentionally NOT a general cron parser: it only understands the
// handful of patterns our presets use plus the simple `*/N`-style forms a user
// is likely to type, which is all the interval estimate / warning needs. Anything
// it can't interpret is treated as a valid custom value with no warning.

export const CUSTOM = 'custom' as const;

export interface SchedulePreset {
  /** The crontab string sent to the API. */
  value: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** Interval in minutes (for ordering / reference). */
  minutes: number;
}

// Ordered fastest → slowest. The 15-min entry stays available but is not the
// default; 30 min is the default cadence.
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { value: '*/15 * * * *', label: 'Every 15 minutes', minutes: 15 },
  { value: '*/30 * * * *', label: 'Every 30 minutes', minutes: 30 },
  { value: '0 * * * *', label: 'Every hour', minutes: 60 },
  { value: '0 */6 * * *', label: 'Every 6 hours', minutes: 360 },
  { value: '0 0 * * *', label: 'Daily', minutes: 1440 },
];

/** Single source of truth for the UI's default schedule (matches the server default). */
export const DEFAULT_SCHEDULE = '*/30 * * * *';

/** Cadences more frequent than this (in minutes) get the "too frequent" warning. */
export const TOO_FREQUENT_BELOW_MINUTES = 15;

/** Concise, non-blocking warning copy shown for very frequent schedules. */
export const WARNING_TEXT =
  'Syncing this often is heavy on the system and can cause performance issues.';

/**
 * Best-effort interval estimate in minutes. Recognizes `*\/N * * * *` (every N
 * minutes), `0 *\/N * * *` (every N hours), and the exact preset strings.
 * Returns null for anything it can't confidently interpret — callers treat null
 * as "valid custom, no warning".
 */
export function cronToMinutes(cron: string): number | null {
  const trimmed = cron.trim();
  const preset = SCHEDULE_PRESETS.find((p) => p.value === trimmed);
  if (preset) return preset.minutes;

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  const restAllStar = dom === '*' && month === '*' && dow === '*';
  if (!restAllStar) return null;

  // every N minutes: "*/N * * * *"
  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep && hour === '*') {
    const n = Number(minuteStep[1]);
    return n > 0 ? n : null;
  }

  // every N hours: "0 */N * * *" (or any fixed minute)
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep && /^\d+$/.test(minute)) {
    const n = Number(hourStep[1]);
    return n > 0 ? n * 60 : null;
  }

  return null;
}

/** Returns the matching preset's value, or CUSTOM when the cron isn't a preset. */
export function matchPreset(cron: string): string {
  const trimmed = cron.trim();
  return SCHEDULE_PRESETS.some((p) => p.value === trimmed) ? trimmed : CUSTOM;
}

/** True when the schedule is interpretable AND more frequent than the threshold. */
export function isTooFrequent(cron: string): boolean {
  const minutes = cronToMinutes(cron);
  return minutes !== null && minutes < TOO_FREQUENT_BELOW_MINUTES;
}

/** Friendly label for a schedule — preset label when it matches, else the raw cron. */
export function scheduleLabel(cron: string): string {
  const trimmed = cron.trim();
  return SCHEDULE_PRESETS.find((p) => p.value === trimmed)?.label ?? trimmed;
}
