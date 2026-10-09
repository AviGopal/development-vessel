// THE COMPOSE ISOLATES EVERY TARGET FILE'S VESSEL (gap an-undirected-compose-isolates-the-wrong-vessel-so-its-grounding-
// window-cannot-contain-the-target-file, check-first).
//
// Measured 2026-10-09 07:04Z: the undirected compose for prior-seeding-...-narrowed was refused before the LLM call with
// "Grounding window does not contain basenames of all target files: [repos/activity-api/src/lib/prior-seed.ts]". The gap's
// edit_site is that activity-api file, but its suspected_real_location (written by the semantic gate) names
// repos/concept-db/src/resolvers/concept.ts. localizeGap tries suspected_real_location first, so the picker's edit target
// was the concept-db file and its verify_vessels were ["repos/concept-db"]; the compose isolated and grounded only
// concept-db, while composeTargetFiles still put the edit_site (activity-api) first among its targets.
//
// Expected: the vessels a compose isolates and grounds are the caller's verify_vessels plus every target file's vessel
// (repos/<v>/... => repos/<v>). A vessel added that way is what the compose may write, so it is added only when it is
// safe; otherwise the compose refuses EARLY (stage target_vessel_not_isolated, before workspace acquisition):
//   (a) a protected vessel (discovery-vessel, identity-vessel) is never added;
//   (b) an autonomous compose never adds a target the autonomy scope excludes;
//   (c) a vessel this node does not own (no clone, or its unit masked) is never added.
// Controls: a single-vessel gap and an explicit verify_vessels that already covers every target are unchanged.
//
// Seam: composeIsolationVessels (feature-compose), reached as an optional export so its absence reads as a red assertion.
import { describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("fc-isolation-vessels", { who: "feature-compose-isolation-vessels.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const PRIOR_SEED = "repos/activity-api/src/lib/prior-seed.ts";
const CONCEPT = "repos/concept-db/src/resolvers/concept.ts";
const OWNED = new Set(["activity-api", "concept-db", "development-vessel", "discovery-vessel", "identity-vessel"]);
const noScope = (): string | null => null;

function isolation(verify: string[], targets: string[], opts: { directed?: boolean; owned?: Set<string>; excludes?: ((p: string) => string | null) | null } = {}): any {
  expect(typeof fc.composeIsolationVessels).toBe("function");
  return fc.composeIsolationVessels(verify, targets, { directed: opts.directed ?? false, owned: opts.owned ?? OWNED, excludes: opts.excludes === undefined ? noScope : opts.excludes });
}

describe("a compose isolates and grounds every target file's vessel", () => {
  // The 07:04Z shape: the gap row's metadata and the spec the picker built from its concept-db edit target.
  const meta = { edit_site: PRIOR_SEED, suspected_real_location: CONCEPT, related_edit_sites: [CONCEPT, "repos/activity-api/src/lib/posterior-update.ts"] };
  const spec = `Address the following substrate gap ...\nTARGET FILES:\n  - ${CONCEPT} — change site named by detector evidence (suspected_real_location)`;
  const pickerVerify = ["repos/concept-db"];

  it("MUST-FAIL: a target under repos/activity-api/ with a concept-db verify set ends with activity-api isolated", () => {
    const targets: string[] = fc.composeTargetFiles(meta, spec);
    expect(targets[0]).toBe(PRIOR_SEED);
    const r = isolation(pickerVerify, targets);
    expect(r.refused).toBeUndefined();
    expect(r.vessels).toContain("repos/activity-api");
    expect(r.vessels).toContain("repos/concept-db");
    expect(r.added).toEqual(["repos/activity-api"]);
  });

  it("MUST-FAIL (a): a target in a protected vessel is refused before isolation, never added", () => {
    for (const v of ["discovery-vessel", "identity-vessel"]) {
      const r = isolation(pickerVerify, [`repos/${v}/src/index.ts`]);
      expect(r.vessels).toBeUndefined();
      expect(r.refused?.stage).toBe("target_vessel_not_isolated");
      expect(r.refused?.vessel).toBe(`repos/${v}`);
      expect(r.refused?.reason).toContain("protected");
    }
  });

  it("MUST-FAIL (b): an autonomous compose does not add a target the autonomy scope excludes", () => {
    const excludes = (p: string): string | null => (p.startsWith("repos/activity-api/src/lib/") ? "activity-api/src/lib/" : null);
    const r = isolation(pickerVerify, [PRIOR_SEED], { excludes });
    expect(r.refused?.stage).toBe("target_vessel_not_isolated");
    expect(r.refused?.file).toBe(PRIOR_SEED);
    expect(r.refused?.reason).toContain("autonomy scope");
    // A directed compose never consults the scope (the same rule as the own check's imports).
    const d = isolation(pickerVerify, [PRIOR_SEED], { directed: true, excludes: null });
    expect(d.vessels).toContain("repos/activity-api");
  });

  it("MUST-FAIL (c): a vessel this node does not own (masked here, or no clone) is never added", () => {
    const masked = new Set(["concept-db", "development-vessel"]); // compose2 masks activity-api
    const r = isolation(pickerVerify, [PRIOR_SEED], { owned: masked });
    expect(r.refused?.stage).toBe("target_vessel_not_isolated");
    expect(r.refused?.vessel).toBe("repos/activity-api");
    expect(r.refused?.reason).toContain("not owned");
    // No readable ownership at all fails closed too.
    expect(isolation(pickerVerify, [PRIOR_SEED], { owned: new Set() }).refused?.stage).toBe("target_vessel_not_isolated");
  });

  it("a target path that fails the plan-path rule adds nothing and refuses nothing", () => {
    const r = isolation(pickerVerify, ["repos/activity-api/src/../x.ts", "/vessels/activity-api/src/x.ts"]);
    expect(r.refused).toBeUndefined();
    expect(r.vessels).toEqual(pickerVerify);
    expect(r.added).toEqual([]);
  });

  it("control: a single-vessel gap is unchanged", () => {
    const targets: string[] = fc.composeTargetFiles({ edit_site: PRIOR_SEED }, `fix ${PRIOR_SEED}`);
    const r = isolation(["repos/activity-api"], targets);
    expect(r.vessels).toEqual(["repos/activity-api"]);
    expect(r.added).toEqual([]);
  });

  it("control: an explicit, consistent verify_vessels is unchanged (either name form), even for a vessel the guards would refuse", () => {
    const verify = ["concept-db", "repos/activity-api"];
    const r = isolation(verify, [PRIOR_SEED, CONCEPT], { owned: new Set(), excludes: () => "everything" });
    expect(r.refused).toBeUndefined();
    expect(r.vessels).toEqual(verify);
    expect(r.added).toEqual([]);
  });

  it("control: an empty verify_vessels is left to the compose's own derivation (no isolation is added)", () => {
    const r = isolation([], [PRIOR_SEED]);
    expect(r.vessels).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it("MUST-FAIL: the early refusal is an infrastructure refusal for the picker, as the grounding refusal it replaces was", async () => {
    const { isInfraRefusalBody } = (await import("../../src/resolvers/gap-to-feature.js")) as Record<string, any>;
    expect(isInfraRefusalBody({ ok: false, verdict: "REFUSED", stage: "grounding" })).toBe(true);
    expect(isInfraRefusalBody({ ok: false, verdict: "REFUSED", stage: "target_vessel_not_isolated" })).toBe(true);
    expect(isInfraRefusalBody({ ok: false, verdict: "REFUSED", stage: "scope" })).toBe(false);
  });
});
