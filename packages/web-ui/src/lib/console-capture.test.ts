import { describe, it, expect, afterEach } from 'vitest';
import { installConsoleCapture, getRecentLogs, __resetConsoleCapture } from './console-capture';

describe('console-capture', () => {
  afterEach(() => __resetConsoleCapture());

  it('captures console.* output with its level', () => {
    installConsoleCapture();
    console.log('hello', 42);
    console.warn('careful');
    console.error('boom');
    const logs = getRecentLogs();
    expect(logs.find((l) => l.message.includes('hello'))?.level).toBe('log');
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('careful'))).toBe(true);
    expect(logs.some((l) => l.level === 'error' && l.message.includes('boom'))).toBe(true);
  });

  it('serializes object args without throwing', () => {
    installConsoleCapture();
    console.log('obj', { a: 1 });
    expect(getRecentLogs().some((l) => l.message.includes('"a":1'))).toBe(true);
  });

  it('caps the buffer at 100 entries (drops oldest)', () => {
    installConsoleCapture();
    for (let i = 0; i < 150; i++) console.log('m' + i);
    const logs = getRecentLogs();
    expect(logs.length).toBe(100);
    expect(logs[logs.length - 1].message).toBe('m149');
    expect(logs.some((l) => l.message === 'm0')).toBe(false);
  });

  it('captures window error and unhandledrejection events', () => {
    installConsoleCapture();
    window.dispatchEvent(new ErrorEvent('error', { message: 'kaboom' }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('nope');
    window.dispatchEvent(rejection);
    const logs = getRecentLogs();
    expect(logs.some((l) => l.message.includes('kaboom'))).toBe(true);
    expect(logs.some((l) => l.message.includes('nope'))).toBe(true);
  });

  it('is idempotent — a second install does not double-record', () => {
    installConsoleCapture();
    installConsoleCapture();
    console.log('once');
    expect(getRecentLogs().filter((l) => l.message === 'once')).toHaveLength(1);
  });
});
