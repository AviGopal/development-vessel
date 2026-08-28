import { describe, it, expect } from "bun:test";
import { chooseFirstActionable, PENDING_SCAN_MAX } from "../../src/resolvers/gap-to-feature.js";

// Pins the selection-time skip for gaps held in 'pending verification'.
//
// Before this, the eligibility test ran only AFTER selection: the picker chose a gap it could
// not compose, the post-selection branch refused it, and the tick ended in a no-op. Because a
// skipped pick does no work it records no failed attempt, so the score never decayed and the
// same gap won again. Measured over 6h on the live fleet:
// recommit-route-edit-9077062c-typecheck_dangling_reference-narrowed took 50 picks, produced 0
// composes, and held failed_attempts 0 / landability 1.0 — about one wasted cycle every 7
// minutes, while eligible gaps were never picked once.
const rank = (...ids: string[]) => ids.map((id, i) => ({ g: { id }, s: 10 - i }));
const pendingIs = (...ids: string[]) => (g: { id: string }) => ids.includes(g.id);

describe("chooseFirstActionable", () => {
  it("skips a pending top candidate and takes the next actionable one", () => {
    const r = chooseFirstActionable(rank("stuck", "workable"), pendingIs("stuck"));
    expect(r.chosen.g.id).toBe("workable");
    expect(r.skippedPending).toBe(1);
  });

  it("takes the top candidate untouched when it is actionable", () => {
    const r = chooseFirstActionable(rank("workable", "stuck"), pendingIs("stuck"));
    expect(r.chosen.g.id).toBe("workable");
    expect(r.skippedPending).toBe(0);
  });

  it("skips a RUN of pending candidates, not just the first", () => {
    const r = chooseFirstActionable(rank("a", "b", "c", "workable"), pendingIs("a", "b", "c"));
    expect(r.chosen.g.id).toBe("workable");
    expect(r.skippedPending).toBe(3);
  });

  it("fails open to the top candidate when every candidate is pending", () => {
    // Must NOT return null: that would starve the tick. The post-selection guard still
    // refuses this gap, which is exactly the pre-change behaviour.
    const r = chooseFirstActionable(rank("a", "b"), pendingIs("a", "b"));
    expect(r.chosen.g.id).toBe("a");
    expect(r.skippedPending).toBe(2);
  });

  it("evaluates the predicate LAZILY — not once per pooled gap", () => {
    // The real predicate spawns `git log` per clone. Evaluating a ~330-gap pool every pick
    // would be hundreds of subprocesses, which is why the check was post-selection at all.
    let calls = 0;
    const ranked = rank(...Array.from({ length: 300 }, (_, i) => `g${i}`));
    chooseFirstActionable(ranked, (g) => { calls++; return g.id === "g0"; });
    expect(calls).toBe(2); // g0 pending, g1 actionable — then it stops
  });

  it("never evaluates more than scanMax candidates", () => {
    let calls = 0;
    const ranked = rank(...Array.from({ length: 100 }, (_, i) => `g${i}`));
    const r = chooseFirstActionable(ranked, () => { calls++; return true; }, 5);
    expect(calls).toBe(5);
    expect(r.chosen.g.id).toBe("g0"); // fail-open
    expect(r.skippedPending).toBe(5);
  });

  it("defaults its scan bound so a pick cannot walk an unbounded pool", () => {
    expect(PENDING_SCAN_MAX).toBeGreaterThan(0);
    expect(PENDING_SCAN_MAX).toBeLessThanOrEqual(50);
  });
});
