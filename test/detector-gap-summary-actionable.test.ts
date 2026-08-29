import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
// Locate the SIBLING vessel by walking up to the repos root, not by fixed depth.
// `../../boredom-vessel/...` only resolves when this file sits at
// `<repos>/development-vessel/test/`. From an isolated clone it pointed at
// `/tmp/boredom-vessel/src/goal-generation.ts` and the case failed with ENOENT — a
// portability bug in this file, not a change in the gate it audits. Third instance of this
// fixed-depth class in this suite (see detectors-are-scheduled.test.ts).
function findSiblingVessel(name: string): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const GATE_PATH = findSiblingVessel(join("boredom-vessel", "src", "goal-generation.ts"));
// Skip explicitly rather than fail: a standalone development-vessel checkout genuinely has no
// sibling boredom-vessel to read. Never skip silently, and never skip when it IS found — a real
// change to the gate must still fail this.
const HAS_GATE = GATE_PATH !== null;
if (!HAS_GATE) {
  console.error(
    "[detector-gap-summary-actionable] SKIPPED the gate assertion: no sibling boredom-vessel found above " +
      dirname(fileURLToPath(import.meta.url)) + " — cannot audit the goal-gate from a standalone checkout.",
  );
}

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

  it.skipIf(!HAS_GATE)("the gate itself is unchanged — the fix is on the producer side", async () => {
    const gate = await Bun.file(GATE_PATH!).text();
    // If someone later widens ACTIONABLE_CATEGORIES to paper over a barren summary, this is
    // the reminder that the ordering constraint exists and why.
    expect(gate).toContain('ACTIONABLE_CATEGORIES = new Set(["ui_legibility"])');
    expect(gate).toMatch(/capability\|repair/);
  });
});
