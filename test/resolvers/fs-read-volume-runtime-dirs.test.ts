/**
 * draft-activity-from-pattern's load_cluster must be able to read the cluster its feeder wrote.
 *
 * THE DEFECT THIS PINS. The pattern writers (trace-recurring-pattern-scan, vessel-arrival-scan)
 * write clusters to the volume dir /workspace/patterns and dispatch the drafter with that dir as
 * patterns_dir; the template's own default is the same dir. The drafter's first task opens
 * {{patterns_dir}}/{{pattern_id}}.json with fs_read, whose guard roots at WORKSPACE_ROOT, the
 * super-repo clone. So task 1 was refused "path outside workspace root" on every run and no
 * mined pattern ever became an activity. The failure-mode scenario queues on the volume
 * (FAILURE_MODE_SCENARIOS_DIR / FAILURE_MODE_VESSEL_SCENARIOS_DIR) were refused the same way, by
 * fs_read and by fs_list (the shared read guard in workspace-roots.ts).
 *
 * The test never writes the volume: the guard runs before the existence check, so an
 * allow_missing read of an absent volume file is refused by the guard at the old code and comes
 * back `missing: true` once the dir is a read root. The content leg reads a real cluster fixture
 * under a pinned tmp root and proves what load_cluster hands the prompt.
 *
 * Controls: the rest of the volume stays refused, and so do traversal and prefix tricks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, copyFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveFsRead } from "../../src/resolvers/fs-read.js";
import { resolveFsList } from "../../src/resolvers/fs-list.js";
import { resolveInAnyWorkspaceForRead } from "../../src/resolvers/workspace-roots.js";
import { DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE } from "../../src/seed/draft-activity-from-pattern.js";
import { FAILURE_MODE_SCENARIOS_DIR, FAILURE_MODE_VESSEL_SCENARIOS_DIR } from "../../src/config.js";

const PINNED = ["WORKSPACE_ROOT", "EXTRA_WORKSPACE_ROOTS", "FS_READ_EXTRA_ROOTS", "MITOSIS_RUNTIME_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

// Pin every env input the guards read. A MITOSIS_RUNTIME_DIR or extra root pointing at the volume
// would turn the red leg green on the unfixed code, so all of them are cleared.
beforeEach(() => {
  for (const k of PINNED) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fsread-volume-dirs-"));
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

const loadCluster = DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE.tasks.find((t) => t.id === "load_cluster")!;
const patternsDirDefault = DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE.variables!.find((v) => v.name === "patterns_dir")!
  .default as string;

/** The load_cluster task's fs_read config, interpolated the way the engine fills {{var}}. */
function loadClusterConfig(vars: { patterns_dir: string; pattern_id: string }): { type: "fs_read"; path: string } {
  const cfg = loadCluster.config as { type: "fs_read"; path: string };
  return {
    ...cfg,
    path: cfg.path.replace("{{patterns_dir}}", vars.patterns_dir).replace("{{pattern_id}}", vars.pattern_id),
  };
}

describe("draft-activity-from-pattern load_cluster reads the volume pattern dir", () => {
  test("MUST-FAIL: the template's own default patterns_dir passes the fs_read guard", async () => {
    expect(patternsDirDefault).toBe("/workspace/patterns");
    const cfg = loadClusterConfig({ patterns_dir: patternsDirDefault, pattern_id: "trace-pattern-00000000" });
    const r = await resolveFsRead({ ...cfg, allow_missing: true });
    expect(r.shape).toBe("fileContent");
    expect((r.body as { missing?: boolean }).missing).toBe(true);
  });

  test("content leg: a real cluster file flows through load_cluster as parseable JSON", async () => {
    copyFileSync(join(import.meta.dir, "../fixtures/patterns/trace-pattern-02e043f4.json"), join(root, "trace-pattern-02e043f4.json"));
    const r = await resolveFsRead(loadClusterConfig({ patterns_dir: root, pattern_id: "trace-pattern-02e043f4" }));
    const cluster = JSON.parse((r.body as { content: string }).content);
    expect(cluster.pattern_id).toBe("trace-pattern-02e043f4");
    expect(cluster.expected_outputs).toEqual(["uiFeedback_write"]);
    expect(cluster.producing_activities.length).toBeGreaterThan(0);
  });
});

describe("the failure-mode scenario queues on the volume are readable", () => {
  test("MUST-FAIL: fs_read of a scenario in the queue passes the guard", async () => {
    const r = await resolveFsRead({ type: "fs_read", path: `${FAILURE_MODE_SCENARIOS_DIR}/fixture-absent.json`, allow_missing: true });
    expect((r.body as { missing?: boolean }).missing).toBe(true);
  });

  test("MUST-FAIL: the shared read guard (fs_list, fs_grep) accepts the vessel-scenarios queue", () => {
    expect(resolveInAnyWorkspaceForRead(FAILURE_MODE_VESSEL_SCENARIOS_DIR, root)).toBe(FAILURE_MODE_VESSEL_SCENARIOS_DIR);
    expect(resolveInAnyWorkspaceForRead(`${FAILURE_MODE_SCENARIOS_DIR}/x.json`, root)).toBe(`${FAILURE_MODE_SCENARIOS_DIR}/x.json`);
  });
});

describe("CONTROL: nothing else on the volume becomes reachable", () => {
  const refused = [
    "/workspace/gaps/gaps.json",
    "/workspace/.substrate-private/anything",
    "/workspace/patterns/../gaps/gaps.json",
    "/workspace/patternsX/x.json",
    "/workspace/validation/failure-modes/schema.json",
    "/etc/passwd",
  ];
  for (const p of refused) {
    test(`fs_read refuses ${p}`, async () => {
      await expect(resolveFsRead({ type: "fs_read", path: p, allow_missing: true })).rejects.toThrow("path outside workspace root");
    });
    test(`the shared read guard refuses ${p}`, () => {
      expect(() => resolveInAnyWorkspaceForRead(p, root)).toThrow("path outside workspace root");
    });
  }

  test("fs_list still refuses the volume root itself", async () => {
    await expect(resolveFsList({ type: "fs_list", path: "/workspace" })).rejects.toThrow("path outside workspace root");
  });
});
