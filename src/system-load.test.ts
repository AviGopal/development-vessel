import { describe, expect, test } from 'bun:test';
import { isSaturated, loadAverage1m, SATURATION_MULTIPLE } from './system-load';

describe('isSaturated', () => {
  test('the measured incident saturates: load 47 on 14 CPUs', () => {
    // 2026-08-30 on substrate-live — ~29 concurrent suites, load 41-57 for over half an hour.
    expect(isSaturated(47, 14)).toBe(true);
  });

  test('ordinary oversubscription does NOT saturate — suites still finish there', () => {
    // 1-2x is normal for a busy box. Deferring here would starve self-development, which is a
    // worse failure than the load: law 6, do not rob the substrate's self-maintenance.
    expect(isSaturated(14, 14)).toBe(false);
    expect(isSaturated(28, 14)).toBe(false);
    expect(isSaturated(41.9, 14)).toBe(false);
  });

  test('the boundary is exclusive at exactly the multiple', () => {
    expect(isSaturated(42, 14)).toBe(false);
    expect(isSaturated(42.1, 14)).toBe(true);
  });

  test.each([
    [null, 'loadavg unreadable'],
    [NaN, 'loadavg not a number'],
  ])('FAILS OPEN when load is %p (%s)', (load) => {
    // A guard that wrongly reports saturation halts mitosis evaluation entirely. It may only ever
    // skip work on positive evidence.
    expect(isSaturated(load as number | null, 14)).toBe(false);
  });

  test.each([
    [0, 'zero CPUs'],
    [-1, 'negative CPUs'],
    [NaN, 'CPU count not a number'],
  ])('FAILS OPEN when cpuCount is %p (%s)', (cpuCount) => {
    expect(isSaturated(999, cpuCount as number)).toBe(false);
  });

  test('an idle box never defers', () => {
    expect(isSaturated(0, 14)).toBe(false);
    expect(isSaturated(0.5, 1)).toBe(false);
  });

  test('threshold is the conservative 3x, not something tighter', () => {
    expect(SATURATION_MULTIPLE).toBe(3);
  });
});

describe('loadAverage1m', () => {
  test('parses the first field of /proc/loadavg', () => {
    expect(loadAverage1m(() => '47.63 45.44 45.34 12/1218 49154\n')).toBe(47.63);
  });

  test('returns null rather than throwing when /proc/loadavg is unavailable', () => {
    expect(loadAverage1m(() => { throw new Error('ENOENT'); })).toBeNull();
  });

  test('returns null on unparseable content', () => {
    expect(loadAverage1m(() => 'not-a-number rest')).toBeNull();
  });

  test('reads the real /proc/loadavg without throwing on this host', () => {
    const v = loadAverage1m();
    expect(v === null || (typeof v === 'number' && v >= 0)).toBe(true);
  });
});
