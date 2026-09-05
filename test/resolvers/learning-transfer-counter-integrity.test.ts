import { describe, it, expect } from "bun:test";
import { counterIntegrity } from "../../src/resolvers/learning-transfer-report.js";

/**
 * AN ARM CANNOT EXECUTE MORE OFTEN THAN IT IS SELECTED.
 *
 * `variant_performance_metrics.total_executions` is read by lifecycle decisions —
 * `checkAndRetireTemplate` requires >= 20 executions before retiring a poor performer — so an
 * inflated counter miscalibrates every threshold keyed on it.
 *
 * Measured on the live store 2026-09-05:
 *   sum(total_executions) over 4,089 arms : 2,158,161
 *   rows in `execution`                    :    34,314  (63x fewer)
 *   rows in `thompson_selection_log`       :    49,074
 * and, joined on a normalised id, 66 arms with >= 500 claimed executions showed 440,228
 * claims against 2,839 selections — 155x. Worst: `slot-binding`, 243,063 claimed from 5
 * selections.
 *
 * Selection is the only route by which an arm runs, so a large ratio is not a tuning
 * question — it is a broken counter. This gate keeps the invariant asserted continuously
 * rather than rediscovered.
 *
 * THE ABSTENTION CASES MATTER MOST. A detector that over-reports is worse than none, so an
 * arm with zero selection rows is deliberately NOT reported: the selection log may be
 * retained for a shorter window than the counter, and retention is indistinguishable from
 * over-counting without a fixed comparison window. Four of the nine tests below pin that
 * silence rather than the alarm.
 */
describe("counterIntegrity — assert that executions cannot exceed selections", () => {
  it("REPORTS the real measured violation (slot-binding: 243,063 claimed from 5 selections)", () => {
    const arms = [{ activity_id: "slot-binding", total_executions: 243063 }];
    const sel = new Map([["slot-binding", 5]]);
    const r = counterIntegrity(arms, sel);
    expect(r.checked).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.activity_id).toBe("slot-binding");
    expect(r.violations[0]!.ratio).toBe(48613);
    expect(r.worst_ratio).toBe(48613);
  });

  it("normalises `activity:⟨name⟩` so the join actually matches", () => {
    // The naive join matched 0 of 4,089 arms; that 0 was an id-namespace artifact, not a
    // finding. normId strips the prefix AND the corner brackets.
    const arms = [{ activity_id: "activity:⟨development-vessel:draft-gap-closing-activity⟩", total_executions: 13100 }];
    const sel = new Map([["development-vessel:draft-gap-closing-activity", 3]]);
    const r = counterIntegrity(arms, sel);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.activity_id).toBe("development-vessel:draft-gap-closing-activity");
  });

  it("does NOT report an arm whose counter is consistent with its selections", () => {
    const arms = [{ activity_id: "healthy", total_executions: 300 }];
    const sel = new Map([["healthy", 280]]);
    const r = counterIntegrity(arms, sel);
    expect(r.checked).toBe(1);
    expect(r.violations).toHaveLength(0);
  });

  it("sorts worst-first and honours the limit", () => {
    const arms = [
      { activity_id: "a", total_executions: 1000 },
      { activity_id: "b", total_executions: 5000 },
      { activity_id: "c", total_executions: 2000 },
    ];
    const sel = new Map([["a", 1], ["b", 1], ["c", 1]]);
    const r = counterIntegrity(arms, sel, { limit: 2 });
    expect(r.violations.map((v) => v.activity_id)).toEqual(["b", "c"]);
    expect(r.worst_ratio).toBe(5000);
  });

  // ---- abstention: the gate must stay silent when it cannot be sure ----

  it("ABSTAINS on an arm with zero selection rows — retention is not over-counting", () => {
    const arms = [{ activity_id: "untraced", total_executions: 4359 }];
    const r = counterIntegrity(arms, new Map([["untraced", 0]]));
    expect(r.checked).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  it("ABSTAINS on an arm absent from the selection log entirely", () => {
    const arms = [{ activity_id: "missing", total_executions: 9999 }];
    const r = counterIntegrity(arms, new Map());
    expect(r.checked).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  it("ABSTAINS below the execution floor — small counts carry no signal", () => {
    const arms = [{ activity_id: "tiny", total_executions: 12 }];
    const r = counterIntegrity(arms, new Map([["tiny", 1]]));
    expect(r.checked).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  it("ABSTAINS on malformed rows rather than throwing", () => {
    const arms = [
      { activity_id: undefined, total_executions: 5000 },
      { activity_id: "x", total_executions: "not-a-number" },
      {},
    ];
    expect(() => counterIntegrity(arms as never, new Map([["x", 1]]))).not.toThrow();
    expect(counterIntegrity(arms as never, new Map([["x", 1]])).violations).toHaveLength(0);
  });

  it("returns an empty, non-throwing result on empty input", () => {
    const r = counterIntegrity([], new Map());
    expect(r).toEqual({ checked: 0, violations: [], worst_ratio: 0 });
  });
});
