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

export function slotDir(): string {
  return process.env["COMPOSE_SLOT_DIR"] ?? "/workspace/compose-slots";
}

/**
 * How long a slot may be held before it is presumed abandoned.
 *
 * A compose runs 5-8 minutes; the ceiling its caller allows is 15. 20 minutes is
 * comfortably past any live run, so reaping cannot steal a slot from working
 * code — while still guaranteeing a crashed holder frees its slot rather than
 * wedging the fleet until an operator intervenes.
 */
const SLOT_STALE_MS = Number(process.env["COMPOSE_SLOT_STALE_MS"] ?? 20 * 60_000);

/**
 * The longest a single compose may legally run, in ms.
 *
 * Stated in this module's own doc above ("the ceiling its caller allows is 15")
 * and now exported, because three OTHER lifecycle timeouts are only correct
 * RELATIVE to it and were each written independently against a remembered number.
 * Measured 2026-08-11 they did not agree:
 *
 *   drain deadline        4 min   (index.ts DEV_VESSEL_DRAIN_MS)
 *   compose ceiling      15 min   (this constant)
 *   cutover quiesce      10 min   (vessel-mitosis-cutover MITOSIS_SELF_RESTART_QUIESCE_MAX_S)
 *   slot staleness       20 min   (SLOT_STALE_MS above)
 *
 * The quiesce sat BELOW the ceiling it exists to protect, so a legal compose was
 * killed by a cutover restart: quiesce waits 10 min, gives up, restarts, and the
 * 4-minute drain then discards whatever is still running. Observed cadence on the
 * compose host that day: six restarts in 2h20m (~13 min apart = 10 quiesce + 4
 * drain, minus overlap), 54 `REFUSING long-running request during drain`, and two
 * explicit `drain deadline — … they will be lost`. Composes that draft IN PLACE
 * finished inside the window and landed 5 commits; ISOLATED composes (a fresh
 * worktree plus a ~1,250-test suite) exceeded it and landed ZERO, silently.
 *
 * THE INVARIANT, pinned by test: drain < ceiling < quiesce < staleness. Each gap
 * has a reason. Quiesce must exceed the ceiling or it interrupts legal work.
 * Staleness must exceed quiesce or a slot is reaped out from under a compose that
 * the restart was still politely waiting for.
 */
export const COMPOSE_CEILING_MS = Number(process.env["COMPOSE_CEILING_MS"] ?? 15 * 60_000);

/**
 * How long a cutover-triggered restart waits for in-flight composes to finish.
 *
 * Must be strictly greater than COMPOSE_CEILING_MS — a restart that gives up
 * before the longest legal compose can finish is a restart that destroys legal
 * work, and it destroys it in the way that is hardest to see: the compose simply
 * stops, leaving a plan with no verdict, which reads downstream as a drafting
 * failure rather than as work that never ran.
 */
export const CUTOVER_QUIESCE_MAX_MS = Number(
  process.env["MITOSIS_SELF_RESTART_QUIESCE_MAX_S"]
    ? Number(process.env["MITOSIS_SELF_RESTART_QUIESCE_MAX_S"]) * 1000
    : COMPOSE_CEILING_MS + 60_000,
);

/** Exported for the invariant test; not part of the acquire/release contract. */
export const SLOT_STALE_MS_FOR_TEST = SLOT_STALE_MS;

export interface ComposeSlot {
  readonly granted: boolean;
  /**
   * Refused because a simultaneous claimant took the last index, rather than
   * because the cap was already full when this call started. Advisory: it only
   * changes how the refusal is DESCRIBED, never whether work proceeds.
   */
  readonly race?: boolean;
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
  // A cap of 0 means zero slots; any other invalid value (NaN, negative) falls back to the default of 2.
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}

/**
 * The cap that applies to one lane.
 *
 * SHARED BY `acquireComposeSlot` AND `peekComposeCapacity` on purpose. A peek that
 * computed this independently could disagree with the acquire it is predicting, and
 * both directions of disagreement are bad in a way that is hard to see: a peek that
 * is too strict starves the lane while every log line reads "lane full, skipped"
 * (healthy-looking silence), and a peek that is too lax simply does nothing. One
 * expression, one behaviour.
 *
 * Note it inherits the `COMPOSE_MAX_CONCURRENT=0` quirk — cap 0 yields 1 autonomous
 * slot and 0 directed ones, inverting the lanes. That is pre-existing and documented
 * elsewhere; the peek must MIRROR acquire, not quietly fix it.
 */
function effectiveCapFor(directed?: boolean): number {
  const cap = capFromEnv();
  return directed === true ? cap : Math.max(1, cap - 1);
}

/**
 * Is the process that took this slot still running?
 *
 * Unreadable or malformed slot files return TRUE (assume alive): a slot we cannot
 * parse must not be reaped out from under a live compose. Only a pid we can read
 * AND find missing from /proc is treated as dead.
 */
async function holderAlive(path: string): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    const pid = typeof raw.pid === "number" ? raw.pid : NaN;
    if (!Number.isFinite(pid) || pid <= 0) return true;
    try {
      // Signal 0 tests existence without touching the process.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return true;
  }
}

/** Count live slots, deleting stale or ownerless ones. Returns the live count. */
async function countLive(now: number): Promise<number> {
  let live = 0;
  const names = await readdir(slotDir());
  for (const name of names) {
    if (!name.endsWith(".slot")) continue;
    const path = `${slotDir()}/${name}`;
    try {
      const st = await stat(path);
      if (now - st.mtimeMs > SLOT_STALE_MS) {
        // Reap rather than leave it to an operator: a crashed compose must not
        // hold capacity forever.
        await unlink(path).catch(() => {});
        continue;
      }
      // DEAD HOLDER = FREE SLOT, RECLAIMED NOW rather than in SLOT_STALE_MS.
      //
      // `release()` runs in a `finally`, which does NOT run when the process is
      // killed — so every restart of this vessel leaks a slot per in-flight
      // compose. Measured: after one deploy, both slots were held by pid 1980861,
      // already dead, and would have blocked all capacity for 20 minutes. The
      // reservation for directed work is worthless if the slots are held by
      // ghosts.
      //
      // The pid is recorded at acquire time for exactly this check. A dead pid is
      // conclusive — that process cannot still be composing. PID REUSE could make
      // a dead holder look alive, which is why the mtime backstop above stays:
      // the two failure modes are opposite, so keeping both is strictly safer
      // than either alone.
      if (!(await holderAlive(path))) {
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
 * Atomic across processes, without a lock. Each slot is a FIXED, NUMBERED file
 * claimed with O_EXCL, so the filesystem arbitrates simultaneous arrivals and no
 * two claimants can hold the same index. There is still no lock to get stuck: a
 * holder that dies leaves a file, and `countLive` reclaims it by dead-pid or
 * staleness before the scan — so the failure mode remains "a slot frees late",
 * never "the fleet is wedged".
 *
 * This replaced a count-then-write version that was deliberately racy on the
 * argument that the overflow merely cost load. That argument was wrong about
 * which property the race breaks: the extra admission consumes the slot RESERVED
 * for directed work, so autonomous overflow silently starved operator dispatches
 * (measured 2026-08-11 — two autonomous composes against a cap of one, and three
 * directed trials refused in a row). The cap is a resource guardrail; the
 * RESERVATION is a fairness property, and a race that can defeat it is a defect
 * in it rather than a rounding error on it.
 */
export interface ComposeCapacity {
  /** Slots this lane could still claim right now. */
  readonly free: number;
  /** Live holders observed, after reaping dead and stale ones. */
  readonly live: number;
  /** The lane's effective cap, for honest logging. */
  readonly cap: number;
}

/**
 * OBSERVE remaining capacity WITHOUT claiming a slot.
 *
 * WHY THIS EXISTS. The gap lane's cost was ordered backwards: it SELECTED a gap and
 * only then asked whether a compose could run. Selection is not cheap — it reads the
 * whole gap store and `admitActionableGaps` shells `bun run typecheck` per vessel
 * (bounded and TTL-cached, but a blocking `spawnSync` all the same). Measured over 48h
 * on 2026-08-31: 4482 picks, of which 3699 (82.5%) ended in `verdict=BUSY stage=capacity`
 * — the lane paid full selection price, typechecks included, to be told there was
 * nowhere to put the result. Peeking first makes those ticks nearly free.
 *
 * This CANNOT reduce landings, which is what makes it safe: a pick that ended in BUSY
 * never composed anything, so skipping it removes cost and no work. It changes when
 * selection's own side effects run (phantom-typecheck retirement, hopeless escalation)
 * from every tick to slot-free ticks only — a latency change, not a capability one.
 *
 * NOT A RESERVATION. Capacity can vanish between the peek and a later `acquire`; the
 * O_EXCL claim there remains the only arbiter. This answers "is it worth SELECTING?",
 * never "is a slot mine?".
 *
 * Returns null when capacity cannot be observed, so callers FAIL OPEN and proceed as
 * before — same contract as the module's acquire path. A capacity signal that cannot
 * see the filesystem must slow the fleet, never halt it.
 */
export async function peekComposeCapacity(
  opts: { directed?: boolean } = {},
): Promise<ComposeCapacity | null> {
  const cap = effectiveCapFor(opts.directed);
  try {
    await mkdir(slotDir(), { recursive: true });
    // Reaps dead/stale holders exactly as acquire would, so a peek can never report a
    // lane as full on the strength of slots held by ghosts.
    const live = await countLive(Date.now());
    return { free: Math.max(0, cap - live), live, cap };
  } catch {
    return null;
  }
}

export async function acquireComposeSlot(
  composeId: string,
  opts: { directed?: boolean } = {},
): Promise<ComposeSlot> {
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
  const effectiveCap = effectiveCapFor(opts.directed);
  let path: string | null = null;
  try {
    await mkdir(slotDir(), { recursive: true });
    // Reap dead/stale holders, then refuse on the live count BEFORE trying to
    // claim. Both checks are load-bearing and neither subsumes the other:
    //
    //   - the COUNT bounds every live slot, including legacy arbitrarily-named
    //     `<composeId>.slot` files written by the previous version (which are on
    //     disk at deploy time, and which the numbered claim below cannot see);
    //   - the atomic CLAIM decides simultaneous arrivals, which the count alone
    //     cannot, because two racers read the same count.
    //
    // Dropping the count in favour of the claim would over-admit across the
    // version change; dropping the claim in favour of the count restores the race.
    const live = await countLive(Date.now());
    if (live >= effectiveCap) {
      return { granted: false, observed: live, release: async () => {} };
    }
    // CLAIM A NUMBERED SLOT ATOMICALLY — count-then-write is not enough.
    //
    // The previous version counted live slots and then wrote a uniquely-named
    // file. Two arrivals that interleave both read the same count and both write,
    // so the cap admits one extra. I documented that race as acceptable because
    // "the cost is load" — and that was wrong about WHICH property it breaks.
    //
    // Measured 2026-08-11: two AUTONOMOUS composes were in flight at once against
    // an autonomous cap of 1 (`REFUSING autonomous compose: 2 in flight`), so they
    // held BOTH slots, and every directed dispatch was refused
    // (`REFUSING DIRECTED compose: 2 in flight`) — three operator trials in a row
    // never reached the drafter. The overflow does not just cost load: it consumes
    // the slot RESERVED for directed work, which voids the reservation the comment
    // above promises. A race that can defeat a safety property is not a rounding
    // error on that property.
    //
    // Slots are now FIXED, NUMBERED names claimed with O_EXCL (`wx`), so the
    // filesystem decides the winner: two simultaneous claimants for slot 2 cannot
    // both succeed. Autonomous work scans only [0, cap-2], leaving the top index
    // claimable by directed work alone — the reservation is now structural rather
    // than advisory.
    //
    // Still fails open (see the module comment): if every index is taken we refuse,
    // but an unreadable/unwritable directory falls through to the catch below.
    for (let i = 0; i < effectiveCap; i++) {
      const candidate = `${slotDir()}/slot-${i}.slot`;
      try {
        // `wx` = O_CREAT | O_EXCL — fails if the file already exists.
        await writeFile(candidate, JSON.stringify({ pid: process.pid, at: Date.now(), composeId }), {
          flag: "wx",
        });
        path = candidate;
        break;
      } catch {
        // Taken by a live holder (countLive already removed dead/stale ones).
        continue;
      }
    }
    if (path === null) {
      // LOST THE RACE, not "cap reached" — say which.
      //
      // `live` was read BEFORE the claim loop. Under simultaneous arrival another
      // claimant can take the last index in between, so a refusal here can report
      // a count that is already stale. Observed 2026-08-11:
      //
      //   [compose-cap] REFUSING autonomous compose: 0 in flight
      //
      // which reads as a broken cap — zero in flight must surely be admissible —
      // and I began diagnosing it as one. The slot directory showed slot-0 held by
      // a live pid: the refusal was CORRECT and only its explanation was wrong.
      //
      // This is the arbitration the O_EXCL claim exists to perform, so it will
      // happen by design whenever two composes arrive together. Reporting the
      // pre-claim count as though it were the reason turns correct behaviour into
      // an apparent defect — and a misleading log has cost more diagnostic time
      // this session than any silent failure.
      const nowLive = await countLive(Date.now()).catch(() => live);
      return { granted: false, observed: nowLive, race: nowLive <= live, release: async () => {} };
    }
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
