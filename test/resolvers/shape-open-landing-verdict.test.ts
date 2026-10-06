// CHECK-FIRST: THE INDEPENDENT LANDING VERDICT IS SHAPE-OPEN. Item 1's sweep re-runs a gap's own check at the
// landing's parent and at the landed sha. It used to know one instrument (test_suite); any other check kind waited
// forever ("awaiting_independent_verdict"), so verification could grow only by operator code. Now a gap whose check
// kind is not test_suite is judged by a REGISTERED producer of `pinnedCheckVerdict` for that kind (found through
// discovery), and the evaluator keeps exactly three trust rules over whatever verifier it finds:
//   1. INDEPENDENCE: the verifier is not from the lander's lineage: its source is not touched by the landing, it was
//      not authored in the landed commit, and it was not registered for this gap's lineage;
//   2. CAN-FAIL: the verifier declares a must-fail control and, run IN THIS PASS, the control reads red;
//   3. SAME INSTRUMENT: the same verifier id and version answered at the parent and at the landing.
// test_suite stays the first (built-in) verifier with no behaviour change: its labels are exactly as before.
// A kind with no registered verifier, or any refused rule, is no label: the close waits; it is never a pass.
import { describe, it, expect } from "bun:test";
import * as fc from "../../src/resolvers/feature-compose.js";
import * as g2f from "../../src/resolvers/gap-to-feature.js";

type Verdict = "present" | "absent" | "pending" | "unknown";
type Descriptor = { id: string; version: string; kind: string; source_paths: string[]; lineage?: { authored_sha?: string; registered_by_gap?: string }; must_fail?: { check: Record<string, unknown>; ref: string } };
type Registered = { descriptor: Descriptor; run: (check: Record<string, unknown>, ref: string) => Promise<{ verdict: Verdict; verifier: { id: string; version: string } }> };
type Deps = {
  parentOf: (sha: string) => string | null;
  runAt: (gap: Record<string, unknown>, ref: string) => Promise<Verdict>;
  verifierFor?: (kind: string) => Promise<Registered | null>;
  changedFiles?: (sha: string, parent: string) => string[] | null;
};
type Label = { grounded: boolean; labeler: string; sha: string; parent: string; tests: string[]; ran_at: string; reason?: string; verifier?: Record<string, unknown> };
const verdict = g2f.independentLandingVerdict as unknown as (gap: Record<string, unknown>, sha: string, deps?: Deps) => Promise<{ label: Label | null; reason: string }>;

const SHA = "b".repeat(40);
const PARENT = "a".repeat(40);
const CONTROL_REF = "c".repeat(40);
const fixtureGap = (extra: Record<string, unknown> = {}) => ({
  id: "gap-fixture-kind-1",
  classification_metadata: { evidence_resolve: { shape: "fixture_kind", input: { probe: "the-thing" } }, ...extra },
});
const descriptor = (over: Partial<Descriptor> = {}): Descriptor => ({
  id: "fixture-verifier", version: "1", kind: "fixture_kind",
  source_paths: ["repos/fixture-vessel/src/fixture-verifier.ts"],
  must_fail: { check: { probe: "known-bad" }, ref: CONTROL_REF },
  ...over,
});
// A verifier whose answers depend on the ref: red at the parent and at the control ref, green at the landing.
function registered(d: Descriptor, opts: { versionAt?: Record<string, string>; controlVerdict?: Verdict } = {}): Registered & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    descriptor: d,
    run: async (_check, ref) => {
      calls.push(ref);
      const v: Verdict = ref === SHA ? "absent" : ref === CONTROL_REF ? (opts.controlVerdict ?? "present") : "present";
      return { verdict: v, verifier: { id: d.id, version: opts.versionAt?.[ref] ?? d.version } };
    },
  };
}
const deps = (r: Registered | null, changed: string[] = ["repos/other/src/x.ts"]): Deps => ({
  parentOf: () => PARENT,
  runAt: async () => { throw new Error("a non-test_suite gap must not go through the test_suite runner"); },
  verifierFor: async (kind) => (r && r.descriptor.kind === kind ? r : null),
  changedFiles: () => changed,
});

describe("shape-open independent landing verdict", () => {
  it("MUST-FAIL: a registered pinnedCheckVerdict producer for a non-test_suite kind grounds a gap red@parent -> green@landing", async () => {
    const r = registered(descriptor());
    const out = await verdict(fixtureGap(), SHA, deps(r));
    expect(out.label?.grounded).toBe(true);
    expect(out.label?.labeler).toBe(fc.LANDING_LABELER);
    expect(out.label?.parent).toBe(PARENT);
    expect(out.label?.verifier).toMatchObject({ id: "fixture-verifier", version: "1", kind: "fixture_kind", control: { ref: CONTROL_REF, verdict: "present" } });
    // the control ran in this pass, then the parent and the landing
    expect(r.calls).toEqual([CONTROL_REF, PARENT, SHA]);
    // and the close reads it as verified
    expect(fc.landedCloseReason({}, SHA, false, out.label as never)).toBe("landed_verified");
  });

  it("MUST-FAIL: a verifier whose source the landing touched is from the lander's lineage: refused", async () => {
    const r = registered(descriptor());
    const out = await verdict(fixtureGap(), SHA, deps(r, ["repos/fixture-vessel/src/fixture-verifier.ts"]));
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/lineage/);
  });
  it("MUST-FAIL: a verifier authored in the landed commit is refused", async () => {
    const out = await verdict(fixtureGap(), SHA, deps(registered(descriptor({ lineage: { authored_sha: SHA.slice(0, 12) } }))));
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/lineage/);
  });
  it("MUST-FAIL: a verifier registered for this gap's lineage (the gap or its parent) is refused", async () => {
    const own = await verdict(fixtureGap(), SHA, deps(registered(descriptor({ lineage: { registered_by_gap: "gap-fixture-kind-1" } }))));
    expect(own.label).toBeNull();
    expect(own.reason).toMatch(/lineage/);
    const parentGap = await verdict({ ...fixtureGap(), parent_gap_id: "gap-root-9" }, SHA, deps(registered(descriptor({ lineage: { registered_by_gap: "gap-root-9" } }))));
    expect(parentGap.label).toBeNull();
    expect(parentGap.reason).toMatch(/lineage/);
  });
  it("MUST-FAIL: the landing's changed files are unknown, so independence cannot be judged: refused (fail closed)", async () => {
    const d = deps(registered(descriptor()));
    const out = await verdict(fixtureGap(), SHA, { ...d, changedFiles: () => null });
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/lineage/);
  });

  it("MUST-FAIL: a verifier with no must-fail control is refused", async () => {
    const { must_fail: _m, ...noControl } = descriptor();
    const r = registered(noControl as Descriptor);
    const out = await verdict(fixtureGap(), SHA, deps(r));
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/must-fail control/);
    expect(r.calls).toEqual([]);
  });
  it("MUST-FAIL: a verifier whose must-fail control reads green in this pass cannot fail: refused", async () => {
    const r = registered(descriptor(), { controlVerdict: "absent" });
    const out = await verdict(fixtureGap(), SHA, deps(r));
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/must-fail control/);
  });

  it("MUST-FAIL: a different verifier version at the parent and at the landing is refused", async () => {
    const r = registered(descriptor(), { versionAt: { [SHA]: "2" } });
    const out = await verdict(fixtureGap(), SHA, deps(r));
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/same instrument/);
  });
  it("MUST-FAIL: an answer from another verifier id than the one described is refused", async () => {
    const d = descriptor();
    const r: Registered = { descriptor: d, run: async (_c, ref) => ({ verdict: ref === SHA ? "absent" : "present", verifier: { id: ref === PARENT ? "other" : d.id, version: d.version } }) };
    const out = await verdict(fixtureGap(), SHA, deps(r));
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/same instrument/);
  });

  it("MUST-FAIL: a registered verifier already green at the parent records an ungrounded label (the landing flipped nothing)", async () => {
    const d = descriptor();
    const r: Registered = { descriptor: d, run: async (_c, ref) => ({ verdict: ref === CONTROL_REF ? "present" : "absent", verifier: { id: d.id, version: d.version } }) };
    const out = await verdict(fixtureGap(), SHA, deps(r));
    expect(out.label?.grounded).toBe(false);
    expect(out.label?.reason).toMatch(/did not flip/);
    expect(fc.landedCloseReason({}, SHA, false, out.label as never)).toBe("awaiting_independent_verdict");
  });

  it("no registered verifier for the kind: no label (awaiting), never a pass", async () => {
    const out = await verdict(fixtureGap(), SHA, deps(null));
    expect(out.label).toBeNull();
    expect(out.reason).toMatch(/no registered pinnedCheckVerdict producer/);
    expect(fc.landedCloseReason({}, SHA, false, out.label as never)).toBe("awaiting_independent_verdict");
  });
  it("a registered verifier that cannot judge (unknown) leaves no label", async () => {
    const d = descriptor();
    const r: Registered = { descriptor: d, run: async (_c, ref) => ({ verdict: ref === CONTROL_REF ? "present" : "unknown", verifier: { id: d.id, version: d.version } }) };
    const out = await verdict(fixtureGap(), SHA, deps(r));
    expect(out.label).toBeNull();
  });

  it("CONTROL: a test_suite gap labels exactly as before and never consults the registry", async () => {
    let asked = 0;
    const gap = { id: "g-ts", classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/x", test_file: "test/a.test.ts" } } } };
    const out = await verdict(gap, SHA, {
      parentOf: () => PARENT,
      runAt: async (_g, ref) => (ref === PARENT ? "present" : "absent"),
      verifierFor: async () => { asked++; return null; },
      changedFiles: () => { asked++; return null; },
    });
    expect(asked).toBe(0);
    const { ran_at, ...rest } = out.label!;
    expect(typeof ran_at).toBe("string");
    expect(rest).toEqual({ grounded: true, labeler: fc.LANDING_LABELER, sha: SHA, parent: PARENT, tests: ["test/a.test.ts"] });
  });
});
