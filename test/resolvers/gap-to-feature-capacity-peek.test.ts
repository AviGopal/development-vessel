import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGapToFeature } from "../../src/resolvers/gap-to-feature.js";

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
    // Past the peek, selection reaches for live services this test has no business
    // standing up. A throw from THERE is itself proof the peek did not short-circuit:
    // the skip path returns a body and never throws. Assert the property — "the peek
    // did not stop us" — rather than a full tick, which is a different test's job.
    let body: { skipped_selection?: boolean } | null = null;
    try {
      body = (await resolveGapToFeature({ type: "gapToFeature" } as never)).body as { skipped_selection?: boolean };
    } catch { /* reached selection — the fail-open worked */ }
    expect(body?.skipped_selection).toBeUndefined();
  });
});
