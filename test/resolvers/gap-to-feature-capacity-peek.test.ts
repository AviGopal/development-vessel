import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGapToFeature, pickPoolForCapacity } from "../../src/resolvers/gap-to-feature.js";
import { __setComposeCapacityReaderForTests } from "../../src/compose-slots.js";
import { __resetPolicyReadsForTests } from "../../src/judge/gap-policy.js";
import { gapStoreRootForTest } from "../../src/resolvers/substrate-gap.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

// Pins the ORDER of capacity and selection.
//
// The gap lane used to select a gap and only THEN discover the compose lane was full.
// Selection is the expensive half: it reads the whole gap store, and
// admitActionableGaps shells a blocking `bun run typecheck` per vessel. Measured over
// 48h on 2026-08-31: 4482 picks, 3699 of them (82.5%) ending `verdict=BUSY
// stage=capacity`. Every one paid full selection price — typechecks included — for a
// result the lane had nowhere to put.
//
// The skip is safe precisely because it cannot cost a landing: a pick that ended BUSY
// never composed anything. What these tests defend is that it also cannot cost anything
// ELSE — no cooldown stamped on a gap that was never tried, and no change for a caller
// who explicitly named what it wanted.

// The policy reads (autonomyScope, spendEnvelope) fail closed when they cannot be read or hold no record, so this
// fixture answers them as a read that SUCCEEDS and finds the explicit open records (unrestricted, uncapped).
const explicitOpenPolicy = (body: { pointer?: { type?: string; shape?: string }; impulse?: { type?: string } }): Response | null => {
  if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
    return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
  }
  if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
  return null;
};
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "peek-tick-"));
  process.env["COMPOSE_SLOT_DIR"] = dir;
  process.env["COMPOSE_MAX_CONCURRENT"] = "2"; // → autonomous cap of 1
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env["COMPOSE_SLOT_DIR"];
  delete process.env["COMPOSE_MAX_CONCURRENT"];
});

/** Occupy the single autonomous slot with a holder this process knows is alive. */
const fillLane = () =>
  writeFile(join(dir, "slot-0.slot"), JSON.stringify({ pid: process.pid, at: Date.now(), composeId: "held" }));

const cooldowns = () =>
  (resolveGapToFeature as unknown as { __test__gapComposeLastAttemptAt: () => Map<string, number> })
    .__test__gapComposeLastAttemptAt();

describe("gap-to-feature — capacity is checked before selection is paid for", () => {
  it("skips selection and reports a BUSY/capacity refusal when the lane is full", async () => {
    await fillLane();
    const r = await resolveGapToFeature({ type: "gapToFeature" } as never);
    // BUSY/capacity-shaped on purpose: isNonAttemptComposeResult and the caller's
    // existing 45s backoff must classify this exactly as the refusal it replaces.
    // This changes cost, not cadence.
    expect(r.body).toMatchObject({
      ok: false,
      stage: "capacity",
      verdict: "BUSY",
      skipped_selection: true,
      cap: 1,
    });
  });

  it("stamps NO cooldown — a gap that was never picked must not be penalised", async () => {
    // The whole class of bug this lane keeps producing: charging a gap for work that
    // never ran. Nothing was selected here, so nothing may be marked as attempted.
    await fillLane();
    const before = cooldowns().size;
    await resolveGapToFeature({ type: "gapToFeature" } as never);
    expect(cooldowns().size).toBe(before);
  });

  it("does NOT skip a TARGETED dispatch — an explicit caller behaves as before", async () => {
    // Same carve-out as the cooldown filter and the admission gate: someone asked for
    // this specific gap. It must reach selection and fail (or succeed) on its own terms,
    // never on the autonomous lane's occupancy.
    await fillLane();
    const r = await resolveGapToFeature({ type: "gapToFeature", gap_id: "no-such-gap-xyz" } as never);
    expect((r.body as { skipped_selection?: boolean }).skipped_selection).toBeUndefined();
    expect((r.body as { stage?: string }).stage).not.toBe("capacity");
  });

  it("does NOT skip a CATEGORY dispatch either", async () => {
    await fillLane();
    const r = await resolveGapToFeature({ type: "gapToFeature", category: "no-such-category-xyz" } as never);
    expect((r.body as { skipped_selection?: boolean }).skipped_selection).toBeUndefined();
    expect((r.body as { stage?: string }).stage).not.toBe("capacity");
  });

  it("FAILS OPEN when capacity is unobservable, rather than halting selection", async () => {
    // A capacity signal that cannot see the filesystem must slow the fleet, never stop
    // it. If an unreadable slot dir read as "full", gap selection would cease entirely
    // and every log line would say "lane full, skipped" — a dead loop that looks healthy.
    const file = join(dir, "not-a-directory");
    await writeFile(file, "x");
    process.env["COMPOSE_SLOT_DIR"] = join(file, "slots");
    // An isolated (temp) gap store holds other suites' fixture rows, and selection would compose one for real; empty it so selection ends fast. Never touches a non-temp store.
    { const root = gapStoreRootForTest(); if (root.startsWith(tmpdir())) { await mkdir(join(root, "gaps"), { recursive: true }); await writeFile(join(root, "gaps", "gaps.json"), "[]"); } }
    // Past the peek, selection reaches for live services this test has no business
    // standing up. A throw from THERE is itself proof the peek did not short-circuit:
    // the skip path returns a body and never throws. Assert the property — "the peek
    // did not stop us" — rather than a full tick, which is a different test's job.
    // The spend envelope fails closed when unreadable, which would skip selection for a reason this test is
    // not about: answer the policy reads as a successful read of the explicit open records, and leave every other
    // address unreachable as before.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const policy = explicitOpenPolicy(init?.body ? JSON.parse(String(init.body)) : {});
      if (policy) return policy;
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;
    __resetPolicyReadsForTests();
    let body: { skipped_selection?: boolean } | null = null;
    try {
      body = (await resolveGapToFeature({ type: "gapToFeature" } as never)).body as { skipped_selection?: boolean };
    } catch { /* reached selection — the fail-open worked */ } finally { globalThis.fetch = originalFetch; __resetPolicyReadsForTests(); }
    expect(body?.skipped_selection).toBeUndefined();
  });
});

// THE SHAPED compose capacity at the PICKER (compose-slots.ts composeCapacity; qa review 2026-10-14). The pre-selection peek
// asks whether ANY autonomous compose can start (armed), and when only armed-reserved slots are free the pick is made
// among armed rows only, so the reservation never starves the armed work it exists for.
const armedRow = { id: "armed-gap", status: "open", classification_metadata: { falsifier: "class2", edit_site: "repos/development-vessel/src/x.ts" } };
const unarmedRow = { id: "unarmed-gap", status: "open", classification_metadata: { falsifier: "none", edit_site: "repos/development-vessel/src/y.ts" } };
describe("gap-to-feature — the armed-gap reservation reaches the picker", () => {
  afterEach(() => { __setComposeCapacityReaderForTests(null); });
  it("MUST-FAIL (i): max 2 / reserved 1, an armed gap among the candidates → it is the pick pool (not 'lane full')", () => {
    expect(pickPoolForCapacity([unarmedRow, armedRow], true)).toEqual({ rows: [armedRow] });
  });
  it("MUST-FAIL (ii): only armed-reserved slots free and only unarmed candidates → the pick is skipped, saying why", () => {
    const p = pickPoolForCapacity([unarmedRow], true);
    expect(p.rows).toEqual([]);
    expect(p.skipped).toMatch(/only armed-reserved compose slots are free and none of 1 admitted candidate\(s\) is armed/);
  });
  it("MUST-FAIL (iii) control: with no reservation in force the pick pool is the admitted rows, unchanged (today's pick)", () => {
    expect(pickPoolForCapacity([unarmedRow, armedRow], false)).toEqual({ rows: [unarmedRow, armedRow] });
  });
  it("MUST-FAIL (i) at the picker: with max 2 / reserved 1 and an empty lane the picker no longer reports 'compose lane full'", async () => {
    __setComposeCapacityReaderForTests(async () => ({ max_concurrent: 2, reserved_for_armed: 1 }));
    { const root = gapStoreRootForTest(); if (root.startsWith(tmpdir())) { await mkdir(join(root, "gaps"), { recursive: true }); await writeFile(join(root, "gaps", "gaps.json"), "[]"); } }
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      const policy = explicitOpenPolicy(init?.body ? JSON.parse(String(init.body)) : {});
      if (policy) return policy;
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;
    __resetPolicyReadsForTests();
    let body: Record<string, unknown> | null = null;
    try { body = (await resolveGapToFeature({ type: "gapToFeature" } as never)).body as Record<string, unknown>; }
    catch { /* reached selection past the peek */ } finally { globalThis.fetch = originalFetch; __resetPolicyReadsForTests(); }
    expect(String(body?.["error"] ?? "")).not.toMatch(/compose lane full/);
  });
  it("CONTROL: with no record the lane-full skip is today's (autonomous cap 1)", async () => {
    await fillLane();
    const r = await resolveGapToFeature({ type: "gapToFeature" } as never);
    expect(r.body).toMatchObject({ stage: "capacity", verdict: "BUSY", skipped_selection: true, cap: 1 });
  });
});
