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
    const a = await acquire("a");
    const b = await acquire("b");
    const c = await acquire("c");
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    expect(c.granted).toBe(false); // the storm case
    expect(c.observed).toBe(2);
  });

  test("releasing frees capacity for the next compose", async () => {
    const acquire = await fresh();
    const a = await acquire("a");
    const b = await acquire("b");
    expect((await acquire("c")).granted).toBe(false);
    await a.release();
    expect((await acquire("d")).granted).toBe(true);
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
    await acquire("a");
    await acquire("b");
    expect((await acquire("c")).granted).toBe(false);
    // Age both slots past the staleness horizon, as a crashed holder would.
    const old = new Date(Date.now() - 60 * 60_000);
    for (const f of await readdir(dir)) await utimes(join(dir, f), old, old);
    expect((await acquire("d")).granted).toBe(true);
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
    await acquire("a");
    await acquire("b");
    expect((await acquire("c")).granted).toBe(false); // still capped at 2
  });
});
