import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { chicagoMs } from '../e2e/fakeProxyData';
import { RUNS, shiftTo } from '../scripts/e2e-time-of-day';

// scripts/e2e-time-of-day.ts (issue #213): the clock moves forward to the
// next time the Chicago wall clock shows the target, never back.
describe('shiftTo', () => {
  it('moves forward to the same day when the time is still ahead', () => {
    const now = chicagoMs('2026-10-05', '20:39:30');
    expect(shiftTo('23:50', now)).toBe(chicagoMs('2026-10-05', '23:50:00') - now);
  });
  it('moves forward to the next day when the time has passed', () => {
    const now = chicagoMs('2026-10-05', '20:39:30');
    expect(shiftTo('00:30', now)).toBe(chicagoMs('2026-10-06', '00:30:00') - now);
    expect(shiftTo('20:30', now)).toBe(chicagoMs('2026-10-06', '20:30:00') - now);
  });
  it('keeps the wall-clock time across the end of DST (a 25-hour day)', () => {
    const now = chicagoMs('2026-10-31', '12:00:00');
    expect(now + shiftTo('06:00', now)).toBe(chicagoMs('2026-11-01', '06:00:00'));
  });
  it('is never negative and stays within a day', () => {
    for (const { at } of RUNS) {
      const s = shiftTo(at);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(25 * 3_600_000);
    }
  });
});

// e2e/clockShift.cjs: what NODE_OPTIONS loads into every process of a run.
describe('clockShift.cjs', () => {
  const run = (shift: string) =>
    JSON.parse(execFileSync(process.execPath, ['--require', resolve(__dirname, '../e2e/clockShift.cjs'), '-e', `
      const real = performance.timeOrigin + performance.now();
      console.log(JSON.stringify({
        now: Date.now() - real, bare: new Date().getTime() - real, fixed: new Date(0).getTime(),
        parts: new Date(2026, 0, 2, 3).getHours(), inst: new Date() instanceof Date, str: typeof Date(),
        parse: Date.parse('2026-01-01T00:00:00Z'), utc: Date.UTC(2026, 0, 1),
      }));`], { env: { ...process.env, E2E_CLOCK_SHIFT_MS: shift } }).toString());
  it('moves now (Date.now() and new Date()) and nothing else', () => {
    const r = run('7200000');
    expect(r.now).toBeGreaterThan(7_199_000);
    expect(r.now).toBeLessThan(7_201_000);
    expect(r.bare).toBeGreaterThan(7_199_000);
    expect(r.bare).toBeLessThan(7_201_000);
    expect(r).toMatchObject({ fixed: 0, parts: 3, inst: true, str: 'string', parse: 1767225600000, utc: 1767225600000 });
  });
  it('leaves Date alone without a shift', () => {
    const r = run('');
    expect(Math.abs(r.now)).toBeLessThan(1000);
  });
});
