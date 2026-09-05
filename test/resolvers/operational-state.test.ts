import { describe, it, expect } from "bun:test";
import { deriveRungs, summariseLadder, type Rung } from "../../src/resolvers/operational-state.js";

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

/**
 * These were written first as calls to resolveOperationalState, which performs I/O. They
 * therefore passed on a host where the store is unreachable and FAILED inside the vessel where
 * it answers — and the pre-cutover gate caught exactly that, attributed one newly failing test
 * to the commit, and refused to converge. The refusal was right: a test whose outcome depends
 * on whether a database answers is testing the environment, not the code.
 *
 * The summary is a pure function of the rungs, so it is tested as one. No I/O.
 */
const rung = (n: number, measurable: boolean, holds: boolean | null): Rung => ({
  rung: n,
  question: `q${n}`,
  measurable,
  holds,
  observed: {},
  ...(measurable ? {} : { unmeasured_reason: "unmeasured" }),
});

describe("summariseLadder — green only when enough was actually checked", () => {
  it("says insufficient_measurement rather than holds when most rungs went unmeasured", () => {
    // An earlier version's headline returned TRUE with one of seven rungs measured — true to
    // its own name, and a green light to any reader. That is the failure this resolver exists
    // to detect, so the headline has to be the honest field.
    const s = summariseLadder([
      rung(1, true, true),
      ...[2, 3, 4, 5, 6, 7].map((n) => rung(n, false, null)),
    ]);
    expect(s.rungs_measurable).toBe(1);
    expect(s.all_measurable_rungs_hold).toBe(true); // the misleading raw conjunction
    expect(s.verdict).toBe("insufficient_measurement"); // the honest headline
  });

  it("reports broken even when coverage is thin — a failure is not softened by missing data", () => {
    const s = summariseLadder([rung(1, true, false), ...[2, 3, 4, 5, 6, 7].map((n) => rung(n, false, null))]);
    expect(s.verdict).toBe("broken");
    expect(s.first_broken_rung).toBe(1);
  });

  it("says holds only with a majority measured and none broken", () => {
    const s = summariseLadder([
      ...[1, 2, 3, 4].map((n) => rung(n, true, true)),
      ...[5, 6, 7].map((n) => rung(n, false, null)),
    ]);
    expect(s.verdict).toBe("holds");
    expect(s.measurement_coverage).toBeCloseTo(0.57, 2);
  });

  it("does not divide by zero on an empty ladder", () => {
    const s = summariseLadder([]);
    expect(s.measurement_coverage).toBe(0);
    expect(s.verdict).toBe("insufficient_measurement");
  });
});
