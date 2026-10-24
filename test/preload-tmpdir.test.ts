// UNDER THE TEST PRELOAD, os.tmpdir() IS A PER-RUN DIRECTORY, NOT THE HOST'S /tmp (test/preload.ts).
//
// The node gate runs the whole suite inside the live container, and tests that make scratch with
// mkdtempSync(tmpdir()) and do not remove it left directories in the container's /tmp. The preload points TMPDIR, before
// any import, at the run's scratch WORKSPACE_ROOT when it has one inside the tmp root (the gate's scrubbed env does, and
// removes it after the run), else at a fresh directory it removes when the process exits.
// MUST-FAIL: tmpdir() is that per-run directory: equal to TMPDIR, existing, strictly inside the tmp root the process
//   started with, and (by source) the scratch WORKSPACE_ROOT or a TEST_RUN_TMP_PREFIX directory. Red at the parent (no
//   preload): there is no per-run directory, tmpdir() is the tmp root itself.
// CONTROL: mkdtempSync(join(tmpdir(), ...)) lands inside the per-run directory, so whatever a test leaves there goes
//   with it.
import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const loadPreloadInfo = async (): Promise<{ dir: string; startTmp: string; source: string } | null> => {
  try { return ((await import("./preload.js")) as { TEST_RUN_TMP?: { dir: string; startTmp: string; source: string } }).TEST_RUN_TMP ?? null; } catch { return null; }
};

describe("test preload: per-run TMPDIR", () => {
  it("MUST-FAIL: os.tmpdir() is the per-run directory, not the tmp root", async () => {
    const info = await loadPreloadInfo();
    expect(info).not.toBeNull();
    if (!info) return;
    const t = resolve(tmpdir());
    expect({
      isRunDir: t === info.dir,
      isTMPDIR: process.env["TMPDIR"] === t,
      exists: existsSync(t),
      insideStartTmp: t.startsWith(info.startTmp + sep),
      bySource: info.source === "workspace_root" ? t === resolve(process.env["WORKSPACE_ROOT"] ?? "") : basename(t).startsWith("dv-test-run-"),
    }).toEqual({ isRunDir: true, isTMPDIR: true, exists: true, insideStartTmp: true, bySource: true });
  });

  it("CONTROL: scratch made under tmpdir() lands inside the per-run directory", () => {
    const d = mkdtempSync(join(tmpdir(), "scratch-"));
    try {
      expect(dirname(d)).toBe(resolve(tmpdir()));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
