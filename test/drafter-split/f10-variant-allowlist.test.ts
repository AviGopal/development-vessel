// F10 (MUST-FAILS, drafting-as-activities 1.2): THE CORE LOADS A NAMED DRAFTER ASSEMBLY ONLY FROM THE ALLOWLIST.
//
// A compose's pointer may name `drafter_variant`. The closed core reads it once (drafterVariantChoice) and:
//   - absent: loads the shipped module, src/drafter/index.ts, exactly as before (recorded as "drafter-v1");
//   - "floor": drafts with the core's own floor, loads NO module, and records fell_back null (a declared arm, not a
//     fallback); its decompose prompt is the floor prompt a failing module would have left;
//   - an id matching ^drafter-v[0-9]+[a-z0-9-]*$: loads src/drafter/variants/<id>/index.ts, through the one import
//     site and the guard drafterVariantAllowlisted (F3 pins the site's form);
//   - anything else ("../resolvers/x", a number, an empty string): drafts with the floor, loads no module, and records
//     fell_back "unknown_variant".
// MUST-FAIL (seen red on the parent, where the pointer field is ignored): drafter_variant "../resolvers/x" loads a
// module (the shipped one) and records no unknown_variant.
// MUTANTS (seen red): the allowlist loosened; unknown_variant not recorded; "floor" loading the module.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f10", { superRepo: true, who: "test/drafter-split/f10-variant-allowlist.test.ts" });
const { createHarness, CORPUS } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const DRAFTER = "../../src/drafter/index.ts";
const realDrafter = { ...(await import(DRAFTER)) };
// A variant that exists only in this test (no variant ships with this change): it delegates to the shipped module and
// counts its calls. Registered under both spellings the core's computed specifier can resolve to.
const FIXTURE_ID = "drafter-v9-fixture";
let defaultCalls = 0;
let variantCalls = 0;
const counting = (bump: () => void) => ({
  planDrafterReads: (f: unknown) => { bump(); return realDrafter.planDrafterReads(f); },
  assembleDrafterContext: (f: unknown) => { bump(); return realDrafter.assembleDrafterContext(f); },
});
mock.module(DRAFTER, () => counting(() => { defaultCalls++; }));
for (const ext of ["ts", "js"]) mock.module(`../../src/drafter/variants/${FIXTURE_ID}/index.${ext}`, () => counting(() => { variantCalls++; }));
afterAll(() => { mock.module(DRAFTER, () => realDrafter); H.restore(); });

const FX = CORPUS.find((f) => f.name === "directed / pass / no region / no own check")!;
let seq = 0;
async function compose(variant: unknown, opts: { omit?: boolean } = {}): Promise<{ body: Record<string, any>; prompt: string; verdict: unknown; calls: { def: number; variant: number } }> {
  H.install();
  defaultCalls = 0; variantCalls = 0;
  const fc = await import(`../../src/resolvers/feature-compose.ts?drafter-f10=${++seq}`);
  let body: Record<string, any> = {};
  const pointer = opts.omit ? { ...FX.pointer } : { ...FX.pointer, drafter_variant: variant };
  const rec = await H.run(fc, { ...FX, pointer }, (b) => { body = b; });
  return { body, prompt: rec.decompose_prompt, verdict: rec.verdict, calls: { def: defaultCalls, variant: variantCalls } };
}

describe("F10: the allowlist guard and the choice", () => {
  it("drafterVariantAllowlisted admits exactly the allowlist", async () => {
    const fc = await import("../../src/resolvers/feature-compose.ts");
    for (const id of ["drafter-v2", "drafter-v2-contract", "drafter-v10abc", FIXTURE_ID]) expect(fc.drafterVariantAllowlisted(id)).toBe(id);
    for (const id of ["../resolvers/x", "drafter-v2/../../resolvers/x", "drafter-vx", "Drafter-v2", "drafter-v2_x", "drafter-v2.x", "drafter-v2\n", "", "floor", "drafter-v"]) {
      expect(() => fc.drafterVariantAllowlisted(id)).toThrow(/not on the allowlist/);
    }
  });
  it("drafterVariantChoice: absent → the shipped module, floor → the floor, allowlisted → named, anything else → unknown", async () => {
    const fc = await import("../../src/resolvers/feature-compose.ts");
    expect(fc.drafterVariantChoice(undefined)).toEqual({ variant: "drafter-v1", mode: "default" });
    expect(fc.drafterVariantChoice(null)).toEqual({ variant: "drafter-v1", mode: "default" });
    expect(fc.drafterVariantChoice("floor")).toEqual({ variant: "floor", mode: "floor" });
    expect(fc.drafterVariantChoice("drafter-v2-contract")).toEqual({ variant: "drafter-v2-contract", mode: "named" });
    expect(fc.drafterVariantChoice("../resolvers/x")).toEqual({ variant: "../resolvers/x", mode: "unknown" });
    expect(fc.drafterVariantChoice(42)).toEqual({ variant: "42", mode: "unknown" });
    expect(fc.drafterVariantChoice("")).toEqual({ variant: "", mode: "unknown" });
  });
});

describe("F10: a compose loads only what the allowlist names", () => {
  it('drafter_variant "../resolvers/x" loads no module and drafts with the floor, recorded as unknown_variant', async () => {
    const r = await compose("../resolvers/x");
    expect({ def: r.calls.def, variant: r.calls.variant }).toEqual({ def: 0, variant: 0 });
    expect({ variant: r.body.drafter?.variant, fell_back: r.body.drafter?.fell_back }).toEqual({ variant: "../resolvers/x", fell_back: "unknown_variant" });
  }, 60_000);
  it("a non-string drafter_variant loads no module and is recorded as unknown_variant", async () => {
    const r = await compose(42);
    expect(r.calls).toEqual({ def: 0, variant: 0 });
    expect(r.body.drafter?.fell_back).toBe("unknown_variant");
  }, 60_000);
  it("an allowlisted id loads that variant (and not the shipped module)", async () => {
    const r = await compose(FIXTURE_ID);
    expect(r.calls.def).toBe(0);
    expect(r.calls.variant).toBeGreaterThan(0);
    expect({ variant: r.body.drafter?.variant, version: r.body.drafter?.version, fell_back: r.body.drafter?.fell_back }).toEqual({ variant: FIXTURE_ID, version: "drafter-v1", fell_back: null });
  }, 60_000);
  it("an allowlisted id with no module behind it drafts with the floor (import_failed), loading nothing else", async () => {
    const r = await compose("drafter-v9-absent");
    expect(r.calls).toEqual({ def: 0, variant: 0 });
    expect(String(r.body.drafter?.fell_back)).toMatch(/^import_failed: /);
  }, 60_000);
  it("CONTROL: an absent drafter_variant loads the shipped module exactly as before", async () => {
    const r = await compose(undefined, { omit: true });
    expect(r.calls.def).toBeGreaterThan(0);
    expect(r.calls.variant).toBe(0);
    expect({ variant: r.body.drafter?.variant, version: r.body.drafter?.version, fell_back: r.body.drafter?.fell_back }).toEqual({ variant: "drafter-v1", version: "drafter-v1", fell_back: null });
  }, 60_000);
  it('CONTROL: "floor" loads no module, records fell_back null, and drafts with the floor prompt a failing module leaves', async () => {
    const floor = await compose("floor");
    expect(floor.calls).toEqual({ def: 0, variant: 0 });
    expect({ variant: floor.body.drafter?.variant, version: floor.body.drafter?.version, fell_back: floor.body.drafter?.fell_back }).toEqual({ variant: "floor", version: null, fell_back: null });
    mock.module(DRAFTER, () => ({
      planDrafterReads: () => { throw new Error("f10: the open module is forced to fail"); },
      assembleDrafterContext: () => { throw new Error("f10: the open module is forced to fail"); },
    }));
    try {
      const failing = await compose(undefined, { omit: true });
      expect(String(failing.body.drafter?.fell_back)).toMatch(/^plan_threw/);
      expect(floor.prompt.length).toBeGreaterThan(0);
      expect(floor.prompt).toBe(failing.prompt);
      expect(floor.verdict).toBe(failing.verdict);
    } finally {
      mock.module(DRAFTER, () => counting(() => { defaultCalls++; }));
    }
  }, 120_000);
});

// c2b (NEW cases): the shipped module's own id, named explicitly, drafts exactly as an absent drafter_variant does.
// Seen red on 2005997b, where "drafter-v1" resolved to src/drafter/variants/drafter-v1/ (absent) and drafted with the
// floor (import_failed). MUTANT (seen red): the site's default branch dropped.
describe("F10: an explicit drafter-v1 is the shipped module, not the floor", () => {
  it('drafter_variant "drafter-v1" loads src/drafter/index.ts, fell_back null, with the same draft context as absent', async () => {
    const absent = await compose(undefined, { omit: true });
    const named = await compose("drafter-v1");
    expect(named.calls.def).toBeGreaterThan(0);
    expect(named.calls.variant).toBe(0);
    expect({ variant: named.body.drafter?.variant, version: named.body.drafter?.version, fell_back: named.body.drafter?.fell_back }).toEqual({ variant: "drafter-v1", version: "drafter-v1", fell_back: null });
    expect(named.prompt.length).toBeGreaterThan(0);
    expect(named.prompt).toBe(absent.prompt);
    expect(named.verdict).toBe(absent.verdict);
  }, 120_000);
});
