// Pins the ORDERING of the four compose-lifecycle timeouts.
//
// THE OBSERVED FAILURE (2026-08-11). Four timeouts govern one compose, written
// independently in three files, each against a remembered number. They did not
// agree: the cutover quiesce (10 min) sat BELOW the ceiling a compose is allowed
// to run (15 min), so a restart gave up while legal work was in flight and the
// 4-minute drain discarded it. Six restarts of the compose host in 2h20m, 54
// `REFUSING long-running request during drain`, two `drain deadline — they will be
// lost`. In-place composes finished inside the window and landed 5 commits;
// ISOLATED composes (fresh worktree + ~1,250-test suite) exceeded it and landed
// ZERO — silently, because a killed compose leaves a plan with no verdict and
// reads downstream exactly like a drafting failure.
//
// No single value was wrong in isolation. The RELATIONSHIP was, and nothing
// asserted it. That is what this file exists to prevent.
import { describe, expect, test } from "bun:test";
import { COMPOSE_CEILING_MS, CUTOVER_QUIESCE_MAX_MS, SLOT_STALE_MS_FOR_TEST } from "./compose-slots";

const DRAIN_MS = Number(process.env["DEV_VESSEL_DRAIN_MS"] ?? process.env["VESSEL_DRAIN_MS"] ?? 240000);

describe("compose lifecycle timeouts — drain < ceiling < quiesce < staleness", () => {
  test("a cutover restart waits LONGER than the longest legal compose", () => {
    // The defect. Quiesce below the ceiling means the guard interrupts the exact
    // work it exists to protect.
    expect(CUTOVER_QUIESCE_MAX_MS).toBeGreaterThan(COMPOSE_CEILING_MS);
  });

  test("a slot is not reaped out from under a compose the restart is still awaiting", () => {
    // Staleness must outlast quiesce, or the slot vanishes while the restart is
    // politely waiting on the very compose that holds it.
    expect(SLOT_STALE_MS_FOR_TEST).toBeGreaterThan(CUTOVER_QUIESCE_MAX_MS);
  });

  test("the drain is the SHORTEST window, deliberately", () => {
    // Drain is unavailability: the unit is already stopping and serving nothing
    // new. It must stay short, which is exactly why quiesce — which happens
    // BEFORE the stop, while the vessel is still serving — has to carry the
    // waiting instead.
    expect(DRAIN_MS).toBeLessThan(COMPOSE_CEILING_MS);
  });

  test("the ordering holds end to end", () => {
    const ordered = [DRAIN_MS, COMPOSE_CEILING_MS, CUTOVER_QUIESCE_MAX_MS, SLOT_STALE_MS_FOR_TEST];
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(new Set(ordered).size).toBe(ordered.length); // no ties: each gap has a reason
  });

  test("the ceiling is a real duration, not an accidental zero or NaN", () => {
    for (const v of [DRAIN_MS, COMPOSE_CEILING_MS, CUTOVER_QUIESCE_MAX_MS, SLOT_STALE_MS_FOR_TEST]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
