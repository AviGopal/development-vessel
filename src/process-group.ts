import { existsSync } from 'node:fs';

/**
 * Process-group spawn/kill helpers.
 *
 * WHY THIS EXISTS. A timeout that kills only the direct child leaks every process that child
 * spawned. `Bun.spawn(...).kill()` signals exactly one pid, so killing `bun` leaves the workers
 * `bun test` forked running — reparented to init, with no parent and no timer, forever.
 *
 * Measured on substrate-live 2026-08-30: loadavg 57.5 holding above 45, with 29-47 orphaned
 * `bun test` processes (all `ppid=1`, cwd `/workspace/git/vessels/development-vessel`, ages 0-4
 * minutes and continuously replenished) while `substrate-pull-sync` was `inactive` — so nothing
 * was waiting on any of them. A 10-second CPU delta showed seven of them at ~100% of a core each,
 * alongside SurrealDB at 437%. That saturation is what made vessel `/health` take 9.5s, gap writes
 * time out, and walks die on `HTTP 500 fetch failed: The operation was aborted`.
 *
 * This defect was already found, fixed and documented ONE VESSEL OVER:
 * `repos/local-tools-vessel/src/index.ts` `groupBounded()` — "killing bash orphans them, and they
 * keep running with no parent and no timer… a 10-second bound produced a `find /` still alive
 * after 5.5 HOURS". That fix was never propagated to this spawn site. When you fix a leak like
 * this, grep for the sibling spawn sites.
 *
 * The mechanism: `setsid` puts the program in a NEW SESSION, making it a process-group leader, so
 * its pgid equals its pid. `kill(-pid)` then signals the entire group — the program and everything
 * it forked. `setsid` execs in place when it is not already a group leader (which a `Bun.spawn`
 * child never is), so the pid we hold really is the group leader and no extra process intervenes.
 */

/**
 * Wrap an argv so the spawned program leads its own process group.
 *
 * Returns the original argv unchanged when no `setsid` is available, so callers degrade to
 * present-day behaviour (leaky, but working) rather than failing to spawn at all.
 */
export function groupLeaderArgv(cmd: string, args: string[], setsidPath = '/usr/bin/setsid'): string[] {
  // Degrade to the bare argv when setsid is missing. Prefixing unconditionally would make every
  // spawn fail with ENOENT on a host without util-linux — trading a process leak for a total
  // outage of mitosis evaluation. A leak is recoverable; a dead evaluator is not.
  try {
    if (!existsSync(setsidPath)) return [cmd, ...args];
  } catch {
    return [cmd, ...args];
  }
  return [setsidPath, cmd, ...args];
}

/**
 * Kill the entire process group led by `pid`.
 *
 * Returns true when the group signal was delivered. On failure — most often ESRCH because the
 * group already exited, or EPERM — it invokes `fallback` (normally the caller's single-process
 * `proc.kill()`) so a timeout still terminates *something*. Never throws: this runs inside a
 * setTimeout, where an exception would be unhandled.
 */
export function killProcessGroup(pid: number, fallback?: () => void): boolean {
  // A negative pid addresses the group. Guard the degenerate values explicitly: kill(-0) would
  // signal the CALLER'S OWN group and take the vessel down with it.
  if (!Number.isInteger(pid) || pid <= 1) {
    try { fallback?.(); } catch { /* noop */ }
    return false;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try { fallback?.(); } catch { /* noop */ }
    return false;
  }
}
