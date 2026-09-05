import { describe, it, expect } from "bun:test";
import { deriveRungs, summariseLadder, ladderDelta, type Rung } from "../../src/resolvers/operational-state.js";

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
  executionsOnGradedArms: 1000,
  executionsOnNeverGradedArms: 0,
  neverGradedArms: 0,
  effectComposes: 12,
  effectTargetsExamined: 20,
  effectTargetsUncovered: 4,
  examComposes: 6,
  examExamined: 10,
  examUnexamined: 0,
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
      executionsOnGradedArms: null,
      executionsOnNeverGradedArms: null,
      neverGradedArms: null,
      effectComposes: null,
      effectTargetsExamined: null,
      effectTargetsUncovered: null,
      examComposes: null,
      examExamined: null,
      examUnexamined: null,
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

  // ---- rung 2: every check script is a TypeScript tool ----

  it("holds rung 2 only when NOTHING staged went unread", () => {
    // Stricter than the other rungs on purpose: an unexamined artifact is not a weak signal,
    // it is no signal. A database-breaking migration landed through exactly this hole.
    const ok = deriveRungs(obs({ examComposes: 6, examExamined: 10, examUnexamined: 0 })).find((x) => x.rung === 2)!;
    expect(ok.holds).toBe(true);
    const bad = deriveRungs(obs({ examComposes: 6, examExamined: 10, examUnexamined: 1 })).find((x) => x.rung === 2)!;
    expect(bad.holds).toBe(false);
    expect(bad.observed["staged_unexamined"]).toBe(1);
  });

  it("treats NO examination data as unmeasured, never as everything-was-read", () => {
    for (const v of [null, 0]) {
      const rung = deriveRungs(obs({ examComposes: v })).find((x) => x.rung === 2)!;
      expect(rung.measurable).toBe(false);
      expect(rung.holds).toBeNull();
      expect(rung.unmeasured_reason).toContain("absence of measurement");
    }
  });

  // ---- rung 3: every gate READS the diff; only a test RUNS it ----

  it("measures rung 3 from persisted compose effect coverage", () => {
    const r = deriveRungs(obs({ effectComposes: 12, effectTargetsExamined: 20, effectTargetsUncovered: 4 }))
      .find((x) => x.rung === 3)!;
    expect(r.measurable).toBe(true);
    expect(r.observed["covered_fraction"]).toBeCloseTo(0.8);
    expect(r.holds).toBe(true);
  });

  it("fails rung 3 when most changed targets have nothing able to execute them", () => {
    const r = deriveRungs(obs({ effectComposes: 9, effectTargetsExamined: 10, effectTargetsUncovered: 8 }))
      .find((x) => x.rung === 3)!;
    expect(r.observed["covered_fraction"]).toBeCloseTo(0.2);
    expect(r.holds).toBe(false);
  });

  it("treats NO compose coverage data as unmeasured, never as fine", () => {
    // The field is new; older traces simply lack it. Absence of the field is absence of
    // measurement, not evidence that coverage is good — reading it the other way would
    // manufacture a green rung out of a schema change.
    for (const v of [null, 0]) {
      const r = deriveRungs(obs({ effectComposes: v })).find((x) => x.rung === 3)!;
      expect(r.measurable).toBe(false);
      expect(r.holds).toBeNull();
      expect(r.unmeasured_reason).toContain("absence of measurement");
    }
  });

  it("does not fabricate a perfect score when zero targets were examined", () => {
    const r = deriveRungs(obs({ effectComposes: 5, effectTargetsExamined: 0, effectTargetsUncovered: 0 }))
      .find((x) => x.rung === 3)!;
    expect(r.holds).toBeNull();
    expect(r.measurable).toBe(false);
  });

  it("carries the drift scan's own unavailability through instead of scoring it", () => {
    const rung = deriveRungs(obs({ driftUnavailable: "sql_root_unreadable_or_empty: /x" })).find(
      (x) => x.rung === 5,
    )!;
    expect(rung.measurable).toBe(false);
    expect(rung.unmeasured_reason).toContain("sql_root_unreadable");
  });

  // ---- the two rungs gate work cannot substitute for ----

  it("fails rung 6 when most ELIGIBLE executions carry no goal-level verdict", () => {
    const rung = deriveRungs(
      obs({ executionsGraded: 200, executionsTotal: 1000, executionsOnGradedArms: 1000 }),
    ).find((x) => x.rung === 6)!;
    expect(rung.holds).toBe(false);
    expect(rung.observed["graded_fraction_of_eligible"]).toBeCloseTo(0.2);
  });

  it("does NOT let never-graded ticks drag rung 6 down — but reports their share", () => {
    // The live store: 22,374 of 36,645 executions (61.1%) come from 1,160 arms that are NEVER
    // graded. Dividing by them gave 0.2066 and made the rung unmovable by any amount of
    // grading. Over the eligible population the same data reads 0.53. The correction must not
    // hide what it corrects, so the never-graded share travels with the verdict.
    const rung = deriveRungs(
      obs({
        executionsTotal: 36645,
        executionsGraded: 7572,
        executionsOnGradedArms: 14271,
        executionsOnNeverGradedArms: 22374,
        neverGradedArms: 1160,
      }),
    ).find((x) => x.rung === 6)!;
    expect(rung.observed["graded_fraction_of_eligible"]).toBeCloseTo(0.5306, 3);
    expect(rung.observed["graded_fraction_of_all"]).toBeCloseTo(0.2066, 3);
    expect(rung.observed["never_graded_arm_share_of_executions"]).toBeCloseTo(0.6106, 3);
    expect(rung.observed["never_graded_arms"]).toBe(1160);
    expect(rung.holds).toBe(true);
  });

  it("reports rung 6 UNMEASURED when the per-arm split is unavailable", () => {
    // Without the split there is no honest denominator, so it must not fall back to the
    // conflated one and call the result a measurement.
    const rung = deriveRungs(obs({ executionsOnGradedArms: null })).find((x) => x.rung === 6)!;
    expect(rung.measurable).toBe(false);
    expect(rung.holds).toBeNull();
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

describe("ladderDelta — an action is only associable with a change if both are observed", () => {
  const r = (n: number, measurable: boolean, holds: boolean | null): Rung => ({
    rung: n, question: `q${n}`, measurable, holds, observed: {},
    ...(measurable ? {} : { unmeasured_reason: "x" }),
  });

  it("distinguishes NOTHING CHANGED from NOTHING TO COMPARE AGAINST", () => {
    // The two read identically as an empty change list, and conflating them is the exact
    // failure this resolver exists to avoid. The first derivation on record has no baseline;
    // saying "no change" there would assert stability that was never observed.
    const now = [r(1, true, true)];
    const first = ladderDelta(now, null);
    expect(first.comparable).toBe(false);
    expect(first.reason).toContain("no prior snapshot");
    const stable = ladderDelta(now, [r(1, true, true)]);
    expect(stable.comparable).toBe(true);
    expect(stable.changed).toEqual([]);
  });

  it("reports a rung that moved, in both directions", () => {
    const broke = ladderDelta([r(3, true, false)], [r(3, true, true)]);
    expect(broke.changed).toEqual([{ rung: 3, from: "holds", to: "broken" }]);
    const fixed = ladderDelta([r(3, true, true)], [r(3, true, false)]);
    expect(fixed.changed).toEqual([{ rung: 3, from: "broken", to: "holds" }]);
  });

  it("treats becoming MEASURABLE as a change worth reporting", () => {
    // Rung 3 went unmeasured -> broken today when its producer went live. That transition is
    // the single most informative event a rung can have: it means the system can now see
    // something it was previously blind to, and it must not be silently folded into "broken".
    const d = ladderDelta([r(3, true, false)], [r(3, false, null)]);
    expect(d.changed).toEqual([{ rung: 3, from: "unmeasured", to: "broken" }]);
  });

  it("ignores rungs absent from the prior snapshot rather than inventing a transition", () => {
    // A newly added rung has no 'from'. Reporting one would fabricate history.
    const d = ladderDelta([r(1, true, true), r(8, true, false)], [r(1, true, true)]);
    expect(d.changed).toEqual([]);
  });

  it("returns an empty comparison for an empty prior snapshot", () => {
    expect(ladderDelta([r(1, true, true)], []).comparable).toBe(false);
  });
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
