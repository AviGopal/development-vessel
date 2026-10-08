// A TEST-WRITING COMPOSE LANDS TESTS ONLY (check-first, slice G revision R3, 2026-10-08).
//
// Slice G admits a gap-check-supply compose of an UNARMED gap as compose_mode "test_writing". Such a compose runs
// land:true with no falsifier of its own, and nothing confined its diff: "Do not change src/." is goal prose, which
// the drafter can ignore. qa: a test-writing compose must not land a change to any non-test file.
//
// THE RULE (testWritingPathIsTest). A path is resolved to its vessel-relative form (after repos/<vessel>/, or after
// .../vessels/<vessel>/ for an absolute runtime or clone path). It is a TEST path when that relative path starts with
// test/, tests/ or __tests__/ (fixtures under them included), or its basename is *.test.<ext> / *.spec.<ext>
// (ext ts|tsx|js|jsx|mts|cts|mjs|cjs) anywhere in the vessel: the supply appends to co-located tests such as
// src/resolvers/gap-to-feature.test.ts and src/floor-tools.test.ts. Everything else is refused: src/** non-test
// files, package.json, config, scripts, a path with a '..' segment. Which vessel a path may touch is the existing
// verify_vessels scope gate's job, not this rule's.
//
// CONTRACT pinned here:
//   - compose_mode "test_writing" + any non-test path => refused, named stage test_writing_diff_outside_tests, listing
//     the paths; at PLAN time (before any op is applied) and again at the landing floor over every path the compose
//     wrote (applied ops and fc-repair writes), so a repair cannot widen the diff.
//   - CONTROLS: only test/x.test.ts or src/y.test.ts => proceeds; an ordinary compose (no compose_mode) is unaffected
//     whatever it touches.
//
// SEAM: the gate is a pure function (check-supply-admission.ts) plus its two call sites in resolveFeatureCompose,
// pinned by source: no harness drives resolveFeatureCompose past the planner without an LLM.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mod = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const outside = mod["testWritingDiffOutsideTests"] as undefined | ((composeMode: unknown, paths: string[]) => string[]);
const FC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf-8");

describe("test-writing compose: the diff is confined to test files", () => {
  test("[MUST-FAIL] a test_writing diff that touches src/foo.ts is refused (the offending path is named)", () => {
    expect(typeof outside).toBe("function");
    expect(outside!("test_writing", ["repos/development-vessel/test/a.test.ts", "repos/development-vessel/src/foo.ts"])).toEqual(["repos/development-vessel/src/foo.ts"]);
  });

  test("[MUST-FAIL] non-test files are refused in every path form: package.json, a nested src/test dir, a '..' escape, absolute runtime and clone paths", () => {
    expect(typeof outside).toBe("function");
    for (const p of [
      "repos/v/package.json",
      "repos/v/src/test/helpers.ts",
      "repos/v/test/../src/foo.ts",
      "/vessels/v/src/foo.ts",
      "/workspace/git/vessels/v/src/resolvers/x.ts",
      "src/foo.ts",
      "repos/v/src/foo.ts:120",
    ]) expect(outside!("test_writing", [p])).toEqual([p]);
  });

  test("[CONTROL] only test files proceed: test/x.test.ts, a co-located src/y.test.ts, a .spec file, a fixture under test/, absolute forms", () => {
    expect(typeof outside).toBe("function");
    expect(outside!("test_writing", [
      "repos/development-vessel/test/resolvers/x.test.ts",
      "repos/development-vessel/src/resolvers/gap-to-feature.test.ts",
      "repos/development-vessel/src/floor-tools.test.ts",
      "repos/v/src/a.spec.tsx",
      "repos/v/test/fixtures/data.json",
      "repos/v/tests/b.ts",
      "/vessels/v/test/c.test.ts",
      "/workspace/git/vessels/v/src/d.test.ts",
      "test/e.test.ts",
    ])).toEqual([]);
  });

  test("[CONTROL] an ordinary compose (no compose_mode, or any other value) is unaffected whatever it touches", () => {
    expect(typeof outside).toBe("function");
    for (const m of [undefined, null, "", "normal", "TEST_WRITING"]) expect(outside!(m, ["repos/v/src/foo.ts", "repos/v/package.json"])).toEqual([]);
  });

  test("[MUST-FAIL] wiring: resolveFeatureCompose refuses at PLAN time, after the file-scope gate and before any op is applied", () => {
    const scope = FC.indexOf("const scopeGate = fileScopeGate(ops, targetFiles);");
    const apply = FC.indexOf("const opGroups = new Map<string, number[]>();");
    const planGate = FC.indexOf("testWritingDiffOutsideTests((pointer as { compose_mode?: unknown }).compose_mode, ops.map((op) => op.path))");
    expect(scope).toBeGreaterThan(0);
    expect(planGate).toBeGreaterThan(scope);
    expect(planGate).toBeLessThan(apply);
    expect(FC.slice(planGate, planGate + 800)).toContain('stage: "test_writing_diff_outside_tests"');
  });

  test("[MUST-FAIL] wiring: the landing floor withholds FAVORABLE over every written path (applied ops and fc-repair writes) before the rollback and the cutover", () => {
    const floor = FC.indexOf("testWritingDiffOutsideTests((pointer as { compose_mode?: unknown }).compose_mode, [...applied.filter((a) => a.ok).map((a) => a.path), ...edited, ...created])");
    const land = FC.indexOf('if (verdict === "FAVORABLE" && pointer.land) {');
    const verdictDecl = FC.indexOf('let verdict: "FAVORABLE" | "UNFAVORABLE" = typecheckPass ? "FAVORABLE" : "UNFAVORABLE";');
    const rollback = FC.indexOf("// 4. ROLLBACK on UNFAVORABLE (restore edited, delete created) unless asked to keep.");
    expect(floor).toBeGreaterThan(verdictDecl);
    expect(floor).toBeLessThan(land);
    // A floor after the rollback step would leave the withheld edits on disk.
    expect(rollback).toBeGreaterThan(0);
    expect(floor).toBeLessThan(rollback);
    expect(FC.slice(floor, floor + 900)).toContain('verdict = "UNFAVORABLE"');
    expect(FC.slice(floor, floor + 900)).toContain("test_writing_diff_outside_tests");
  });

  test("[CONTROL] compose_mode is READ only by these two gates (besides the entry delete and the admission write)", () => {
    const sites = [...FC.matchAll(/\.compose_mode\b/g)].map((m) => FC.slice(Math.max(0, m.index! - 80), m.index! + 80));
    expect(sites.filter((s) => s.includes("testWritingDiffOutsideTests(")).length).toBe(2);
    expect(sites.filter((s) => s.includes("delete (pointer")).length).toBe(1);
    expect(sites.filter((s) => s.includes("compose_mode = csa.CHECK_SUPPLY_COMPOSE_MODE")).length).toBe(1);
    expect(sites.length).toBe(4);
  });
});
