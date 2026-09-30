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
//
// REVERSED 2026-09-01 (e204d06), and this guard now pins the REVERSAL. The predicate was then
// removed on purpose: `nonzero_field` is a HEALTH field (nonzero reads as "defect gone, close"),
// and the only candidate field was `occurrence_count`, a DEFECT count, so more failures would
// have read as fixed: a false-close generator in the one path meant to close only on
// measurement. The earlier version of this file still demanded `evidence_resolve:` at that site,
// so on 2026-09-30 the failing-test generator filed it as a gap whose only green was re-adding the
// harmful predicate (held by operator + qa before any compose). A health-oriented predicate is
// welcome back; it must not bind nonzero_field to a defect count.

const SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/trace-failure-pattern-report.ts"), "utf8");

describe("systematic_failure gaps carry no inverted closure predicate", () => {
  it("does NOT emit an evidence_resolve predicate at the gap write site (removed on purpose, e204d06)", () => {
    expect(SRC).not.toMatch(/evidence_resolve:\s*\{/);
  });

  it("never binds nonzero_field (a HEALTH field) to occurrence_count (a DEFECT count)", () => {
    // The exact inversion: nonzero reads as "defect gone", so more failures would close the gap.
    expect(SRC).not.toMatch(/nonzero_field\s*:\s*["']occurrence_count["']/);
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
