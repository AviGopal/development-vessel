import { describe, it, expect } from "bun:test";

/**
 * A DETECTED CLASS MUST REACH A FIX, AND THE SUMMARY IS THE LAST MILE.
 *
 * Defect 5 of the 2026-08-13 self-development wiring audit: substrate-authored detectors
 * emitted gaps whose summary was `Observed {count}× occurrences of problem class X`, and the
 * boredom goal-gate dropped every one. "The detector recursion works; its last mile is
 * severed."
 *
 * THE GATE IS NOT THE THING TO LOOSEN. Its ACTIONABLE_CATEGORIES set is deliberately narrow —
 * the code states that widening it would re-open an autocatalytic re-mint loop that was closed
 * at some cost, and that the ordering is "cut the autocatalysis first, then widen". Loosening
 * a correct filter to admit bad input is how the loop comes back.
 *
 * The producer was wrong. A count is not a defect statement: it says something happened N
 * times without saying what broke or what to do. The summary now names the failure, where it
 * occurred, and the repair — so it passes the prose gate because it IS actionable, not because
 * it contains a matching word.
 */

const SRC = new URL("../src/resolvers/detector-coverage-scan.ts", import.meta.url);
const GATE = new URL("../../boredom-vessel/src/goal-generation.ts", import.meta.url);

describe("detector gap summaries are actionable", () => {
  it("THE REGRESSION: the summary is no longer a bare occurrence count", async () => {
    const src = await Bun.file(SRC).text();
    expect(src).not.toContain("emit_summary: `Observed {count}× occurrences of problem class");
    expect(src).toMatch(/emit_summary:\s*`Repair needed:/);
  });

  it("it still carries the count — actionability must not cost the evidence", async () => {
    const src = await Bun.file(SRC).text();
    const idx = src.indexOf("emit_summary:");
    const line = src.slice(idx, src.indexOf("\n", idx));
    expect(line).toContain("{count}");
    // and the two facts that make it diagnosable
    expect(line).toContain("failure_type");
    expect(line).toContain("gap_class");
  });

  it("the emitted summary would pass the gate that drops barren ones", async () => {
    // The gate admits on category OR /capability|repair/i over the summary. Reproduce that
    // predicate against a rendered example rather than trusting the wording by eye.
    const rendered =
      "Repair needed: 12× executions failed with resolver_unavailable on activity:foo, a recurring problem class (detector_coverage_gap) that no detector covers. Diagnose the shared cause from the cited traces and repair the producing capability.";
    expect(/capability|repair/i.test(rendered)).toBe(true);
  });

  it("the gate itself is unchanged — the fix is on the producer side", async () => {
    const gate = await Bun.file(GATE).text();
    // If someone later widens ACTIONABLE_CATEGORIES to paper over a barren summary, this is
    // the reminder that the ordering constraint exists and why.
    expect(gate).toContain('ACTIONABLE_CATEGORIES = new Set(["ui_legibility"])');
    expect(gate).toMatch(/capability\|repair/);
  });
});
