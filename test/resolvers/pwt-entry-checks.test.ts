// patch_with_tools' ENTRY CHECKS (patch-with-tools.ts resolvePatchWithTools; gates/test-file-gates.ts testFileWriteVerdict).
//   [MUST-FAIL] a test-file target is refused before anything runs unless its row was localized to exactly that file,
//               a missing row included ("no localization row"); a "<gap>-compose" id names <gap>.
//   [MUST-FAIL] a pointer with no vessels_root runs in an isolated compose worktree, never the running tree: with no
//               worktree it is refused; with one, the run reads that root, and the worktree is released after.
//   [CONTROL]   a target that is not a test file is not this check's; an admitted target carries its verdict.
//   The result keeps the landing fields the walk's landing guard reads (landed, new_git_sha).
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rowIdOf, testFileWriteVerdict } from "../../src/gates/test-file-gates.js";
import { __setPwtEntryDepsForTests, resolvePatchWithTools } from "../../src/resolvers/patch-with-tools.js";

const V = "demo-vessel";
const TEST = "test/demo.test.ts";
const localized = (file = TEST): Record<string, unknown> => ({
  edit_site: `repos/${V}/${file}`,
  test_defect: { decision_id: "test-defect-localization-demo-1", certifier: { shape: "test_defect_child_parse", vessel: V, test_file: file } },
});
afterEach(() => __setPwtEntryDepsForTests(null));

describe("the test-file verdict (pure)", () => {
  it("a <gap>-compose id names <gap>", () => {
    expect(rowIdOf("g-1-compose")).toBe("g-1");
    expect(rowIdOf("g-1")).toBe("g-1");
  });
  it("[CONTROL] a target that is not a test file is not this check's", () => {
    expect(testFileWriteVerdict(V, "src/x.ts", null, null).verdict).toBe("not_applicable");
  });
  it("[MUST-FAIL] a test-file target with no row is refused: no localization row", () => {
    expect(testFileWriteVerdict(V, TEST, null, null)).toMatchObject({ verdict: "refused", reason: expect.stringContaining("no localization row (no gap_id)") });
    expect(testFileWriteVerdict(V, TEST, null, "g-1")).toMatchObject({ verdict: "refused", reason: expect.stringContaining("no localization row (g-1 not found)") });
  });
  it("[MUST-FAIL] a row localized elsewhere, or whose edit_site does not allow the file, is refused", () => {
    expect(testFileWriteVerdict(V, "test/other.test.ts", localized(), "g-1")).toMatchObject({ verdict: "refused", reason: expect.stringContaining("certifier does not name it") });
    expect(testFileWriteVerdict(V, TEST, { ...localized(), edit_site: `repos/${V}/src/x.ts` }, "g-1")).toMatchObject({ verdict: "refused", reason: expect.stringContaining("edit_site does not allow it") });
    expect(testFileWriteVerdict(V, TEST, { ...localized(), protected_files: [`repos/${V}/${TEST}`] }, "g-1").verdict).toBe("refused");
  });
  it("[CONTROL] the row's localized test file is admitted, with its localization record", () => {
    expect(testFileWriteVerdict(V, TEST, localized(), "g-1")).toEqual({ verdict: "admitted", reason: expect.any(String), gap_id: "g-1", localization_record_id: "test-defect-localization-demo-1" });
  });
});

describe("the entry checks (resolvePatchWithTools)", () => {
  const pointer = (over: Record<string, unknown> = {}) => ({ type: "patch_with_tools" as const, proposal_text: "x", target_file: `repos/${V}/${TEST}`, ...over });

  it("[MUST-FAIL] a test-file target whose row is not localized is refused before isolation or any read", async () => {
    let isolated = 0;
    __setPwtEntryDepsForTests({ readGap: async () => null, isolate: async () => { isolated++; return null; } });
    const r = await resolvePatchWithTools(pointer({ gap_id: "g-1-compose" }) as never);
    expect(r.shape).toBe("structuredError");
    expect(r.body).toMatchObject({ stage: "test_file_check", verdict: "REFUSED", test_file_check: { verdict: "refused", gap_id: "g-1" } });
    expect(isolated).toBe(0);
  });

  it("[MUST-FAIL] no vessels_root and no isolated worktree: refused, never run on the running tree", async () => {
    const asked: string[] = [];
    __setPwtEntryDepsForTests({ isolate: async (t) => { asked.push(t); return null; } });
    const r = await resolvePatchWithTools(pointer({ target_file: `repos/${V}/src/x.ts` }) as never);
    expect(asked).toEqual([`repos/${V}/src/x.ts`]);
    expect(r.body).toMatchObject({ stage: "isolation_unavailable", verdict: "REFUSED" });
  });

  it("[MUST-FAIL] no vessels_root: the run reads the isolated root (not /vessels), and the worktree is released after", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwt-iso-"));
    let released = 0;
    __setPwtEntryDepsForTests({ isolate: async () => ({ vesselsRoot: root, release: async () => { released++; } }) });
    const r = await resolvePatchWithTools(pointer({ target_file: `repos/${V}/src/x.ts`, workspace_root: root }) as never);
    const text = JSON.stringify(r.body);
    expect(text).toContain(root);
    expect(text).not.toContain("/vessels/");
    expect(released).toBe(1);
  });

  it("[CONTROL] an explicit vessels_root is used as given; no isolation is asked for", async () => {
    let isolated = 0;
    const root = mkdtempSync(join(tmpdir(), "pwt-given-"));
    __setPwtEntryDepsForTests({ isolate: async () => { isolated++; return null; } });
    await resolvePatchWithTools(pointer({ target_file: `repos/${V}/src/x.ts`, vessels_root: root, workspace_root: root }) as never);
    expect(isolated).toBe(0);
  });

  it("the release sits in a finally, and a landed result carries the fields the walk's landing guard reads", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "patch-with-tools.ts"), "utf8");
    expect(src).toMatch(/\} finally \{\n\s+if \(release\) await release\(\)/);
    expect(src).toContain("landed: _landing.landed,");
    expect(src).toContain("new_git_sha: _landing.new_git_sha,");
  });
});
