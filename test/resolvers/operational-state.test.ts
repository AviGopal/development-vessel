import { describe, it, expect } from "bun:test";
import { deriveRungs, resolveOperationalState } from "../../src/resolvers/operational-state.js";

/**
 * THE LADDER IS DERIVED, NOT DECLARED.
 *
 * This replaced a document that asserted the planes, the operating states, and a recovery
 * ladder as settled fact. A document cannot notice when it stops being true, which is the same
 * defect as a gate reading a stale file and reporting confidently from it.
 *
 * THE PROPERTY THESE TESTS MOSTLY PIN IS THE REFUSAL TO GUESS. Every observation is
 * `number | null`, null meaning UNMEASURED, and a rung that could not be measured must report
 * `measurable: false` with `holds: null` — never `holds: true`. "I could not look" and "there
 * is nothing there" are the two states this system keeps confusing, and the confusion is
 * always expensive.
 */
const obs = (over: Partial<Parameters<typeof deriveRungs>[0]> = {}) => ({
  executionsRecent: 100,
  gateRulesTotal: 5,
  gateRulesFailing: 0,
  driftMissing: 0,
  driftHazards: 0,
  driftUnavailable: null,
  executionsTotal: 1000,
  executionsGraded: 900,
  armsSelectable: 100,
  gradedPerDay: 300,
  ...over,
});

describe("deriveRungs — measured, and honest about what it could not measure", () => {
  it("reports every rung, and never fewer than the seven the ladder has", () => {
    expect(deriveRungs(obs()).length).toBeGreaterThanOrEqual(7);
  });

  it("holds a rung only on evidence — a healthy store passes 1, 4, 5", () => {
    const r = deriveRungs(obs());
    const by = (n: number) => r.find((x) => x.rung === n)!;
    expect(by(1).holds).toBe(true);
    expect(by(4).holds).toBe(true);
    expect(by(5).holds).toBe(true);
  });

  // ---- the refusal to guess ----

  it("NEVER reports holds:true for a rung it could not measure", () => {
    const r = deriveRungs({
      executionsRecent: null,
      gateRulesTotal: null,
      gateRulesFailing: null,
      driftMissing: null,
      driftHazards: null,
      driftUnavailable: null,
      executionsTotal: null,
      executionsGraded: null,
      armsSelectable: null,
      gradedPerDay: null,
    });
    for (const rung of r) {
      expect(rung.holds).not.toBe(true);
      if (!rung.measurable) {
        expect(rung.holds).toBeNull();
        expect(rung.unmeasured_reason ?? "").not.toBe("");
      }
    }
  });

  it("treats a null count as UNMEASURED, not as zero", () => {
    // A zero would make rung 1 report holds:false — a failing verdict from a query that never
    // answered. The distinction between 'measured zero' and 'no measurement' is the point.
    const nulled = deriveRungs(obs({ executionsRecent: null })).find((x) => x.rung === 1)!;
    const zeroed = deriveRungs(obs({ executionsRecent: 0 })).find((x) => x.rung === 1)!;
    expect(nulled.measurable).toBe(false);
    expect(nulled.holds).toBeNull();
    expect(zeroed.measurable).toBe(true);
    expect(zeroed.holds).toBe(false);
  });

  it("reports rungs 2 and 3 as unmeasured WITH a reason, rather than assuming them", () => {
    // Counting gate activity would measure how often gates ran, which is a different claim and
    // would read as a passing verdict for a question nothing answered.
    for (const n of [2, 3]) {
      const rung = deriveRungs(obs()).find((x) => x.rung === n)!;
      expect(rung.measurable).toBe(false);
      expect(rung.holds).toBeNull();
      expect(rung.unmeasured_reason!.length).toBeGreaterThan(20);
    }
  });

  it("carries the drift scan's own unavailability through instead of scoring it", () => {
    const rung = deriveRungs(obs({ driftUnavailable: "sql_root_unreadable_or_empty: /x" })).find(
      (x) => x.rung === 5,
    )!;
    expect(rung.measurable).toBe(false);
    expect(rung.unmeasured_reason).toContain("sql_root_unreadable");
  });

  // ---- the two rungs gate work cannot substitute for ----

  it("fails rung 6 when most executions carry no goal-level verdict", () => {
    const rung = deriveRungs(obs({ executionsGraded: 200, executionsTotal: 1000 })).find(
      (x) => x.rung === 6,
    )!;
    expect(rung.holds).toBe(false);
    expect(rung.observed["graded_fraction"]).toBeCloseTo(0.2);
  });

  it("scores rung 7 as a RATE per arm per day, not a total", () => {
    // Evidence decays, so a large accumulated total says nothing; the same graded volume
    // spread over more arms is a weaker position, and the arithmetic must show that.
    const few = deriveRungs(obs({ gradedPerDay: 300, armsSelectable: 100 })).find((x) => x.rung === 7)!;
    const many = deriveRungs(obs({ gradedPerDay: 300, armsSelectable: 3000 })).find((x) => x.rung === 7)!;
    expect(few.holds).toBe(true);
    expect(many.holds).toBe(false);
    expect(many.observed["graded_per_arm_per_day"]).toBeCloseTo(0.1);
  });

  it("fails a gate rung when any refusal rule regressed", () => {
    const rung = deriveRungs(obs({ gateRulesFailing: 1 })).find((x) => x.rung === 4)!;
    expect(rung.holds).toBe(false);
  });

  it("does not call zero rules a passing gate rung", () => {
    // An empty probe corpus proves nothing; it must not read as 'all rules pass'.
    const rung = deriveRungs(obs({ gateRulesTotal: 0, gateRulesFailing: 0 })).find((x) => x.rung === 4)!;
    expect(rung.holds).toBe(false);
  });
});

describe("the headline verdict — green only when enough was actually checked", () => {
  it("says insufficient_measurement rather than holds when most rungs went unmeasured", async () => {
    // CAUGHT IN A LIVE RUN. The first version exposed `all_measurable_rungs_hold`, which
    // returned TRUE with ONE of seven rungs measured — true to its own name, and a green light
    // to anyone reading it. That is the failure this whole resolver exists to detect, so the
    // headline field has to be the honest one.
    const r = await resolveOperationalState({ skip_gate_probe: true, skip_drift_scan: true });
    const b = r.body as Record<string, unknown>;
    // With the DB unreachable from a test process, coverage is necessarily low.
    if ((b["rungs_measurable"] as number) * 2 < (b["rungs_total"] as number)) {
      expect(b["verdict"]).toBe("insufficient_measurement");
      expect(b["verdict"]).not.toBe("holds");
    }
    expect(b["measurement_coverage"]).toBeLessThanOrEqual(1);
  });

  it("reports a broken rung even when coverage is thin — a failure is not softened by missing data", async () => {
    const r = await resolveOperationalState({ skip_gate_probe: true, skip_drift_scan: true });
    const b = r.body as Record<string, unknown>;
    if (b["first_broken_rung"] !== null) expect(b["verdict"]).toBe("broken");
  });
});
