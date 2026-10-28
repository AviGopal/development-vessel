// F5(b) THE VERDICT-DIFF GOLDEN: THE FLOOR AND EVERY GATE BEHAVE BYTE-IDENTICALLY TO THE TREE BEFORE THE SPLIT.
//
// verdict-diff.golden.json was recorded on the tree before the drafter split (the BOUNDARY.md 9 method: the same
// fixture corpus, the same scripted LLM, the same seams, on the base and on the split). Each fixture is a full
// resolveFeatureCompose run; its recording holds the verdict, stage, error, the plan's ops, what was applied, every
// gap-store write in order, every guarded fetch, every prompt (sha256 + bytes, the decompose prompt in full), the
// writes the fs guard refused (lesson appends) and the console, normalised (harness.ts).
//
// It runs the corpus with the open module forced to FAIL (a throwing stand-in), so what it pins is the closed path:
// the floor's prompt bytes and every gate, write and fetch around it. The open module's own rendering is pinned by
// the open data golden under src/drafter/golden/ (a review instrument the lane updates with each open change); this
// file changes only by an operator/qa act. The split's own journal lines ("[drafter] ", "[fc-drafter] ") did not
// exist before it and are set aside before the comparison.
// Re-baselined once, adding only the drafter key on the attempt record: USER RULING 2026-10-22 "Re-baseline, drafter key only (Recommended)" (via qa).
import { afterAll, describe, expect, it, mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-golden", { superRepo: true, who: "test/drafter-split/verdict-diff.golden.test.ts" });
const { createHarness, CORPUS, installInlineDrafterWorker } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const restoreInlineWorker = installInlineDrafterWorker();

const DRAFTER = "../../src/drafter/index.ts";
// A spread snapshot: mock.module re-points the namespace's own bindings, so restoring from it would restore the stand-in.
const realDrafter = await import(DRAFTER).then((m) => ({ ...m })).catch(() => null);
const SPLIT_LINE = /^\[(?:fc-)?drafter\] /;

afterAll(() => {
  if (realDrafter) mock.module(DRAFTER, () => realDrafter);
  restoreInlineWorker();
  H.restore();
});

describe("F5(b) verdict-diff golden: the floor path and every gate are byte-identical to the tree before the split", () => {
  it("every corpus fixture records exactly what the base tree recorded", async () => {
    H.install();
    if (realDrafter) {
      mock.module(DRAFTER, () => ({
        planDrafterReads: () => { throw new Error("golden: the open module is forced to fail (floor path)"); },
        assembleDrafterContext: () => { throw new Error("golden: the open module is forced to fail (floor path)"); },
      }));
    }
    const recs = [];
    let seq = 0;
    for (const fx of CORPUS) {
      const fc = await import(`../../src/resolvers/feature-compose.ts?drafter-golden=${++seq}`);
      const r = await H.run(fc, fx);
      r.console = r.console.filter((l) => !SPLIT_LINE.test(l));
      recs.push(r);
    }
    const actual = JSON.stringify(recs, null, 1) + "\n";
    writeFileSync(join(tmpdir(), "drafter-split-golden.actual.json"), actual);
    const golden = JSON.parse(readFileSync(join(import.meta.dir, "verdict-diff.golden.json"), "utf8")) as typeof recs;
    expect(recs.map((r) => r.name)).toEqual(golden.map((g) => g.name));
    for (let i = 0; i < recs.length; i++) expect({ fixture: recs[i]!.name, rec: recs[i] }).toEqual({ fixture: golden[i]!.name, rec: golden[i]! });
  }, 120_000);
});
