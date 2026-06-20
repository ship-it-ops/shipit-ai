import { describe, it, expect } from 'vitest';
import {
  CUSTOM,
  DEFAULT_SCHEDULE,
  SCHEDULE_PRESETS,
  cronToMinutes,
  isTooFrequent,
  matchPreset,
  scheduleLabel,
} from './schedule';

describe('schedule helpers', () => {
  it('defaults to every 30 minutes', () => {
    expect(DEFAULT_SCHEDULE).toBe('*/30 * * * *');
    expect(matchPreset(DEFAULT_SCHEDULE)).toBe('*/30 * * * *');
  });

  describe('cronToMinutes', () => {
    it('maps preset strings to their minutes', () => {
      for (const p of SCHEDULE_PRESETS) {
        expect(cronToMinutes(p.value)).toBe(p.minutes);
      }
    });

    it('parses arbitrary minute-step patterns', () => {
      expect(cronToMinutes('*/5 * * * *')).toBe(5);
      expect(cronToMinutes('*/10 * * * *')).toBe(10);
    });

    it('parses hour-step patterns', () => {
      expect(cronToMinutes('0 */2 * * *')).toBe(120);
    });

    it('tolerates surrounding whitespace', () => {
      expect(cronToMinutes('  */30 * * * *  ')).toBe(30);
    });

    it('returns null for uninterpretable / non-5-field strings', () => {
      expect(cronToMinutes('not a cron')).toBeNull();
      expect(cronToMinutes('*/5 * * *')).toBeNull();
      expect(cronToMinutes('15,45 * * * *')).toBeNull(); // valid cron but not a simple interval
      expect(cronToMinutes('*/0 * * * *')).toBeNull();
    });
  });

  describe('isTooFrequent', () => {
    it('flags cadences faster than 15 minutes', () => {
      expect(isTooFrequent('*/5 * * * *')).toBe(true);
      expect(isTooFrequent('*/10 * * * *')).toBe(true);
      expect(isTooFrequent('*/1 * * * *')).toBe(true);
    });

    it('does not flag 15 minutes or slower', () => {
      expect(isTooFrequent('*/15 * * * *')).toBe(false);
      expect(isTooFrequent('*/30 * * * *')).toBe(false);
      expect(isTooFrequent('0 * * * *')).toBe(false);
    });

    it('does not flag custom / unparseable schedules', () => {
      expect(isTooFrequent('15,45 * * * *')).toBe(false);
      expect(isTooFrequent('garbage')).toBe(false);
    });
  });

  describe('matchPreset', () => {
    it('returns the preset value for known schedules', () => {
      expect(matchPreset('0 * * * *')).toBe('0 * * * *');
    });
    it('returns CUSTOM for anything else', () => {
      expect(matchPreset('*/5 * * * *')).toBe(CUSTOM);
      expect(matchPreset('15,45 * * * *')).toBe(CUSTOM);
    });
  });

  describe('scheduleLabel', () => {
    it('uses the preset label when matched', () => {
      expect(scheduleLabel('*/30 * * * *')).toBe('Every 30 minutes');
    });
    it('falls back to the raw cron for custom', () => {
      expect(scheduleLabel('15,45 * * * *')).toBe('15,45 * * * *');
    });
  });
});
