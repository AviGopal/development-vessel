// THE BLIND-EDIT REPAIR APPLIES THE ANCHOR IT RE-DERIVED, AND ONLY A UNIQUE ONE.
//
// When a planned edit's old_string does not match the live file, feature_compose reads the file,
// asks the model for a verbatim anchor targeting the same statement, and retries once. An override
// put the plan's ORIGINAL anchor back right before the provenance check, so the check judged the
// anchor that had just failed to match and refused every repair (anchor_not_from_window).
//
// The override existed to stop a truncation loop that shortened the model's anchor until it was
// unique, which can cut a statement in half and then write a new_string meant for the whole of it.
// Both are gone: the model's anchor is applied only when it occurs exactly once, verbatim, in the
// live file, and is otherwise refused by name, never shortened.
//
// The decision is blindRepairEdit; its caller sits inside feature_compose's network-bound closure,
// so the wiring is pinned by source inspection.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("fc-blind-repair", { who: "feature-compose-blind-repair.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, unknown>;
type Pick = { old_string: string; new_string: string } | { refused: string; detail: string };
const blindRepairEdit = (live: string, fix: { old_string?: unknown; new_string?: unknown }, planned: string): Pick =>
  (fc.blindRepairEdit as (l: string, f: typeof fix, p: string) => Pick)(live, fix, planned);

const LIVE = [
  "export function a(x: number): number {",
  "  const y = x + 1;",
  "  return y;",
  "}",
  "export function b(x: number): number {",
  "  const y = x + 1;",
  "  return y * 2;",
  "}",
  "export function c(): string {",
  '  return "only-once";',
  "}",
  "",
].join("\n");

const occurs = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0);

/** fs_edit's semantics (anchor must occur exactly once), recording every call it receives. */
function fsEditRecorder(content: string) {
  const calls: Array<{ old_string: string; new_string: string }> = [];
  let text = content;
  return {
    calls,
    get text() { return text; },
    apply(pick: Pick): boolean {
      if ("refused" in pick) return false;
      calls.push({ old_string: pick.old_string, new_string: pick.new_string });
      if (occurs(text, pick.old_string) !== 1) return false;
      text = text.replace(pick.old_string, pick.new_string);
      return true;
    },
  };
}

const PLAN_ANCHOR = '  return "only_once";'; // the plan's guess: absent from LIVE
const PLAN_NEW = '  return "only-twice";';

describe("a unique, verbatim re-derived anchor is applied", () => {
  test("the plan's anchor is absent, the repair's anchor is unique: fs_edit receives the repaired anchor", () => {
    expect(occurs(LIVE, PLAN_ANCHOR)).toBe(0);
    const fix = { old_string: '  return "only-once";', new_string: PLAN_NEW };
    const fs = fsEditRecorder(LIVE);
    const pick = blindRepairEdit(LIVE, fix, PLAN_NEW);
    expect(pick).toEqual({ old_string: '  return "only-once";', new_string: PLAN_NEW });
    expect(fs.apply(pick)).toBe(true);
    expect(fs.calls).toEqual([{ old_string: '  return "only-once";', new_string: PLAN_NEW }]);
    expect(fs.text).toContain('return "only-twice";');
    expect(fs.text).not.toContain('return "only-once";');
  });

  test("a missing new_string falls back to the plan's replacement", () => {
    const pick = blindRepairEdit(LIVE, { old_string: '  return "only-once";' }, PLAN_NEW);
    expect(pick).toEqual({ old_string: '  return "only-once";', new_string: PLAN_NEW });
  });
});

describe("the plan's non-matching anchor is never applied", () => {
  test("a repair that hands back the plan's anchor is refused, with no fs_edit", () => {
    const fs = fsEditRecorder(LIVE);
    const pick = blindRepairEdit(LIVE, { old_string: PLAN_ANCHOR, new_string: PLAN_NEW }, PLAN_NEW);
    expect("refused" in pick).toBe(true);
    expect(fs.apply(pick)).toBe(false);
    expect(fs.calls).toEqual([]);
  });

  test("a successful repair never sends the plan's anchor", () => {
    const fs = fsEditRecorder(LIVE);
    fs.apply(blindRepairEdit(LIVE, { old_string: '  return "only-once";', new_string: PLAN_NEW }, PLAN_NEW));
    expect(fs.calls.length).toBe(1);
    expect(fs.calls.some((c) => c.old_string === PLAN_ANCHOR)).toBe(false);
  });
});

describe("the anchor is never shortened to make it unique (the partial-match protection)", () => {
  test("an anchor occurring twice is refused as non-unique, with no fs_edit", () => {
    const fs = fsEditRecorder(LIVE);
    const anchor = "  const y = x + 1;";
    expect(occurs(LIVE, anchor)).toBe(2);
    const pick = blindRepairEdit(LIVE, { old_string: anchor, new_string: "  const y = x + 2;" }, "");
    expect("refused" in pick && pick.refused).toBe("repair_anchor_non_unique");
    expect(fs.apply(pick)).toBe(false);
    expect(fs.calls).toEqual([]);
  });

  test("an anchor whose whole is absent but whose PREFIX is unique is refused; no truncated prefix is sent", () => {
    const fs = fsEditRecorder(LIVE);
    const anchor = "  const y = x + 1;\n  return y * 3;";
    expect(occurs(LIVE, anchor)).toBe(0);
    expect(occurs(LIVE, "  const y = x + 1;\n  return y * ")).toBe(1); // what a truncating loop would land on
    const pick = blindRepairEdit(LIVE, { old_string: anchor, new_string: "  const y = x + 1;\n  return y * 4;" }, "");
    expect("refused" in pick).toBe(true);
    expect(fs.apply(pick)).toBe(false);
    expect(fs.calls).toEqual([]);
  });
});

describe("the existing gates still bite", () => {
  test("an anchor absent from the file is refused by the provenance check", () => {
    const pick = blindRepairEdit(LIVE, { old_string: "totally unrelated text", new_string: "x" }, "");
    expect("refused" in pick && pick.refused).toBe("anchor_not_from_window");
  });

  test("a unique anchor whose replacement names a symbol the module lacks is refused", () => {
    const fs = fsEditRecorder(LIVE);
    const pick = blindRepairEdit(LIVE, { old_string: '  return "only-once";', new_string: "  return this.ghost;" }, "");
    expect("refused" in pick && pick.refused).toBe("replacement_introduces_unknown_symbol");
    expect(fs.apply(pick)).toBe(false);
    expect(fs.calls).toEqual([]);
  });
});

describe("wiring (source inspection: the repair runs inside feature_compose's network-bound closure)", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
  const start = src.indexOf("// Blind-edit repair:");
  const end = src.indexOf("repair failed; r stays not-ok", start);
  const block = start >= 0 && end > start ? src.slice(start, end) : "";

  test("the repair block is found", () => {
    expect(block.length).toBeGreaterThan(0);
  });
  test("the repair decides its anchor through blindRepairEdit on the model's fix", () => {
    expect(block).toContain('blindRepairEdit(live, fix, op.new_string ?? "")');
  });
  test("nothing reassigns the model's anchor (no plan-anchor override, no truncation)", () => {
    expect(block).not.toMatch(/fix\.old_string\s*=(?!=)/);
    expect(block).not.toMatch(/\.slice\(0,\s*-1\)/);
  });
  test("the one fs_edit in the repair writes the decided anchor, only when not refused", () => {
    expect(block.split('"fs_edit"').length - 1).toBe(1);
    expect(block).toMatch(/if \("refused" in pick\) \{[\s\S]*?\} else \{\s*r = await callTool\(toolsEndpoint, "fs_edit", \{ path: abs, old_string: pick\.old_string, new_string: pick\.new_string \}\)/);
  });
});
