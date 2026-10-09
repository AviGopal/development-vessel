// A TEST-WRITING COMPOSE LANDS ITS ONE CHECK FILE ONLY (check-first; slice G revision R3, narrowed by B′ P1).
//
// Slice G admits a gap-check-supply compose of an UNARMED gap as compose_mode "test_writing". Such a compose runs
// land:true with no falsifier of its own, and nothing confined its diff: "Do not change src/." is goal prose, which
// the drafter can ignore. R3 confined it to test paths. B′ narrows it to ONE path: the supply's test-writing goal
// writes an OUT-OF-SUITE check, test/checks/<checkSupplyCheckFile(gap id)>, which bun's default discovery ignores
// (*.check.ts is not a *.test.* name), so the intended red never reaches the pre-cutover suite, the post-land suite or
// pull-sync. A red landed in a discovered *.test.ts would read as a regression everywhere; a write to any other test
// file is outside what the supply asked for.
//
// THE RULE (testWritingDiffOutsideTests(compose_mode, paths, gap_id)). A path is resolved to its vessel-relative form
// (after /workspace/git/compose/<compose-id>/<vessel>/ for an isolated compose worktree, after repos/<vessel>/, or
// after .../vessels/<vessel>/ for an absolute runtime or clone path; a bare relative path is taken as vessel-relative). In compose_mode "test_writing" the ONLY path that may be written is exactly
// test/checks/<checkSupplyCheckFile(gap_id)>. Every other path is refused: another gap's check file, any *.test.ts
// (under test/ or co-located in src/), fixtures, src, package.json, config, '..' paths. No gap id ⇒ nothing is
// allowed (fail closed). Which vessel a path may touch stays the verify_vessels gate's job.
//
// CONTRACT pinned here:
//   - compose_mode "test_writing" + any other path => refused, named stage test_writing_diff_outside_tests, listing the
//     paths; at PLAN time (before any op is applied) and again at the landing floor over every path the compose wrote
//     (applied ops and fc-repair writes), so a repair cannot widen the diff. Both sites pass the compose's gap id (pointer.gap.id).
//   - CONTROLS: exactly test/checks/<id>.check.ts proceeds, in every path form; an ordinary compose (no compose_mode)
//     is unaffected whatever it touches.
//
// SEAM: the gate is a pure function (check-supply-admission.ts) plus its two call sites in resolveFeatureCompose,
// pinned by source: no harness drives resolveFeatureCompose past the planner without an LLM.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mod = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const outside = mod["testWritingDiffOutsideTests"] as undefined | ((composeMode: unknown, paths: string[], gapId?: unknown) => string[]);
const checkFile = mod["checkSupplyCheckFile"] as undefined | ((gapId: string) => string);
const FC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf-8");

const GAP = "gap-Env_gated SF.discount";
const CHECK = "test/checks/gap-env-gated-sf-discount.check.ts";
const COMPOSE = "/workspace/git/compose/fc-mv04xoq8-muxfq1/development-vessel";

describe("checkSupplyCheckFile: one check file name per gap id, defined once", () => {
  test("[MUST-FAIL] the slug is the gap id lower-cased with every non-alphanumeric run as '-', suffix .check.ts", () => {
    expect(typeof checkFile).toBe("function");
    expect(checkFile!(GAP)).toBe("gap-env-gated-sf-discount.check.ts");
    expect(checkFile!("--A::b--")).toBe("a-b.check.ts");
    expect(checkFile!("::")).toBe("unnamed.check.ts");
    // bounded: 60 slug characters at most, never ending in '-'
    const long = checkFile!("x".repeat(59) + "-yz" + "q".repeat(100));
    expect(long.length).toBeLessThanOrEqual(60 + ".check.ts".length);
    expect(long).not.toMatch(/-\.check\.ts$/);
  });
});

describe("test-writing compose: the diff is confined to the gap's one check file", () => {
  test("[MUST-FAIL] a test_writing diff touching src/x.ts, test/foo.test.ts or ANOTHER gap's check file is refused (each named)", () => {
    expect(typeof outside).toBe("function");
    const other = "repos/development-vessel/test/checks/some-other-gap.check.ts";
    const paths = [`repos/development-vessel/${CHECK}`, "repos/development-vessel/src/x.ts", "repos/development-vessel/test/foo.test.ts", other];
    expect(outside!("test_writing", paths, GAP)).toEqual(["repos/development-vessel/src/x.ts", "repos/development-vessel/test/foo.test.ts", other]);
  });

  test("[MUST-FAIL] every other test path is refused too: co-located src/*.test.ts, a .spec, a fixture under test/, tests/, a nested checks dir", () => {
    expect(typeof outside).toBe("function");
    for (const p of [
      "repos/development-vessel/test/resolvers/x.test.ts",
      "repos/development-vessel/src/resolvers/gap-to-feature.test.ts",
      "repos/v/src/a.spec.tsx",
      "repos/v/test/fixtures/data.json",
      "repos/v/tests/b.ts",
      `repos/v/test/checks/sub/${checkFile ? checkFile(GAP) : "x"}`,
      `repos/v/src/${CHECK}`,
      `repos/v/test/checks/${checkFile ? checkFile(GAP).replace(/\.check\.ts$/, ".test.ts") : "x"}`,
    ]) expect(outside!("test_writing", [p], GAP)).toEqual([p]);
  });

  test("[MUST-FAIL] non-test files are refused in every path form: package.json, a src/test dir, a '..' escape, absolute runtime and clone paths", () => {
    expect(typeof outside).toBe("function");
    for (const p of [
      "repos/v/package.json",
      "repos/v/src/test/helpers.ts",
      `repos/v/test/checks/../../src/foo.ts`,
      `repos/v/${CHECK}/../x.ts`,
      "/vessels/v/src/foo.ts",
      "/workspace/git/vessels/v/src/resolvers/x.ts",
      "src/foo.ts",
      "repos/v/src/foo.ts:120",
    ]) expect(outside!("test_writing", [p], GAP)).toEqual([p]);
  });

  test("[MUST-FAIL] no gap id (or an empty one) allows nothing: fail closed", () => {
    expect(typeof outside).toBe("function");
    for (const id of [undefined, null, "", 7]) expect(outside!("test_writing", [`repos/v/${CHECK}`], id)).toEqual([`repos/v/${CHECK}`]);
  });

  test("[CONTROL] exactly test/checks/<checkSupplyCheckFile(gap id)> proceeds, in every path form", () => {
    expect(typeof outside).toBe("function");
    expect(outside!("test_writing", [
      `repos/development-vessel/${CHECK}`,
      `/vessels/development-vessel/${CHECK}`,
      `/workspace/git/vessels/development-vessel/${CHECK}`,
      `${COMPOSE}/${CHECK}`,
      CHECK,
      `./${CHECK}`,
    ], GAP)).toEqual([]);
  });

  // An isolated compose (compose-workspace.ts acquireComposeWorkspace) writes under WS_ROOT/<compose-id>/<vessel>/, and the
  // landing floor passes those created[] paths as they are. Observed 10-08: the gap's own check in that form was refused.
  test("[MUST-FAIL] the compose-worktree form is resolved exactly: /workspace/git/compose/<compose-id>/<vessel>/<rest>, two single segments", () => {
    expect(typeof outside).toBe("function");
    for (const p of [
      // src, and another gap's check, in compose form
      "/workspace/git/compose/fc-x/development-vessel/src/a.ts",
      `${COMPOSE}/test/checks/some-other-gap.check.ts`,
      // '..' in a segment slot the root consumes (resolves outside the compose root) and in the rest
      `/workspace/git/compose/../development-vessel/${CHECK}`,
      `/workspace/git/compose/fc-x/../${CHECK}`,
      `${COMPOSE}/test/checks/../../${CHECK}`,
      // ONE segment is not a worktree root (roots are always <compose-id>/<vessel>): the two segments peeled are
      // development-vessel and test, so the rest is checks/<file>, which is not the gap's check.
      `/workspace/git/compose/development-vessel/${CHECK}`,
      // a nested repos/<x>/ inside the worktree is not a vessel root: the compose root is anchored and read first
      `${COMPOSE}/src/repos/x/${CHECK}`,
    ]) expect(outside!("test_writing", [p], GAP)).toEqual([p]);
    // Last, so every refusal above is evaluated even where the root is mis-peeled (the CONTROL above pins it too).
    expect(outside!("test_writing", [`${COMPOSE}/${CHECK}`], GAP)).toEqual([]);
  });

  test("[MUST-FAIL] W2's edit site resolves the compose-worktree form too (vesselRelativeEditSite)", () => {
    const rel = mod["vesselRelativeEditSite"] as (s: unknown) => string | null;
    expect(rel(`${COMPOSE}/src/resolvers/a.ts:12`)).toBe("src/resolvers/a.ts");
    expect(rel("repos/development-vessel/src/resolvers/a.ts")).toBe("src/resolvers/a.ts");
  });

  test("[CONTROL] an ordinary compose (no compose_mode, or any other value) is unaffected whatever it touches", () => {
    expect(typeof outside).toBe("function");
    for (const m of [undefined, null, "", "normal", "TEST_WRITING"]) expect(outside!(m, ["repos/v/src/foo.ts", "repos/v/package.json", "repos/v/test/a.test.ts"], GAP)).toEqual([]);
  });

  test("[MUST-FAIL] wiring: resolveFeatureCompose refuses at PLAN time with the gap id, after the file-scope gate and before any op is applied", () => {
    const scope = FC.indexOf("const scopeGate = fileScopeGate(ops, targetFiles);");
    const apply = FC.indexOf("const opGroups = new Map<string, number[]>();");
    const planGate = FC.indexOf("testWritingDiffOutsideTests((pointer as { compose_mode?: unknown }).compose_mode, ops.map((op) => op.path), pointer.gap?.id)");
    expect(scope).toBeGreaterThan(0);
    expect(planGate).toBeGreaterThan(scope);
    expect(planGate).toBeLessThan(apply);
    expect(FC.slice(planGate, planGate + 800)).toContain('stage: "test_writing_diff_outside_tests"');
  });

  test("[MUST-FAIL] wiring: the landing floor withholds FAVORABLE over every written path, with the gap id, before the rollback and the cutover", () => {
    const floor = FC.indexOf("testWritingDiffOutsideTests((pointer as { compose_mode?: unknown }).compose_mode, [...applied.filter((a) => a.ok).map((a) => a.path), ...edited, ...created], pointer.gap?.id)");
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

  test("[MUST-FAIL] wiring: the gap id both sites pass is the compose's own pointer.gap.id, the id admission verified (_gapIdForSlot)", () => {
    expect(FC).toContain("const _gapIdForSlot = typeof (pointer.gap as { id?: unknown } | undefined)?.id === \"string\" ? String((pointer.gap as { id: string }).id) : undefined;");
    expect([...FC.matchAll(/testWritingDiffOutsideTests\([^\n]*, pointer\.gap\?\.id\)/g)].length).toBe(2);
  });

  test("[MUST-FAIL] compose_mode is READ only by the two R3 gates and the verify's one testWritingMode read (besides the entry delete and the admission write)", () => {
    const sites = [...FC.matchAll(/\.compose_mode\b/g)].map((m) => FC.slice(Math.max(0, m.index! - 80), m.index! + 80));
    expect(sites.filter((s) => s.includes("testWritingDiffOutsideTests(")).length).toBe(2);
    expect(sites.filter((s) => s.includes("const testWritingMode = (pointer")).length).toBe(1);
    expect(sites.filter((s) => s.includes("delete (pointer")).length).toBe(1);
    expect(sites.filter((s) => s.includes("compose_mode = csa.CHECK_SUPPLY_COMPOSE_MODE")).length).toBe(1);
    expect(sites.length).toBe(5);
  });
});
