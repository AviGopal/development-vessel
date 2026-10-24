// UNDER THE TEST PRELOAD, os.tmpdir() IS A PER-RUN DIRECTORY, NOT THE HOST'S /tmp (test/preload.ts).
//
// The node gate runs the whole suite inside the live container, and tests that make scratch with
// mkdtempSync(tmpdir()) and do not remove it left directories in the container's /tmp. The preload points TMPDIR at a
// fresh per-run directory before any import and removes it when the process exits.
// MUST-FAIL: tmpdir() is that per-run directory (named TEST_RUN_TMP_PREFIX + a random suffix, existing, equal to
//   TMPDIR). Red at the parent (no preload): tmpdir() is /tmp itself.
// CONTROL: mkdtempSync(join(tmpdir(), ...)) lands inside the per-run directory, so whatever a test leaves there goes
//   with it at exit.
import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const PREFIX = "dv-test-run-";

describe("test preload: per-run TMPDIR", () => {
  it("MUST-FAIL: os.tmpdir() is the per-run directory, not /tmp", () => {
    const t = tmpdir();
    expect({
      notSlashTmp: t !== "/tmp" && t !== "/tmp/",
      named: basename(t).startsWith(PREFIX) && basename(t).length > PREFIX.length,
      exists: existsSync(t),
      isTMPDIR: process.env["TMPDIR"] === t,
    }).toEqual({ notSlashTmp: true, named: true, exists: true, isTMPDIR: true });
  });

  it("CONTROL: scratch made under tmpdir() lands inside the per-run directory", () => {
    const d = mkdtempSync(join(tmpdir(), "scratch-"));
    try {
      expect(dirname(d)).toBe(tmpdir());
      expect(basename(dirname(d)).startsWith(PREFIX)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
