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

// THE RE-LAND TRAP. The predicate above tested `=== 'pending'` only, which protects a gap
// for exactly ONE landing. Class-3 provenance returns 'pending' for a single landing and
// 'present' for a re-land, so the first re-land flips the verdict out of the skip and the
// gap is composed again — producing a third landing, still 'present', forever.
//
// Measured 2026-08-31: gap-env-gated-write-allowlist carries SIX substrate-authored commits,
// all editing src/resolvers/fs-write.ts, three of them within 67 minutes. bafd83d among them
// is the commit §12.6 names as "the inert-diff hole" — the operator fix stopped the false
// CLOSE and did nothing about the re-WORK.
describe("landed-but-unverified gaps are skipped whatever the verdict", () => {
  const stamped = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    classification_metadata: { pending_outcome_verification: "abc1234def5678", ...extra },
  });

  // The real predicate used at the call site, replicated so the rule is pinned independently
  // of verifyGapCondition's live git access.
  const skip = (g: { classification_metadata?: Record<string, unknown> }, verdict: string) => {
    if (verdict === "pending") return true;
    const m = g.classification_metadata ?? {};
    const landed = typeof m.pending_outcome_verification === "string" && (m.pending_outcome_verification as string).length >= 7;
    const measurable = typeof m.hardcoded_url === "string" || typeof m.evidence_resolve === "string" || typeof m.verify_shape === "string";
    return landed && !measurable;
  };

  it("skips a re-landed gap that has NO predicate — 'present' here means churn, not a live defect", () => {
    expect(skip(stamped("g-relanded"), "present")).toBe(true);
  });

  it("still skips the single-landing 'pending' case", () => {
    expect(skip(stamped("g-once"), "pending")).toBe(true);
  });

  it("does NOT skip a MEASURED 'present' — the literal is really still there, retry is right", () => {
    // Class-1: the fix genuinely did not work. This must stay composable.
    expect(skip(stamped("g-measured", { hardcoded_url: "const X = 1" }), "present")).toBe(false);
    expect(skip(stamped("g-c2", { evidence_resolve: "someShape" }), "present")).toBe(false);
  });

  it("does not skip an ordinary gap that never landed", () => {
    expect(skip({ classification_metadata: {} }, "present")).toBe(false);
    expect(skip({}, "unknown")).toBe(false);
  });

  it("ignores a too-short stamp — a truncated sha is not a landing", () => {
    expect(skip({ classification_metadata: { pending_outcome_verification: "abc" } }, "present")).toBe(false);
  });
});
