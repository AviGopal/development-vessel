// F9 (MUST-FAIL, drafting-as-activities 1.1): THE DRAFTER RECORD RIDES ON THE STRUCTURED ATTEMPT RECORD.
//
// An outcome can be credited to the drafter that drafted it only if the attempt record (the gap's failure_lessons
// entry the compose writes) says which one did and whether the floor drafted instead. Over the corpus fixture
// "directed / verify red" (a failed attempt, so the record is written):
//   - with the open module forced to throw, the written attempt record carries drafter.fell_back (the throw), the
//     variant that was asked for and a null version (seen red on the tree before 1.1: no drafter field at all);
//   - CONTROL: with the shipped module, the record names the variant and the version its context declared, and
//     fell_back is null.
// MUTANTS (seen red): the drafter field never written; fell_back never set; the variant not recorded.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f9", { superRepo: true, who: "test/drafter-split/f9-attempt-drafter-record.test.ts" });
const { createHarness, CORPUS, installInlineDrafterWorker } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const restoreInlineWorker = installInlineDrafterWorker();
const DRAFTER = "../../src/drafter/index.ts";
const realDrafter = { ...(await import(DRAFTER)) };
afterAll(() => { mock.module(DRAFTER, () => realDrafter); restoreInlineWorker(); H.restore(); });

const FX = CORPUS.find((f) => f.name === "directed / verify red")!;
let seq = 0;

/** The drafter field of the last failure_lessons entry the compose wrote on its own gap row. */
async function lastAttemptDrafter(): Promise<unknown> {
  const fc = await import(`../../src/resolvers/feature-compose.ts?drafter-f9=${++seq}`);
  const rec = await H.run(fc, FX);
  const own = rec.gap_writes.map((w) => JSON.parse(w) as Record<string, any>).filter((g) => g.id === FX.pointer.gap.id);
  const lessons = (own.at(-1)?.classification_metadata?.failure_lessons ?? []) as Array<Record<string, unknown>>;
  expect(lessons.length).toBeGreaterThan(0);
  return lessons.at(-1)!["drafter"];
}

describe("F9: the structured attempt record carries the drafter record", () => {
  it("CONTROL: with the shipped module, the attempt record names the variant and its version, and fell_back is null", async () => {
    H.install();
    const d = await lastAttemptDrafter();
    expect(d).toEqual({ variant: "drafter-v1", version: "drafter-v1", fell_back: null });
  }, 60_000);

  it("with the module forced to throw, the attempt record carries drafter.fell_back", async () => {
    H.install();
    mock.module(DRAFTER, () => ({
      planDrafterReads: () => { throw new Error("f9: the open module is forced to throw"); },
      assembleDrafterContext: () => { throw new Error("f9: the open module is forced to throw"); },
    }));
    const d = (await lastAttemptDrafter()) as { variant?: unknown; version?: unknown; fell_back?: unknown } | undefined;
    expect(String(d?.fell_back ?? "(no drafter.fell_back)")).toMatch(/^plan_threw: f9: the open module is forced to throw/);
    expect({ variant: d?.variant, version: d?.version }).toEqual({ variant: "drafter-v1", version: null });
  }, 60_000);
});
