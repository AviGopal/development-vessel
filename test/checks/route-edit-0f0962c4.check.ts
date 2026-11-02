// Gap: pull-sync-testgate-budget-starved-development-vessel
//
// WHAT THE GAP SAYS. pull-sync activates this vessel's timer script by writing
// it into the gate-fed run dir (/workspace/active-scripts). That dir is mounted
// read-only for the vessel, so the write comes back as a "read-only file system"
// fault. A read-only mount is PERMANENT: retrying it cannot succeed. If the
// fault is misclassified as transient, pull-sync keeps retrying inside the
// per-tick test-gate budget (1000s, itself capped by the unit timeout), burns
// the whole tick, and defers the vessel. Measured on development-vessel at
// 180e6c2b01: three consecutive ticks deferred, past
// pull_sync.testgate_budget_defer_max (3).
//
// WHAT IS WRONG. The classifier that decides "this dir is not ours to write, so
// stop retrying" is isGateFedWriteError. Today it reads ONLY err.code. The same
// fault frequently reaches the caller as an Error whose code was dropped while
// being wrapped (aggregated spawn output, a re-thrown Error carrying only a
// message) - the EROFS evidence survives in the MESSAGE. Such an error is
// classified as transient, which is exactly the retry loop that starves the
// tick.
//
// WHAT MUST READ TRUE AFTER THE FIX. isGateFedWriteError(err) is true for a
// read-only-file-system error that carries its evidence in the message, just as
// it already is for one that carries code: "EROFS".
//
// This file is the gap's check: it fails on the current tree and passes once
// the classifier recognises the message form. It imports the module the defect
// lives in as a namespace, and only touches exports the module declares.
import { describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/activate-substrate-script";

describe("isGateFedWriteError - a read-only run-dir refusal is permanent, however it is carried", () => {
  test("a write failure whose MESSAGE names EROFS is gate-fed (expected: true)", () => {
    // The shape that reaches pull-sync from a wrapped/aggregated spawn: the
    // EROFS evidence is in the message, the code field was dropped in transit.
    const messageOnly = new Error(
      "EROFS: read-only file system, open '/workspace/active-scripts/substrate-pull-sync.ts'",
    );
    // Classifying this as transient is what makes pull-sync retry a permanent
    // refusal until the per-tick gate budget is gone and the vessel is deferred.
    expect(mod.isGateFedWriteError(messageOnly)).toBe(true);
  });
});

describe("isGateFedWriteError - the structured classification must not regress", () => {
  test("coded refusals are still gate-fed and unrelated faults are still transient", () => {
    // CONTROL. The defect does not touch these; they pass now and after the fix.
    expect(mod.isGateFedWriteError({ code: "EROFS" })).toBe(true);
    expect(mod.isGateFedWriteError({ code: "EACCES" })).toBe(true);
    expect(mod.isGateFedWriteError({ code: "EPERM" })).toBe(true);
    expect(mod.isGateFedWriteError({ code: "ENOSPC" })).toBe(false);
    expect(mod.isGateFedWriteError({ code: "ECONNRESET" })).toBe(false);
    expect(mod.isGateFedWriteError(null)).toBe(false);
    expect(mod.isGateFedWriteError(undefined)).toBe(false);
  });
});
