/**
 * A drafted gap-closing activity's write_report task must be able to write its report where the
 * report's readers look for it.
 *
 * THE DEFECT THIS PINS. draft-gap-closing-activity's prompt makes every drafted variant end with
 * TASK 4 write_report: fs_write to /workspace/proposals/<scenario_id>-report.json. That is the volume
 * proposals dir, which apply-proposal-as-patch, gap admission and the prior-attempt recalls scan for
 * *-report.json. fs_write's guard (resolveInAnyWorkspace) roots at WORKSPACE_ROOT, the super-repo
 * clone, plus EXTRA_WORKSPACE_ROOTS, and the proposals dir was only a READ root. So the last step of
 * every drafted variant failed "path outside workspace root" by construction, and each variant was
 * graded failed whatever its real work did. The drafter's own write_proposal / write_proposal_draft
 * tasks write the same dir and were refused the same way.
 *
 * Writing anywhere else would not help: the readers do not look there, and write containment refuses
 * the live super-repo clone outright. The proposals dir is a plain data dir that containment admits.
 *
 * The test never writes the volume: it checks both write guards (the root guard and containment) on
 * the exact paths the templates name, without touching disk.
 *
 * Controls: a read-only volume dir (the pattern clusters) stays unwritable, and a ../ escape out of
 * proposals, a path outside every root, and a proposals-prefixed look-alike stay refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { PATTERNS_DIR, PROPOSALS_DIR } from "../../src/config.js";
import { resolveInAnyWorkspace, resolveInAnyWorkspaceForRead } from "../../src/resolvers/workspace-roots.js";
import { assertWriteContained } from "../../src/resolvers/fs-write-containment.js";
import { DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE } from "../../src/seed/draft-gap-closing-activity.js";

const PINNED = ["WORKSPACE_ROOT", "EXTRA_WORKSPACE_ROOTS", "FS_READ_EXTRA_ROOTS", "MITOSIS_RUNTIME_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

// Pin every env input the guards read. An extra root pointing at the volume would turn the red leg
// green on the unfixed code, so all of them are cleared.
beforeEach(() => {
  for (const k of PINNED) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fswrite-proposals-dir-"));
  process.env["WORKSPACE_ROOT"] = root;
  delete process.env["EXTRA_WORKSPACE_ROOTS"];
  delete process.env["FS_READ_EXTRA_ROOTS"];
  delete process.env["MITOSIS_RUNTIME_DIR"];
});
afterEach(() => {
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const SCENARIO = "the-example-scenario";

/** The write_report path the drafter prompt tells every drafted variant to use, filled as the drafter is told to. */
function writeReportPath(): string {
  const draft = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) =>
    String((t.config as { prompt?: unknown }).prompt ?? "").includes("TASK 4 - write_report"),
  )!;
  const prompt = String((draft.config as { prompt: string }).prompt);
  const m = prompt.match(/TASK 4 - write_report \(fs_write\):\s*config: \{[^}]*"path": "([^"]+)"/);
  expect(m).not.toBeNull();
  return m![1]!.replace("<scenario_id>", SCENARIO);
}

/** The drafter's own fs_write task path, filled with the proposals_dir the dispatcher passes. */
function drafterTaskPath(id: string): string {
  const t = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((x) => x.id === id)!;
  return (t.config as { path: string }).path.replace("{{proposals_dir}}", PROPOSALS_DIR).replace("{{scenario_id}}", SCENARIO);
}

describe("drafted gap-closing write_report writes where its readers read", () => {
  test("MUST-FAIL: the prompt's write_report path passes fs_write's root guard", () => {
    const p = writeReportPath();
    expect(p).toBe(`/workspace/proposals/${SCENARIO}-report.json`);
    expect(resolveInAnyWorkspace(p, root)).toBe(p);
  });

  test("the report lands in the readers' dir, and write containment admits it", () => {
    const p = writeReportPath();
    expect(dirname(resolveInAnyWorkspace(p, root))).toBe(PROPOSALS_DIR);
    expect(() => assertWriteContained(p, p, undefined)).not.toThrow();
    expect(resolveInAnyWorkspaceForRead(p, root)).toBe(p);
  });

  test("MUST-FAIL: the drafter's own write_proposal and write_proposal_draft paths pass the guard", () => {
    for (const id of ["write_proposal", "write_proposal_draft"]) {
      const p = drafterTaskPath(id);
      expect(dirname(p)).toBe(PROPOSALS_DIR);
      expect(resolveInAnyWorkspace(p, root)).toBe(p);
    }
  });

  test("a relative path still resolves against WORKSPACE_ROOT, not the proposals dir", () => {
    expect(resolveInAnyWorkspace("x.json", root)).toBe(join(root, "x.json"));
  });
});

describe("CONTROL: nothing else becomes writable", () => {
  test("a read-only volume dir (pattern clusters) is readable but still refused for writes", () => {
    const p = `${PATTERNS_DIR}/x.json`;
    expect(resolveInAnyWorkspaceForRead(p, root)).toBe(p);
    expect(() => resolveInAnyWorkspace(p, root)).toThrow("path outside workspace root");
  });

  const refused = [
    "/workspace/proposals/../gaps/gaps.json", // escape out of proposals
    "/workspace/gaps/gaps.json", // outside every root
    "/workspace/proposals-evil/x.json", // prefix look-alike
  ];
  for (const p of refused) {
    test(`fs_write's guard refuses ${p}`, () => {
      expect(() => resolveInAnyWorkspace(p, root)).toThrow("path outside workspace root");
    });
  }
});
