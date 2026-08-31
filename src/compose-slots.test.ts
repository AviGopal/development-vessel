// Pins the cross-process compose capacity cap.
//
// An in-process counter bounded only half the traffic: composes launch from both
// the development-vessel HTTP surface and gap-compose.service, a separate
// `bun gap-compose-tick.ts` process with its own memory. Measured before any cap:
// 27 concurrent typecheck/test processes at load 50.8 on 14 CPUs.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "slots-"));
  process.env["COMPOSE_SLOT_DIR"] = dir;
  process.env["COMPOSE_MAX_CONCURRENT"] = "2";
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env["COMPOSE_SLOT_DIR"];
  delete process.env["COMPOSE_MAX_CONCURRENT"];
});

const fresh = async () => (await import(`./compose-slots.ts?t=${Math.random()}`)).acquireComposeSlot;

describe("compose slots — the cap holds across processes", () => {
  test("grants up to the cap and refuses beyond it", async () => {
    const acquire = await fresh();
    // Directed work may use the FULL cap; autonomous is held to cap-1 (see the
    // reservation tests below), so use directed here to exercise the raw cap.
    const a = await acquire("a", { directed: true });
    const b = await acquire("b", { directed: true });
    const c = await acquire("c", { directed: true });
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    expect(c.granted).toBe(false); // the storm case
    expect(c.observed).toBe(2);
  });

  test("releasing frees capacity for the next compose", async () => {
    const acquire = await fresh();
    const a = await acquire("a", { directed: true });
    const b = await acquire("b", { directed: true });
    expect((await acquire("c", { directed: true })).granted).toBe(false);
    await a.release();
    expect((await acquire("d", { directed: true })).granted).toBe(true);
    await b.release();
  });

  test("slots are FILES, so a second process sees them", async () => {
    // This is the whole point: an in-process counter is invisible to
    // gap-compose.service. A slot written by one process must bound another.
    const acquire = await fresh();
    await acquire("from-process-one");
    expect((await readdir(dir)).filter((f) => f.endsWith(".slot")).length).toBe(1);
  });

  test("a STALE slot is reaped, so a crashed compose cannot wedge the fleet", async () => {
    const acquire = await fresh();
    await acquire("a", { directed: true });
    await acquire("b", { directed: true });
    expect((await acquire("c", { directed: true })).granted).toBe(false);
    // Age both slots past the staleness horizon, as a crashed holder would.
    const old = new Date(Date.now() - 60 * 60_000);
    for (const f of await readdir(dir)) await utimes(join(dir, f), old, old);
    expect((await acquire("d", { directed: true })).granted).toBe(true);
  });

  test("FAILS OPEN when the directory is unusable", async () => {
    // A cap that cannot see the filesystem must slow the fleet, never halt it:
    // admitting one compose too many costs load; refusing all costs the
    // substrate's ability to develop itself.
    process.env["COMPOSE_SLOT_DIR"] = "/proc/cannot/create/here";
    const acquire = await fresh();
    const s = await acquire("x");
    expect(s.granted).toBe(true);
    expect(s.observed).toBe(-1); // sentinel: decision made without a count
  });

  test("a garbage cap falls back to the default, never to unlimited", async () => {
    process.env["COMPOSE_MAX_CONCURRENT"] = "not-a-number";
    const acquire = await fresh();
    await acquire("a", { directed: true });
    await acquire("b", { directed: true });
    expect((await acquire("c", { directed: true })).granted).toBe(false); // still 2
  });
});

describe("compose slots — a directed goal cannot be starved by the boredom lane", () => {
  test("autonomous work is held to cap-1, leaving a slot for directed", async () => {
    // The measured failure this prevents: an operator dispatch that had routed
    // correctly came back "compose capacity cap reached (2 in flight)" while both
    // slots held self-generated gap work. A cap without a reservation converts
    // "waits behind the stream" into "refused outright".
    const acquire = await fresh();
    expect((await acquire("auto-1")).granted).toBe(true);
    expect((await acquire("auto-2")).granted).toBe(false); // cap-1 reached
    expect((await acquire("directed-1", { directed: true })).granted).toBe(true);
  });

  test("directed work is still bounded — it cannot exceed the cap either", async () => {
    // The reservation is a priority, not an exemption; the host bound holds.
    const acquire = await fresh();
    await acquire("directed-1", { directed: true });
    await acquire("directed-2", { directed: true });
    expect((await acquire("directed-3", { directed: true })).granted).toBe(false);
  });

  test("a cap of 1 still admits directed work rather than deadlocking", async () => {
    // cap-1 would be 0 here; the floor keeps autonomous at 1 and directed at 1,
    // so a single-slot host still runs SOMETHING instead of refusing everything.
    process.env["COMPOSE_MAX_CONCURRENT"] = "1";
    const acquire = await fresh();
    expect((await acquire("only", { directed: true })).granted).toBe(true);
  });
});

describe("compose slots — a dead holder frees its slot immediately", () => {
  test("a slot whose pid is gone is reclaimed, not held for 20 minutes", async () => {
    // Measured: after one deploy, BOTH slots were held by pid 1980861 — already
    // dead, killed by the restart. `release()` runs in a `finally`, which does
    // not run when the process is killed, so every restart leaks a slot per
    // in-flight compose. A reservation for directed work is worthless if the
    // slots are held by ghosts.
    const acquire = await fresh();
    await writeFile(join(dir, "ghost.slot"), JSON.stringify({ pid: 999999, at: Date.now() }));
    await writeFile(join(dir, "ghost2.slot"), JSON.stringify({ pid: 999998, at: Date.now() }));
    const s = await acquire("real", { directed: true });
    expect(s.granted).toBe(true);
    // Both ghosts reaped, so exactly one slot remains — the one just claimed.
    // Slots are FIXED NUMBERED names (`slot-<i>.slot`) claimed with O_EXCL so that
    // simultaneous arrivals cannot both win; the composeId no longer names the
    // file. What this test pins is unchanged: dead holders are reclaimed now, not
    // in STALE_MS, and the caller gets a slot.
    const remaining = (await readdir(dir)).filter((f) => f.endsWith(".slot"));
    expect(remaining).toEqual(["slot-0.slot"]);
  });

  test("a LIVE holder keeps its slot", async () => {
    const acquire = await fresh();
    await writeFile(join(dir, "mine.slot"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await acquire("second", { directed: true });
    expect((await acquire("third", { directed: true })).granted).toBe(false); // both counted
  });

  test("an unparseable slot is ASSUMED ALIVE rather than reaped", async () => {
    // Reaping what we cannot read would steal a slot from a live compose. The
    // mtime backstop still bounds it.
    const acquire = await fresh();
    await writeFile(join(dir, "corrupt.slot"), "not json at all");
    await acquire("one", { directed: true });
    expect((await acquire("two", { directed: true })).granted).toBe(false);
  });
});

describe("compose slots — the reservation survives a RACE, not just a count", () => {
  // THE DEFECT: acquisition was count-then-write with uniquely-named files, so two
  // simultaneous arrivals both read the same count and both wrote a slot. I had
  // documented that race as acceptable on the grounds that the overflow "costs
  // load". It does not only cost load — the extra admission consumes the slot
  // RESERVED for directed work. Measured 2026-08-11: two AUTONOMOUS composes ran
  // against an autonomous cap of 1, holding both slots, and three consecutive
  // operator dispatches were refused before reaching the drafter.
  test("simultaneous autonomous claimants cannot exceed the autonomous cap", async () => {
    const acquire = await fresh();
    // cap=2 => autonomous effectiveCap = 1. Fire them together, not in sequence:
    // sequential calls pass even under the old racy implementation.
    const results = await Promise.all([
      acquire("a", { directed: false }),
      acquire("b", { directed: false }),
      acquire("c", { directed: false }),
    ]);
    expect(results.filter((r) => r.granted).length).toBe(1);
  });

  test("a directed compose can still claim the reserved slot afterwards", async () => {
    const acquire = await fresh();
    const auto = await Promise.all([
      acquire("a", { directed: false }),
      acquire("b", { directed: false }),
    ]);
    expect(auto.filter((r) => r.granted).length).toBe(1);
    // The whole point of the reservation: autonomous overflow must not eat this.
    expect((await acquire("directed", { directed: true })).granted).toBe(true);
  });
});

// ─────────────── PEEK: observe capacity without claiming it ───────────────
//
// The gap lane used to SELECT a gap and only then ask whether a compose could run.
// Selection reads the whole gap store and shells a blocking `bun run typecheck` per
// vessel. Measured over 48h on 2026-08-31: 4482 picks, 3699 (82.5%) ending
// `verdict=BUSY stage=capacity` — full selection price paid for a refusal.
//
// The property that makes the peek safe is AGREEMENT WITH ACQUIRE. If the two ever
// compute the lane cap differently, the failure is invisible in the worst direction:
// a peek that is too strict starves the lane while every log line reads "lane full,
// skipped", which looks exactly like a quiet, healthy system.
const freshMod = async () => await import(`./compose-slots.ts?p=${Math.random()}`);

describe("peekComposeCapacity", () => {
  test("reports the AUTONOMOUS cap (cap-1), not the raw cap", async () => {
    const { peekComposeCapacity } = await freshMod();
    // COMPOSE_MAX_CONCURRENT=2 → autonomous sees 1, the reserved slot is directed-only.
    expect(await peekComposeCapacity()).toMatchObject({ free: 1, live: 0, cap: 1 });
    expect(await peekComposeCapacity({ directed: true })).toMatchObject({ free: 2, cap: 2 });
  });

  test("does NOT claim a slot — observing capacity must not consume it", async () => {
    const { peekComposeCapacity, acquireComposeSlot } = await freshMod();
    for (let i = 0; i < 5; i++) await peekComposeCapacity();
    expect(await readdir(dir)).toHaveLength(0);
    // The slot the peeks would have eaten is still grantable.
    expect((await acquireComposeSlot("after-peeks")).granted).toBe(true);
  });

  test("AGREES WITH ACQUIRE: free<=0 exactly when the autonomous lane refuses", async () => {
    const { peekComposeCapacity, acquireComposeSlot } = await freshMod();
    expect((await peekComposeCapacity()).free).toBeGreaterThan(0);
    const held = await acquireComposeSlot("holder");
    expect(held.granted).toBe(true);
    // Autonomous cap is now exhausted — and both must say so.
    expect((await peekComposeCapacity()).free).toBe(0);
    expect((await acquireComposeSlot("second")).granted).toBe(false);
    // ...and both must recover together, or the lane starves silently.
    await held.release();
    expect((await peekComposeCapacity()).free).toBe(1);
    expect((await acquireComposeSlot("third")).granted).toBe(true);
  });

  test("counts a DEAD holder as free, matching acquire's reaping", async () => {
    const { peekComposeCapacity } = await freshMod();
    // pid 2^22 is above every default pid_max — reliably absent from /proc.
    await writeFile(join(dir, "slot-0.slot"), JSON.stringify({ pid: 4194303, at: Date.now() }));
    expect((await peekComposeCapacity()).free).toBe(1);
  });

  test("returns null when capacity is UNOBSERVABLE, so the caller fails open", async () => {
    // A peek that cannot see the filesystem must not report a full lane: that would
    // halt gap selection entirely. null is the signal to proceed as before.
    const file = join(dir, "not-a-directory");
    await writeFile(file, "x");
    process.env["COMPOSE_SLOT_DIR"] = join(file, "slots");
    const { peekComposeCapacity } = await freshMod();
    expect(await peekComposeCapacity()).toBeNull();
  });
});
