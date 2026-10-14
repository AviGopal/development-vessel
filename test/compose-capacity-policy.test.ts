// THE SHAPED COMPOSE CAPACITY (user ruling 2026-10-14, "Build at the binding site"). The cross-process slot cap and an
// armed-gap reservation are a `composeCapacity` poolImpulse record read at claim time (src/compose-slots.ts). ABSENT →
// exactly today's cap (COMPOSE_MAX_CONCURRENT, default 2) and directed reservation; a valid record binds over the env.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetPolicyReadsForTests } from "../src/judge/gap-policy.js";
import { acquireComposeSlot, peekComposeCapacity, validComposeCapacity, __setComposeCapacityReaderForTests, __effectiveCapForTests, type ComposeCapacityPolicy } from "../src/compose-slots.js";

let dir = "";
let record: ComposeCapacityPolicy | null = null;
const setRecord = (r: ComposeCapacityPolicy | null) => { record = r; __setComposeCapacityReaderForTests(async () => record); };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "compose-capacity-"));
  process.env["COMPOSE_SLOT_DIR"] = dir;
  delete process.env["COMPOSE_MAX_CONCURRENT"];
  setRecord(null);
});
afterEach(async () => {
  __setComposeCapacityReaderForTests(null);
  await rm(dir, { recursive: true, force: true });
  delete process.env["COMPOSE_SLOT_DIR"];
  delete process.env["COMPOSE_MAX_CONCURRENT"];
});
/** Occupy slot i with a holder this process knows is alive. */
const hold = (i: number) => writeFile(join(dir, `slot-${i}.slot`), JSON.stringify({ pid: process.pid, at: Date.now(), composeId: `held-${i}` }));

describe("shaped compose capacity: the record binds at claim time; absent is today's behaviour", () => {
  it("MUST-FAIL (b): record ABSENT → today's cap: env default 2 → directed 2, autonomous 1 (armed or not)", async () => {
    expect([__effectiveCapForTests(true, false, null), __effectiveCapForTests(false, false, null), __effectiveCapForTests(false, true, null)]).toEqual([2, 1, 1]);
    await hold(0);
    expect((await acquireComposeSlot("a", {})).granted).toBe(false);
    expect((await acquireComposeSlot("a2", { armed: true })).granted).toBe(false);
    const d = await acquireComposeSlot("d", { directed: true });
    expect(d.granted).toBe(true); await d.release();
  });
  it("CONTROL: record absent and COMPOSE_MAX_CONCURRENT=3 → the env still applies as today (autonomous 2)", async () => {
    process.env["COMPOSE_MAX_CONCURRENT"] = "3";
    expect(__effectiveCapForTests(false, false, null)).toBe(2);
    expect((await peekComposeCapacity({}))?.cap).toBe(2);
  });
  it("MUST-FAIL (a): a valid record BINDS over a different COMPOSE_MAX_CONCURRENT (the env is only the bootstrap fallback)", async () => {
    process.env["COMPOSE_MAX_CONCURRENT"] = "2";
    setRecord({ max_concurrent: 5, reserved_for_armed: 0 });
    expect((await peekComposeCapacity({}))?.cap).toBe(4);
    expect((await peekComposeCapacity({ directed: true }))?.cap).toBe(5);
    await hold(0);
    const a = await acquireComposeSlot("a", {});
    expect(a.granted).toBe(true); await a.release();
  });
  it("MUST-FAIL: changing the record changes the cap on the NEXT claim, with no restart", async () => {
    await hold(0);
    expect((await acquireComposeSlot("a", {})).granted).toBe(false);
    setRecord({ max_concurrent: 3, reserved_for_armed: 0 });
    const a = await acquireComposeSlot("a", {});
    expect(a.granted).toBe(true); await a.release();
    setRecord(null);
    expect((await acquireComposeSlot("a", {})).granted).toBe(false);
  });
  it("MUST-FAIL: with cap 4 and no armed reservation, armed and unarmed claims are identical to today's first-come", async () => {
    setRecord({ max_concurrent: 4, reserved_for_armed: 0 });
    expect(__effectiveCapForTests(false, false, record)).toBe(3);
    expect(__effectiveCapForTests(false, true, record)).toBe(3);
    await hold(0); await hold(1);
    const u = await acquireComposeSlot("u", {});
    expect(u.granted).toBe(true);
    expect((await acquireComposeSlot("x", { armed: true })).granted).toBe(false);
    await u.release();
  });
  it("MUST-FAIL: reserved_for_armed=1 keeps a slot an unarmed (supply) compose cannot take and an armed one can", async () => {
    setRecord({ max_concurrent: 3, reserved_for_armed: 1 }); // autonomous 2: unarmed may use 1, armed 2
    expect([__effectiveCapForTests(false, false, record), __effectiveCapForTests(false, true, record), __effectiveCapForTests(true, false, record)]).toEqual([1, 2, 3]);
    await hold(0);
    const supply = await acquireComposeSlot("supply", {});
    expect(supply.granted).toBe(false);
    const armed = await acquireComposeSlot("armed", { armed: true });
    expect(armed.granted).toBe(true);
    expect((await peekComposeCapacity({}))?.free).toBe(0);
    await armed.release();
  });
  it("MUST-FAIL: a full lane still returns not-granted for every class (the caller's BUSY)", async () => {
    setRecord({ max_concurrent: 2, reserved_for_armed: 0 });
    await hold(0); await hold(1);
    for (const o of [{}, { armed: true }, { directed: true }]) expect((await acquireComposeSlot("z", o)).granted).toBe(false);
  });
  it("MUST-FAIL: out-of-bounds records are refused by the validator (and the reader then applies today's cap)", () => {
    for (const bad of [{ max_concurrent: 0 }, { max_concurrent: 9 }, { max_concurrent: 2.5 }, { max_concurrent: "4" }, {}, { max_concurrent: 3, reserved_for_armed: 3 }, { max_concurrent: 3, reserved_for_armed: -1 }, { max_concurrent: Number.NaN }])
      expect(validComposeCapacity(bad).ok).toBe(false);
    expect(validComposeCapacity({ max_concurrent: 8, reserved_for_armed: 7 })).toEqual({ ok: true, policy: { max_concurrent: 8, reserved_for_armed: 7 } });
    expect(validComposeCapacity({ max_concurrent: 2 })).toEqual({ ok: true, policy: { max_concurrent: 2, reserved_for_armed: 0 } });
  });
  it("peek mirrors acquire under the record (one shared cap expression)", async () => {
    setRecord({ max_concurrent: 3, reserved_for_armed: 1 });
    expect((await peekComposeCapacity({}))?.cap).toBe(1);
    expect((await peekComposeCapacity({ armed: true }))?.cap).toBe(2);
  });
  it("structural: feature-compose passes armed from the stored row's eligibility, never for the check supply", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(import.meta.dir, "..", "src", "resolvers", "feature-compose.ts"), "utf8");
    expect(src).toContain("acquireComposeSlot(slotId, { directed: isDirected, gapId: _gapIdForSlot, armed: composeArmed })");
    expect(src).toContain("if (!supplyMarker && admissionRow) composeArmed = (await import(\"../judge/gap-eligibility.js\")).composeEligibilitySkipReason(admissionRow) === null;");
  });
});

describe("the real record read (own-producer discovery → newest open composeCapacity pool record)", () => {
  const realFetch = globalThis.fetch;
  let poolAnswer: unknown[] = [];
  beforeEach(() => {
    __setComposeCapacityReaderForTests(null);
    __resetPolicyReadsForTests();
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b?.pointer?.type === "vesselCapability" && b.pointer.shape === "poolImpulse")
        return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
      if (b?.impulse?.type === "poolImpulse") return Response.json({ body: { impulses: b.impulse.shape === "composeCapacity" ? poolAnswer : [] } });
      return new Response("not routed", { status: 599 });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; __resetPolicyReadsForTests(); });
  it("a valid record read from the pool binds; the newest record wins", async () => {
    poolAnswer = [
      { shape: "composeCapacity", updated_at: "2026-10-14T09:00:00Z", body: { max_concurrent: 2 } },
      { shape: "composeCapacity", updated_at: "2026-10-14T10:00:00Z", body: { max_concurrent: 6, reserved_for_armed: 2 } },
    ];
    expect((await peekComposeCapacity({}))?.cap).toBe(3);
    __setComposeCapacityReaderForTests(null);
    expect((await peekComposeCapacity({ armed: true }))?.cap).toBe(5);
  });
  it("an INVALID record is ignored: today's cap applies (never half-applied)", async () => {
    poolAnswer = [{ shape: "composeCapacity", updated_at: "2026-10-14T10:00:00Z", body: { max_concurrent: 12, reserved_for_armed: 1 } }];
    expect((await peekComposeCapacity({}))?.cap).toBe(1);
  });
  it("no record: today's cap", async () => {
    poolAnswer = [];
    expect((await peekComposeCapacity({}))?.cap).toBe(1);
  });
});
