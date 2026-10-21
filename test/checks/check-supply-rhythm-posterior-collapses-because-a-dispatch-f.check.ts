import { describe, test, expect } from "bun:test";
// Repro: Measured 2026-10-20, read-only (coordinator investigation, development-vessel origin/dev a34df81)
// CHECK SUPPLY IS OFF ON BOTH NODES BY ITS OWN DUE FORMULA.
// compose2: rhythm beta 1296 against alpha 16. An arm at 10:54:59Z cut staleness to 2.06 (x0.3)
// against the needed 3, so its next tick is about 22 h later (~2026-10-21T09:30Z). node1: no
// [gap-check-supply] line since 03:41Z; due around 22:00Z today.
// Mechanism (inferred from journal counts): 3 rows are re-settled as dispatch_failed on nearly eve.
//
// The assertion below targets the resolver where the defect lives. It uses ONLY exports from
// src/resolvers/gap-check-supply.ts, reaching classification through outcomeKindOf(). The expected
// behavior under an undue rhythm is that a send failure is treated as a NON-ATTEMPT (not a settled
// failure) — i.e., bookkeeping-only until due, rather than collapsing posterior by settling "failed".
// The current behavior re-settles dispatch_failed, which this test treats as incorrect.
import * as mod from "../../src/resolvers/gap-check-supply";

describe("gap-check-supply — undue rhythm must not settle dispatch_failed", () => {
  test("compose2 rhythm (beta=1296, alpha=16) — dispatch_failed classified as non_attempt (expected)", () => {
    // We do not invoke network or timers. We ONLY exercise the classification surface
    // the resolver exposes. Provide a minimal outcome-like record that names the
    // status observed in the investigation; extra fields are ignored by classifiers
    // that key on status.
    const classify: any = (mod as any).outcomeKindOf;
    const verdict = classify({ status: "dispatch_failed", leg: "beta", alpha: 16, beta: 1296 });

    // EXPECTED (what should happen under an undue rhythm): a failed dispatch while OFF should
    // NOT settle the attempt as failed; it should be treated as a non-attempt/refusal and
    // back off without collapsing posterior. The defect re-settles these as failed.
    expect(verdict).toBe("non_attempt");
  });
});
