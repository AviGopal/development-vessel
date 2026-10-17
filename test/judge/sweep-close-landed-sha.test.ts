// A landing close carries the landing's commit (landed_sha) whichever closer writes it. Since the pending-land sweep became
// the only landed_verified closer (02f55935, 2026-10-05) only 1 of 11 landing closes in 10 days carried it, so scope
// earn-in's guardCommit (which reads landed_sha) found no commit for regression rows whose sha was recoverable.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "..", "src", "judge", "gap-landing-verdict.ts"), "utf8");

describe("landing closes carry landed_sha", () => {
  test("[MUST-FAIL] the sweep's close metadata stamps landed_sha with the landing sha", () => {
    const at = src.indexOf("const sweepClosedMeta: Record<string, unknown> = {");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 1200)).toMatch(/\blanded_sha: sha,/);
  });
  test("[CONTROL] closeLandedGap still stamps it", () => {
    expect(src).toMatch(/landed_sha: land\.commit_sha/);
  });
});

describe("closeLandedGap pays a landing's credit once per (gap, landing)", () => {
  const fn = src.slice(src.indexOf("export async function closeLandedGap"), src.indexOf("export async function closeLandedGap") + 12000);
  test("[MUST-FAIL] the class posterior and the detector closure credit are gated on joinDecisionOutcome's result", () => {
    expect(fn).toMatch(/const credited = joinDecisionOutcome\(meta,/);
    // I4a: the credit is gated on `credited` AND names its landing (the reference the holder resolves).
    expect(fn).toMatch(/if \(credited\) updateClassPosterior\(gapClassOf\(gap\), true, \{ gap_id: id, event_id: land\.commit_sha \? `sha:\$\{land\.commit_sha\}`/);
    expect(fn).toMatch(/if \(credited\) try \{/);
  });
});
