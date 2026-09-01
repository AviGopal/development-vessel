import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pins that the closure predicate on systematic_failure gaps names a RESOLVABLE shape.
//
// Measured 2026-09-01: 480 open gaps, 5 (1.0%) carrying any measurable predicate; all 106
// open systematic_failure gaps carried none. sweepPendingLandVerifications closes only on a
// MEASURED verdict, so a predicate-less gap yields 'pending' forever and the TTL becomes its
// only exit.
//
// The substrate authored the predicate itself (gap route-edit-c9ad6782 → commits 05458f4 then
// 6b6068e) and named the shape wrong BOTH times: first `trace_failure`, then
// `failurePatternReport`. The second is this resolver's own return-shape name (line ~191) —
// but the sweep RESOLVES the shape through discovery, and config.ts advertises
// `trace_failure_pattern_report`. `failurePatternReport` is not among the 390 advertised
// shapes, so the predicate resolved to nothing, yielded 'unknown', and left the gap exactly
// as unclosable as it had been. It typechecked and passed the semantic gate regardless.
//
// This test exists because nothing else could have caught that: the mismatch is a name
// crossing a vessel boundary, which is the same silent class as db-maintenance's integrity
// repair (`violating_rows` vs `count`) and the compose lesson mirror's endpoint.

const SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/trace-failure-pattern-report.ts"), "utf8");
const CONFIG = readFileSync(join(import.meta.dir, "../../src/config.ts"), "utf8");

describe("systematic_failure gaps carry a resolvable closure predicate", () => {
  it("emits an evidence_resolve predicate at the gap write site", () => {
    expect(SRC).toContain("evidence_resolve:");
    expect(SRC).toContain("nonzero_field");
  });

  it("names a shape that config.ts ACTUALLY ADVERTISES", () => {
    // The load-bearing assertion. A predicate naming an unadvertised shape is indistinguishable
    // from no predicate at all, except that it looks fixed.
    const m = SRC.match(/evidence_resolve:\s*\{\s*shape:\s*["']([^"']+)["']/);
    expect(m).not.toBeNull();
    const shape = m![1]!;
    expect(CONFIG).toContain(`"${shape}"`);
  });

  it("does NOT name this resolver's internal return-shape, which is not dispatchable", () => {
    // The exact mistake the substrate made twice. `failurePatternReport` is what the resolver
    // RETURNS; it is not what discovery serves.
    const m = SRC.match(/evidence_resolve:\s*\{\s*shape:\s*["']([^"']+)["']/);
    expect(m![1]).not.toBe("failurePatternReport");
    expect(m![1]).not.toBe("trace_failure");
  });

  it("keys the predicate on the pattern's own identity, not a global count", () => {
    // Without template_id + first_failed_task_id the predicate would re-measure the WHOLE
    // report, so one gap could only close when every systematic failure everywhere was gone.
    const block = SRC.slice(SRC.indexOf("evidence_resolve:"), SRC.indexOf("evidence_resolve:") + 400);
    expect(block).toContain("template_id");
    expect(block).toContain("first_failed_task_id");
  });

  it("keeps every pre-existing classification_metadata key", () => {
    // This was an ADDITION beside them. Losing one would break the drafter grounding that
    // reads failing_capability / example_trace_ids.
    for (const k of [
      "failing_capability", "first_failed_task_id", "failure_mode_types",
      "occurrence_count", "example_trace_ids", "successful_task_count", "total_task_count",
    ]) {
      expect(SRC).toContain(`${k}:`);
    }
  });
});
