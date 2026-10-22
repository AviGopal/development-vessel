// F11 (MUST-FAILS, drafting-as-activities 1.1, the other attempt writes): EVERY ATTEMPT WRITE CARRIES THE DRAFTER.
//
// F9 pins the failed-compose attempt write. A compose also writes an attempt record in two other places, and an outcome
// recorded there must be attributable to the same drafter:
//   - the scope-drop write (an all-dropped plan, class no_effect_all_dropped), made by the wrapper after the inner run
//     returned, from the report's copy of the run's drafter record. Driven end to end over the corpus fixture
//     "directed / off-target edit": its gap write carries drafter.variant (seen red on 2005997b: no drafter there);
//   - the no-effect write (refusals recorded on a compose whose lesson was another class, or FAVORABLE). The closed
//     corpus has no fixture that reaches it (it needs an fc-repair edit refused on a locked region), so it is pinned
//     through its builder, attemptDrafterField, and by the call site spreading that builder over the run's record.
// MUTANTS (seen red): the scope-drop write without the field; the no-effect write without the field; the builder
// dropping fell_back.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f11", { superRepo: true, who: "test/drafter-split/f11-attempt-drafter-other-writes.test.ts" });
const { createHarness, CORPUS } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const DRAFTER = "../../src/drafter/index.ts";
const realDrafter = { ...(await import(DRAFTER)) };
afterAll(() => { mock.module(DRAFTER, () => realDrafter); H.restore(); });
const CORE = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");

const FX = CORPUS.find((f) => f.name === "directed / off-target edit")!;

describe("F11: the scope-drop attempt write carries the drafter record", () => {
  it("an all-dropped plan's attempt record (no_effect_all_dropped) carries drafter.variant", async () => {
    H.install();
    const fc = await import("../../src/resolvers/feature-compose.ts?drafter-f11=1");
    const rec = await H.run(fc, FX);
    const lessons = rec.gap_writes.map((w) => JSON.parse(w) as Record<string, any>).filter((g) => g.id === FX.pointer.gap.id)
      .flatMap((g) => (g.classification_metadata?.failure_lessons ?? []) as Array<Record<string, any>>);
    const dropped = lessons.filter((l) => l.stage === "scope" && Array.isArray(l.dropped_paths));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.at(-1)!.drafter).toEqual({ variant: "drafter-v1", version: "drafter-v1", fell_back: null });
  }, 60_000);
});

describe("F11: the no-effect attempt write carries the drafter record", () => {
  it("attemptDrafterField copies variant, version and fell_back, and is empty without a record", async () => {
    const fc = await import("../../src/resolvers/feature-compose.ts");
    expect(fc.attemptDrafterField({ variant: "drafter-v1", version: null, fell_back: "plan_threw: x", op_budget: 24, dropped: ["d"] })).toEqual({ drafter: { variant: "drafter-v1", version: null, fell_back: "plan_threw: x" } });
    expect(fc.attemptDrafterField({ variant: "floor", version: null, fell_back: null, op_budget: 24 })).toEqual({ drafter: { variant: "floor", version: null, fell_back: null } });
    expect(fc.attemptDrafterField(undefined)).toEqual({});
    expect(fc.attemptDrafterField({ version: "x" })).toEqual({});
  });
  it("the no-effect write spreads the run's drafter record onto its attempt record", () => {
    const at = CORE.indexOf('await appendComposeLesson("no_effect_region", noEffectRefusals.map(');
    expect(at).toBeGreaterThan(0);
    const call = CORE.slice(at, CORE.indexOf("\n", at));
    expect(call).toContain("{ stage: \"apply\", edited_spans: [], ...refusalEvidence, ...attemptDrafterField(composeDrafterStore.getStore()?.record) }");
  });
});
