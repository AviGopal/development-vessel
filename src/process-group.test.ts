import { describe, expect, test } from 'bun:test';
import { groupLeaderArgv, killProcessGroup } from './process-group';

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('killProcessGroup', () => {
  // THE REGRESSION THIS PINS. runCheck's timeout called proc.kill(), which signals only the
  // direct child, so every worker `bun test` forked survived as an orphan. This test reproduces
  // that shape — a parent that forks a long-lived grandchild — and asserts the GRANDCHILD dies.
  test('kills a grandchild that a single-pid kill would orphan', async () => {
    const proc = Bun.spawn(groupLeaderArgv('bash', ['-c', 'sleep 120 & echo $!; wait']), {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // The parent prints its forked child's pid, then waits.
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const grandchild = Number(new TextDecoder().decode(value).trim().split('\n')[0]);
    reader.releaseLock();

    expect(Number.isInteger(grandchild)).toBe(true);
    expect(alive(grandchild)).toBe(true);

    // POSITIVE CONTROL: killing only the direct child must leave the grandchild alive. Without
    // this, the test could pass on a system where the grandchild died for unrelated reasons.
    proc.kill();
    await sleep(300);
    expect(alive(grandchild)).toBe(true);

    // Now the group kill — the behaviour under test.
    expect(killProcessGroup(proc.pid)).toBe(true);
    await sleep(300);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  test('refuses pid 0 and negatives — kill(-0) would signal our OWN group', () => {
    // The catastrophic case: -0 is the caller's process group, so a degenerate pid would take
    // the whole vessel down instead of the timed-out check.
    let fellBack = 0;
    for (const bad of [0, -1, 1, 1.5, NaN]) {
      expect(killProcessGroup(bad, () => { fellBack++; })).toBe(false);
    }
    expect(fellBack).toBe(5);
  });

  test('falls back and never throws when the group is already gone', () => {
    let fellBack = false;
    // A pid far above any live process: the group cannot exist, so this must fall back quietly.
    expect(killProcessGroup(4_000_000_00, () => { fellBack = true; })).toBe(false);
    expect(fellBack).toBe(true);
  });

  test('a throwing fallback is swallowed — this runs inside setTimeout', () => {
    expect(() => killProcessGroup(0, () => { throw new Error('boom'); })).not.toThrow();
  });
});

describe('groupLeaderArgv', () => {
  test('prefixes setsid, preserving command and args', () => {
    expect(groupLeaderArgv('bun', ['test'])).toEqual(['/usr/bin/setsid', 'bun', 'test']);
  });

  test('degrades to the bare argv when setsid is absent', () => {
    // Prefixing unconditionally would ENOENT every spawn on a host without util-linux, turning a
    // process leak into a dead mitosis evaluator. Leaking is recoverable; not running is not.
    expect(groupLeaderArgv('bun', ['test'], '/nonexistent/setsid')).toEqual(['bun', 'test']);
  });
});
