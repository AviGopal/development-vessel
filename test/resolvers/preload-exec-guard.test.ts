// UNDER THE TEST PRELOAD, A HOST-LIFECYCLE SPAWN THROWS FOR EVERY FILE (test/preload.ts, bunfig.toml [test] preload).
//
// The node gate runs the whole suite inside the live container, so the exec guard can no longer be opt-in: this file
// installs nothing itself, and relies only on the preload.
// MUST-FAIL: Bun.spawnSync and Bun.spawn of a program named systemctl or journalctl (a stand-in at an absolute tmp path
//   that writes a marker when it runs) throw EPERM, the stand-in never runs, and the preload's guard recorded each.
//   Red at the parent (no preload): the stand-in runs and writes its marker.
// MUST-FAIL: the bare names systemctl and journalctl throw too. Run ONLY once the guard is proven installed, so a run
//   without the preload fails at that precondition and never spawns the real tools.
// CONTROL: a non-blocked program (sh -c echo) passes through unchanged, and a file's own opt-in guard stacks on the
//   preload's and restores back to it, never to the unguarded spawn.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as execGuard from "./cutover-exec-guard.js";

// Read through the namespace so that, on a tree without the preload's exports, the file still runs and shows what an
// unguarded spawn does (the stand-in runs) instead of failing at import.
const G = execGuard as unknown as Partial<typeof execGuard>;
const preloadExecGuard = () => G.preloadExecGuard?.() ?? null;
const takePreloadExecViolations = () => G.takePreloadExecViolations?.() ?? [];
const { installCutoverExecGuard } = execGuard;

const ROOT = join(tmpdir(), `preload-exec-guard-${process.pid}-${Math.random().toString(36).slice(2)}`);
const MARK = join(ROOT, "ran");
const standIn = (name: string) => join(ROOT, "bin", name);

beforeAll(() => {
  mkdirSync(join(ROOT, "bin"), { recursive: true });
  for (const name of ["systemctl", "journalctl"]) {
    writeFileSync(standIn(name), `#!/bin/sh\necho "${name} $*" >> "${MARK}"\n`);
    chmodSync(standIn(name), 0o755);
  }
});
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

const throwsBlocked = (f: () => unknown): string => {
  try { f(); return "ran"; } catch (e) { return String((e as NodeJS.ErrnoException).code ?? e); }
};

describe("test preload: blocked host-lifecycle spawns", () => {
  // The preload records every blocked spawn in one process-wide array and nothing drains it between files, so each
  // test starts by discarding what earlier files left there and counts only its own.
  beforeEach(() => { takePreloadExecViolations(); });

  it("MUST-FAIL: Bun.spawnSync and Bun.spawn of systemctl/journalctl throw EPERM, nothing runs, each is recorded", () => {
    const got = {
      spawnSyncSystemctl: throwsBlocked(() => Bun.spawnSync([standIn("systemctl"), "is-active", "development-vessel"], { stdout: "pipe", stderr: "pipe" })),
      spawnSyncJournalctl: throwsBlocked(() => Bun.spawnSync([standIn("journalctl"), "-u", "development-vessel", "-n", "1"], { stdout: "pipe", stderr: "pipe" })),
      spawnJournalctl: throwsBlocked(() => Bun.spawn([standIn("journalctl"), "--no-pager"], { stdout: "pipe", stderr: "pipe" })),
    };
    Bun.sleepSync(200); // an unguarded Bun.spawn would have written its marker by now
    const recorded = takePreloadExecViolations();
    expect({ got, standInRan: existsSync(MARK), recorded: recorded.length }).toEqual({
      got: { spawnSyncSystemctl: "EPERM", spawnSyncJournalctl: "EPERM", spawnJournalctl: "EPERM" },
      standInRan: false,
      recorded: 3,
    });
  });

  it("MUST-FAIL: the bare names systemctl and journalctl throw (spawned only once the guard is proven installed)", () => {
    expect(preloadExecGuard()).not.toBeNull();
    if (!preloadExecGuard()) return;
    const got = [
      throwsBlocked(() => Bun.spawnSync(["systemctl", "is-active", "development-vessel"], { stdout: "pipe", stderr: "pipe" })),
      throwsBlocked(() => Bun.spawnSync(["journalctl", "-u", "development-vessel", "-n", "1", "--no-pager"], { stdout: "pipe", stderr: "pipe" })),
    ];
    expect({ got, recorded: takePreloadExecViolations().length }).toEqual({ got: ["EPERM", "EPERM"], recorded: 2 });
  });

  it("CONTROL: a non-blocked program passes through; an opt-in guard stacks on the preload and restores to it", () => {
    expect(preloadExecGuard()).not.toBeNull();
    if (!preloadExecGuard()) return;
    const echo = Bun.spawnSync(["sh", "-c", "echo ok"], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(echo.stdout).trim()).toBe("ok");
    const own = installCutoverExecGuard();
    own.route({ name: "is-active", match: (c) => c.includes("is-active"), respond: () => ({ exitCode: 0, stdout: "active\n" }) });
    const routed = new TextDecoder().decode(Bun.spawnSync(["systemctl", "is-active", "x"], { stdout: "pipe" }).stdout).trim();
    expect({ routed, own: own.restore() }).toEqual({ routed: "active", own: [] });
    // after the opt-in restore the PRELOAD's guard is back, not the unguarded spawn
    expect(throwsBlocked(() => Bun.spawnSync([standIn("systemctl"), "status"], { stdout: "pipe", stderr: "pipe" }))).toBe("EPERM");
    expect({ standInRan: existsSync(MARK), recorded: takePreloadExecViolations().length }).toEqual({ standInRan: false, recorded: 1 });
  });
});
