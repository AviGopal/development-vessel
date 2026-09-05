import { describe, it, expect } from "bun:test";
import { gateProbeCases, runGateProbes, type GateProbeCase } from "../../src/resolvers/gate-self-probe.js";

/**
 * MAKE THE SUBSTRATE TEST ITS OWN GATES.
 *
 * On 2026-09-05 the .surql effect gate was wrong four times running, and every defect was found
 * by an operator hand-writing a hostile input — never by a unit test, which stayed green
 * throughout. A test asserts what its author already thought of. That made gate quality a
 * function of operator attention, which is the dependency this resolver exists to remove.
 *
 * The three failure modes below are the three that actually happened:
 *   MISS          v1 did not refuse a foreign SQL dialect at all
 *   WRONG REASON  v3 refused the right file citing the wrong clause (`END`, not the ANSI ADD)
 *   FALSE POSITIVE a fail-closed gate that "WEDGED autonomous landings within the hour"
 */
const mk = (over: Partial<GateProbeCase>): GateProbeCase => ({
  rule: "test",
  hostile_desc: "hostile",
  benign_desc: "benign",
  expect_cites: "",
  probeHostile: () => "refused: bad thing",
  probeBenign: () => null,
  ...over,
});

describe("runGateProbes — a gate must refuse the bad AND allow the good", () => {
  it("passes a gate that refuses the hostile artifact and allows the benign one", () => {
    const [r] = runGateProbes([mk({})]);
    expect(r!.ok).toBe(true);
    expect(r!.detail).toBe("ok");
  });

  it("reports MISS when the gate stops refusing — the v1 failure", () => {
    const [r] = runGateProbes([mk({ probeHostile: () => null })]);
    expect(r!.ok).toBe(false);
    expect(r!.refused_hostile).toBe(false);
    expect(r!.detail).toContain("MISS");
  });

  it("reports FALSE POSITIVE when the gate refuses the benign artifact — the WEDGING failure", () => {
    // This is the direction a smoke test omits, and the one that stalls the whole loop:
    // an over-refusing gate does not cause an outage, it silently stops anything landing.
    const [r] = runGateProbes([mk({ probeBenign: () => "refused: everything" })]);
    expect(r!.ok).toBe(false);
    expect(r!.refused_benign).toBe(true);
    expect(r!.detail).toContain("FALSE POSITIVE");
  });

  it("reports WRONG REASON when it refuses but does not cite the stated rule — the v3 failure", () => {
    // v3 refused the probe file for its trailing `END` while the ANSI statement it was built
    // to catch sat unexamined inside a DEFINE EVENT body. A check that only asked "did
    // something refuse?" would have called that a pass and shipped a wedging rule.
    const [r] = runGateProbes([
      mk({ expect_cites: "ANSI/MySQL", probeHostile: () => 'refused: begins with "END"' }),
    ]);
    expect(r!.ok).toBe(false);
    expect(r!.refused_hostile).toBe(true);
    expect(r!.cited_expected).toBe(false);
    expect(r!.detail).toContain("WRONG REASON");
  });

  it("treats a throwing gate as a failure, not as an abstention", () => {
    const [r] = runGateProbes([
      mk({ probeHostile: () => { throw new Error("boom"); } }),
    ]);
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("boom");
  });

  it("keeps rules independent — one failure does not mask the others", () => {
    const out = runGateProbes([
      mk({ rule: "good" }),
      mk({ rule: "bad", probeHostile: () => null }),
      mk({ rule: "also-good" }),
    ]);
    expect(out.filter((o) => o.ok).map((o) => o.rule)).toEqual(["good", "also-good"]);
    expect(out.filter((o) => !o.ok).map((o) => o.rule)).toEqual(["bad"]);
  });

  it("returns nothing for no cases", () => {
    expect(runGateProbes([])).toEqual([]);
  });
});

describe("the real corpus — every shipped refusal rule still behaves", () => {
  it("exercises at least the five deterministic rules currently in the chain", async () => {
    // A shrinking corpus is itself a regression: a rule dropped from the probe is a rule
    // nothing checks any more.
    expect((await gateProbeCases()).length).toBeGreaterThanOrEqual(5);
  });

  it("ALL rules pass against the live implementations", async () => {
    // Calls the exported functions themselves, never a reimplementation — a probe that
    // re-derives the rule tests the probe, not the gate.
    const out = runGateProbes(await gateProbeCases());
    const failing = out.filter((o) => !o.ok);
    expect(failing.map((f) => `${f.rule}: ${f.detail}`)).toEqual([]);
  });

  it("every case names a distinct rule and describes both artifacts", async () => {
    const cases = await gateProbeCases();
    expect(new Set(cases.map((c) => c.rule)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.hostile_desc.length).toBeGreaterThan(0);
      expect(c.benign_desc.length).toBeGreaterThan(0);
    }
  });
});
