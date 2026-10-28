// F15 (MUST-FAIL, drafting-as-activities 5.2 instrumentation): a durable compose execution
// must carry the drafter arm that actually drafted it, so 3.1 can extract the base family.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f15", { superRepo: true, who: "test/drafter-split/f15-execution-variant-trace.test.ts" });
const { createHarness, CORPUS, installInlineDrafterWorker } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const restoreInlineWorker = installInlineDrafterWorker();
const DRAFTER = "../../src/drafter/index.ts";
const realDrafter = { ...(await import(DRAFTER)) };
const FX = CORPUS.find((f) => f.name === "directed / verify red")!;
let seq = 0;
const load = async () => await import(`../../src/resolvers/feature-compose.ts?drafter-f15=${++seq}`);

afterAll(() => { mock.module(DRAFTER, () => realDrafter); restoreInlineWorker(); H.restore(); });

async function runWithVariant(variant: string) {
  H.install();
  let emitted: Record<string, any> | undefined;
  const fixture = { ...FX, pointer: { ...FX.pointer, drafter_variant: variant } };
  const rec = await H.run(await load(), fixture, undefined, (body) => { emitted = body; });
  return { rec, emitted };
}

describe("F15: compose execution metadata identifies the drafting arm", () => {
  it('records the declared floor arm on the execution used by ribosome extraction', async () => {
    const { rec, emitted } = await runWithVariant("floor");
    expect(rec.verdict).toBe("UNFAVORABLE");
    expect(emitted?.activity_id).toBe("feature_compose");
    expect(emitted?.metadata?.drafter_variant).toBe("floor");
  }, 60_000);

  it("records a named arm rather than crediting the floor", async () => {
    const { rec, emitted } = await runWithVariant("drafter-v1");
    expect(rec.verdict).toBe("UNFAVORABLE");
    expect(emitted?.metadata?.drafter_variant).toBe("drafter-v1");
  }, 60_000);

  it("keeps a failed selected arm on the trace when drafting falls back to the floor", async () => {
    mock.module(DRAFTER, () => ({
      planDrafterReads: () => { throw new Error("f15: force the selected module to fail"); },
      assembleDrafterContext: () => { throw new Error("f15: force the selected module to fail"); },
    }));
    const { rec, emitted } = await runWithVariant("drafter-v1");
    expect(rec.verdict).toBe("UNFAVORABLE");
    expect(rec.console.some((line) => line.includes("plan_threw: f15: force the selected module to fail"))).toBe(true);
    expect(emitted?.metadata?.drafter_variant).toBe("drafter-v1");
  }, 60_000);
});
