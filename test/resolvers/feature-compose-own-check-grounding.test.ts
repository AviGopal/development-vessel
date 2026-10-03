// THE DRAFTER SEES THE CHECK IT MUST PASS (gap the-drafter-never-sees-the-check-it-must-pass, check-first).
//
// Measured 2026-10-03: the autonomous lane attempted four armed check-first gap families about fifteen times
// and landed none. Each gap carries a class-2 own check (evidence_resolve test_suite: a test file plus the
// named tests that must turn green). feature_compose resolves that check (gapOwnTestSuite) only at VERIFY, to
// run it; the drafter's grounding is the vessel's src tree plus target windows, so the check's contract - the
// API it calls, the option names it passes, the identifiers it imports - was never in the prompt. Drafts
// edited the right file in a shape the check does not exercise and failed it identically, round after round.
//
// Expected:
//   - for a gap with an own check, the grounding carries the check's test file, READ-ONLY: its imports and the
//     bodies of the named tests (the whole file when it fits one target window), bounded by PER_FILE_SLICE, and
//     says it is the check the draft must pass and must NOT edit;
//   - the test file is read from the vessel clone (VESSELS_CLONE_ROOT), never the runtime tree, which omits
//     test/ (the relocation-hint rule);
//   - a test whose title is a template literal (built in a loop over labels) is located all the same;
//   - a gap without an own check gets no block (unchanged grounding).
// GUARD (qa ruling; green at base and after): now that the drafter is shown the check file, a draft that edits
// it is still refused - strayTestEdits names it, and the semantic disposition vetoes a check-file-only diff as
// self_certification even when the check went red to green.
//
// Seam: ownCheckGrounding (feature-compose), reached as an optional export so its absence reads as a red
// assertion. The compose itself is not driven end to end here; the resolver appends the returned block to the
// grounding the decompose prompt interpolates verbatim.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(tmpdir(), `own-check-grounding-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONE = join(ROOT, "clone");
const RUNTIME = join(ROOT, "runtime");
const prevClone = process.env["VESSELS_CLONE_ROOT"];
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const RUN = Math.random().toString(36).slice(2, 8);
// feature-compose PER_FILE_SLICE: the window one target file gets.
const TARGET_WINDOW = 6000;
const VESSEL = `ocg-fixture-${RUN}-vessel`;
const CHECK = "test/widget-check.test.ts";
const NAMED = "widget budget > honours the frame budget option";
const LABELLED = "[widget/readable] picks > [widget/readable] reads the declared label contract";

const filler = Array.from({ length: 160 }, (_, i) => `  expect(unrelatedFillerValue${i}).toBe(${i});`).join("\n");
const CHECK_SRC = [
  'import { describe, expect, it } from "bun:test";',
  'import { renderWidget } from "../src/widget";',
  "",
  'describe("widget budget", () => {',
  '  it("honours the frame budget option", () => {',
  "    expect(renderWidget({ frameBudgetMsOption: 16 }).dropped).toBe(0);",
  "  });",
  '  it("an unnamed neighbour that is not part of the check", () => {',
  "    expect(unrelatedSentinelIdentifier).toBe(1);",
  filler,
  "  });",
  "});",
  'for (const label of ["widget/readable", "widget/hidden"]) {',
  "  describe(`[${label}] picks`, () => {",
  "    it(`[${label}] reads the declared label contract`, () => {",
  "      expect(renderWidget({ labelContractKey: label }).ok).toBe(true);",
  "    });",
  "  });",
  "}",
  "",
].join("\n");
const put = (root: string, rel: string, text: string): void => {
  const abs = join(root, VESSEL, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const meta = (only: string[], file = CHECK) => ({
  edit_site: `repos/${VESSEL}/src/widget.ts`,
  evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: file, only_tests: only }, zero_field: "requested_not_passing" },
});
const ground = (m: Record<string, unknown>) => {
  expect(typeof fc.ownCheckGrounding).toBe("function");
  return fc.ownCheckGrounding(m) as { vessel: string; test_file: string; block: string } | null;
};

beforeAll(() => {
  process.env["VESSELS_CLONE_ROOT"] = CLONE;
  put(CLONE, "src/widget.ts", "export function renderWidget(o: Record<string, unknown>): { dropped: number; ok: boolean } { return { dropped: 0, ok: !!o }; }\n");
  put(CLONE, CHECK, CHECK_SRC);
  // The runtime tree holds a STALE copy of the check: it must never be what the drafter is shown.
  put(RUNTIME, CHECK, CHECK_SRC.replace("frameBudgetMsOption", "staleRuntimeOnlyOption"));
});
afterAll(() => {
  if (prevClone === undefined) delete process.env["VESSELS_CLONE_ROOT"]; else process.env["VESSELS_CLONE_ROOT"] = prevClone;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("the own check is in the grounding of the drafter, read-only", () => {
  it("MUST-FAIL a gap with an own check grounds the check file: its path, imports and the body of the named test", () => {
    const g = ground(meta([NAMED]));
    expect(g).not.toBeNull();
    const block = g!.block;
    expect(block).toContain(`repos/${VESSEL}/${CHECK}`);
    expect(block).toContain('import { renderWidget } from "../src/widget";');
    expect(block).toContain("frameBudgetMsOption");
    expect(block).not.toContain("staleRuntimeOnlyOption");
    expect(block).toMatch(/must pass/i);
    expect(block).toMatch(/do not edit/i);
  });

  it("MUST-FAIL the block is bounded by one target window and leaves out tests the check does not name", () => {
    const g = ground(meta([NAMED]));
    expect(g).not.toBeNull();
    expect(CHECK_SRC.length).toBeGreaterThan(TARGET_WINDOW);
    expect(g!.block).not.toContain("unrelatedSentinelIdentifier");
    expect(g!.block.length).toBeLessThanOrEqual(TARGET_WINDOW + 1000);
  });

  it("MUST-FAIL a named test whose title is a template literal is located and its body shown", () => {
    const g = ground(meta([LABELLED]));
    expect(g).not.toBeNull();
    expect(g!.block).toContain("labelContractKey");
  });

  it("CONTROL a gap without an own check gets no block", () => {
    if (typeof fc.ownCheckGrounding !== "function") { expect(typeof fc.ownCheckGrounding).toBe("function"); return; }
    expect(fc.ownCheckGrounding({ edit_site: `repos/${VESSEL}/src/widget.ts` })).toBeNull();
    expect(fc.ownCheckGrounding({ evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } })).toBeNull();
  });

  it("CONTROL a check whose test file is not in the vessel clone gets no block", () => {
    if (typeof fc.ownCheckGrounding !== "function") { expect(typeof fc.ownCheckGrounding).toBe("function"); return; }
    expect(fc.ownCheckGrounding(meta([NAMED], "test/absent-check.test.ts"))).toBeNull();
  });
});

describe("GUARD a draft that edits the check file is refused, however green it makes the check", () => {
  it("GUARD strayTestEdits names the check file when a draft edits it beside the source", () => {
    expect(fc.strayTestEdits(`repos/${VESSEL}`, [CHECK, "src/widget.ts"], meta([NAMED]))).toEqual([CHECK]);
  });

  it("GUARD a check-file-only diff is vetoed as self_certification even when the check went red to green", () => {
    const d = fc.semanticGateDisposition({
      gate: { addresses: false, on_live_path: false, hard_fail: false, reason: "judge says no" },
      own_check: { test_file: CHECK, ran: true, tc_ok: true, base_red: [NAMED], draft_red: [], contract_breach: null },
      diff: `### repos/${VESSEL}/${CHECK}\n-    expect(renderWidget({ frameBudgetMsOption: 16 }).dropped).toBe(0);\n+    expect(true).toBe(true);\n`,
      edit_site: `repos/${VESSEL}/src/widget.ts`,
      src_files: {},
    });
    expect(d.land).toBe(false);
    expect(d.veto).toBe("self_certification");
  });
});
