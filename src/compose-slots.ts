/**
 * A CROSS-PROCESS capacity bound for compose.
 *
 * An in-process counter cannot bound this fleet: composes are launched from at
 * least two processes — the development-vessel HTTP surface (goal-host's
 * edit-intent route, auto-draft) and `gap-compose.service`, which is a separate
 * `bun scripts/substrate/gap-compose-tick.ts` invocation with its own memory. A
 * counter in one is invisible to the other, so the first version of this cap
 * bounded only half the traffic.
 *
 * Measured before any cap: 27 concurrent typecheck/test processes at load 50.8
 * on 14 CPUs.
 *
 * The mechanism is deliberately the one this codebase already uses for exactly
 * this shape of problem — a directory of marker files, reaped by mtime, as in
 * `/workspace/authoring-inflight`. Reusing a proven pattern beats inventing a
 * lock, and it survives a process restart: a slot whose holder died is reclaimed
 * by staleness rather than leaking forever.
 *
 * FAILS OPEN. If the directory cannot be read or written, `acquire` returns a
 * releasable handle anyway. A capacity cap that cannot see the filesystem must
 * slow the fleet, never halt it — the cost of admitting one compose too many is
 * load, and the cost of refusing every compose is a substrate that cannot
 * develop itself.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";

const SLOT_DIR = process.env["COMPOSE_SLOT_DIR"] ?? "/workspace/compose-slots";

/**
 * How long a slot may be held before it is presumed abandoned.
 *
 * A compose runs 5-8 minutes; the ceiling its caller allows is 15. 20 minutes is
 * comfortably past any live run, so reaping cannot steal a slot from working
 * code — while still guaranteeing a crashed holder frees its slot rather than
 * wedging the fleet until an operator intervenes.
 */
const SLOT_STALE_MS = Number(process.env["COMPOSE_SLOT_STALE_MS"] ?? 20 * 60_000);

export interface ComposeSlot {
  readonly granted: boolean;
  /** In-flight count observed at decision time, for honest logging. */
  readonly observed: number;
  release(): Promise<void>;
}

function capFromEnv(): number {
  // `Math.max(1, Number("typo"))` is NaN, and `n >= NaN` is ALWAYS FALSE — a
  // mistyped env var would silently disable the cap while the code still looks
  // like it has one. Any invalid value falls back to the default, never to
  // "unlimited": a wrong cap must make the fleet slow, never the host unusable.
  const raw = Number(process.env["COMPOSE_MAX_CONCURRENT"] ?? 2);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

/** Count live slots, deleting any that are stale. Returns the live count. */
async function countLive(now: number): Promise<number> {
  let live = 0;
  const names = await readdir(SLOT_DIR);
  for (const name of names) {
    if (!name.endsWith(".slot")) continue;
    const path = `${SLOT_DIR}/${name}`;
    try {
      const st = await stat(path);
      if (now - st.mtimeMs > SLOT_STALE_MS) {
        // Reap rather than leave it to an operator: a crashed compose must not
        // hold capacity forever.
        await unlink(path).catch(() => {});
        continue;
      }
      live++;
    } catch {
      // Vanished mid-scan — that is a released slot, not a live one.
    }
  }
  return live;
}

/**
 * Try to take a compose slot.
 *
 * Not atomic across processes, and deliberately so: the alternative is a real
 * lock, whose failure mode is a wedged fleet when a holder dies. A count-then-
 * write race can admit one extra compose under simultaneous arrival, which costs
 * some load; a stuck lock costs all self-development. The cap is a resource
 * guardrail, not a correctness invariant — correctness is the per-vessel busy-set
 * and the cutover lease, both of which remain.
 */
export async function acquireComposeSlot(
  composeId: string,
  opts: { directed?: boolean } = {},
): Promise<ComposeSlot> {
  const cap = capFromEnv();
  // RESERVE THE LAST SLOT FOR DIRECTED WORK.
  //
  // A capacity cap alone converts "a directed goal waits behind the boredom
  // stream" into "a directed goal is REFUSED" — measured immediately after the
  // cap landed: an operator dispatch that had routed correctly came back
  // "compose capacity cap reached (2 in flight)" while both slots held
  // self-generated gap work.
  //
  // Autonomous work may therefore fill at most cap-1 slots; a directed compose
  // may use the full cap. Someone asked for the directed one, and the gap lane's
  // work is not lost by waiting — its gap stays open and retries. At the default
  // cap of 2 this is one slot each, which is the point: neither lane can starve
  // the other.
  const effectiveCap = opts.directed === true ? cap : Math.max(1, cap - 1);
  let path: string | null = null;
  try {
    await mkdir(SLOT_DIR, { recursive: true });
    const live = await countLive(Date.now());
    if (live >= effectiveCap) {
      return { granted: false, observed: live, release: async () => {} };
    }
    path = `${SLOT_DIR}/${composeId}.slot`;
    await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return {
      granted: true,
      observed: live,
      release: async () => {
        if (path) await unlink(path).catch(() => {});
      },
    };
  } catch {
    // Fail open — see the module comment.
    return {
      granted: true,
      observed: -1,
      release: async () => {
        if (path) await unlink(path).catch(() => {});
      },
    };
  }
}
