// F7 (MUST-FAIL): A COMPOSE THAT TARGETS src/drafter/ DRAFTS WITH THE FLOOR.
//
// A broken open module must never be the thing that drafts its own repair. With the module replaced by one that
// throws AND counts its calls, a compose whose edit_site is repos/development-vessel/src/drafter/index.ts is
// drafted by the closed floor: the module is never called, the report says drafter.fell_back
// "target_under_src_drafter", and the compose reaches verify.
// MUTANT (seen red): the floor condition removed from draftContextThroughOpenModule -> the module is called.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f7", { superRepo: true, who: "test/drafter-split/f7-floor-self-repair.test.ts" });
const { createHarness, events } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const DRAFTER = "../../src/drafter/index.ts";
const realDrafter = { ...(await import(DRAFTER)) };
afterAll(() => { mock.module(DRAFTER, () => realDrafter); H.restore(); });

const DV = "development-vessel";
const TARGET = `repos/${DV}/src/drafter/index.ts`;
let calls = 0;

describe("F7: a compose targeting src/drafter/ drafts with the floor", () => {
  it("the module is never called, the floor drafts, and the compose reaches verify", async () => {
    H.install();
    mock.module(DRAFTER, () => ({
      planDrafterReads: () => { calls++; throw new Error("f7: the open module is broken"); },
      assembleDrafterContext: () => { calls++; throw new Error("f7: the open module is broken"); },
    }));
    const fc = await import("../../src/resolvers/feature-compose.ts?drafter-f7=1");
    let body: Record<string, any> = {};
    const rec = await H.run(fc, {
      name: "f7 drafter self-repair",
      pointer: { spec: `In ${TARGET}, DRAFTER_FIXTURE must be 2.`, verify_vessels: [`repos/${DV}`], land: false, skip_push: true, directed: true, gap: { id: "f7-1", summary: `DRAFTER_FIXTURE in ${TARGET} must be 2` } },
      plan: "drafter_edit",
      files: { [`${DV}/package.json`]: "{\"name\":\"development-vessel\",\"type\":\"module\"}\n", [`${DV}/src/drafter/index.ts`]: "export const DRAFTER_FIXTURE = 1;\nexport function useIt(): number { return DRAFTER_FIXTURE; }\n" },
      store: [{ id: "f7-1", status: "open", category: "code_quality", summary: `DRAFTER_FIXTURE in ${TARGET} must be 2`, classification_metadata: { edit_site: TARGET } }],
    }, (b) => { body = b; });
    expect(calls).toBe(0);
    expect(body.drafter?.fell_back).toBe("target_under_src_drafter");
    expect(rec.decompose_prompt).toContain(`----- ${TARGET} -----`);
    expect(events).toContain("decompose");
    expect(events).toContain("verify");
  }, 60_000);
});
