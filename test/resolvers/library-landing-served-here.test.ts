// A library landing is served through its consumers, not through a unit of its own (CHANGE-01).
//
// landedCommitRunningHere maps the clone that contains a landed commit to a systemd unit of the same name. A library
// (ias-executor-ts, any package consumed through its built dist) has no such unit, so every library landing read
// "not served here" on every node, forever. pull-sync's last-good pin is the served code for a library (written only
// after every consumer is healthy and its shipped dist is byte-identical to the shared build).
//
// Hermetic: a temp clone root (VESSELS_CLONE_ROOT) with one real two-commit git repo; systemd and the last-good pin come
// from the reader's existing deps seam (__setAutoRevertDepsForTests), never from the live host.
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const ROOT = mkdtempSync(join(tmpdir(), "library-served-here-"));
const VESSEL = "fixture-library";
const savedRoot = process.env["VESSELS_CLONE_ROOT"];
let OLD = "", NEW = "";
let mod: typeof import("../../src/judge/gap-landing-verdict.js");

const git = (args: string[]): string => {
  const r = spawnSync("git", ["-C", join(ROOT, VESSEL), ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeAll(async () => {
  mkdirSync(join(ROOT, VESSEL, "src"), { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "fixture"]);
  writeFileSync(join(ROOT, VESSEL, "src", "engine.ts"), "export const v = 1;\n");
  git(["add", "."]); git(["commit", "-q", "-m", "old"]);
  OLD = git(["rev-parse", "HEAD"]);
  writeFileSync(join(ROOT, VESSEL, "src", "engine.ts"), "export const v = 2;\n");
  git(["add", "."]); git(["commit", "-q", "-m", "new"]);
  NEW = git(["rev-parse", "HEAD"]);
  process.env["VESSELS_CLONE_ROOT"] = ROOT;
  mod = await import("../../src/judge/gap-landing-verdict.js");
});
// SYSTEMD THROUGH A STUB, never the real tool (the test preload blocks systemctl in the live container). The unit-backed
// case reads `systemctl list-units --all --plain --no-legend mitosis-self-restart-*`; this node's systemd printed
// nothing, exit 0 (no self-restart owed), when the file was green before the preload.
let execGuard: ExecGuard;
beforeEach(() => {
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "self-restart-units", match: (c) => c === "systemctl list-units --all --plain --no-legend mitosis-self-restart-*", respond: () => ({ exitCode: 0, stdout: "" }) });
});
afterEach(() => {
  mod.__setAutoRevertDepsForTests(null);
  const unrouted = execGuard.restore();
  if (unrouted.length > 0) throw new Error(`unrouted systemd call(s): ${unrouted.join("; ")}`);
});
afterAll(() => {
  restoreCutoverExecModules();
  if (savedRoot === undefined) delete process.env["VESSELS_CLONE_ROOT"]; else process.env["VESSELS_CLONE_ROOT"] = savedRoot;
  rmSync(ROOT, { recursive: true, force: true });
});

const noUnit = (lastGood: string | null) => ({
  unitLoadState: () => "not-found",
  lastGood: () => lastGood,
  // what `systemctl is-active <name>` prints for a unit that does not exist (it does not throw)
  unitActive: () => "inactive",
  unitStartedAt: () => 0,
});

describe("a library landing settles when pull-sync has propagated it", () => {
  it("(i) a library whose last-good pin covers the landed sha is running", async () => {
    mod.__setAutoRevertDepsForTests(noUnit(NEW));
    expect(await mod.__landedCommitRunningHereForTests(NEW)).toBe("running");
    mod.__setAutoRevertDepsForTests(noUnit(NEW));
    expect(await mod.__landedCommitRunningHereForTests(OLD)).toBe("running");
  });

  it("(ii) [MUST-FAIL] a library whose last-good is older, or absent, is awaiting restart, never 'not served here'", async () => {
    mod.__setAutoRevertDepsForTests(noUnit(OLD));
    expect(await mod.__landedCommitRunningHereForTests(NEW)).toBe("awaiting restart");
    mod.__setAutoRevertDepsForTests(noUnit(null));
    expect(await mod.__landedCommitRunningHereForTests(NEW)).toBe("awaiting restart");
  });

  it("(iii) a masked unit (it exists, inactive) is still not served here, whatever the last-good pin says", async () => {
    mod.__setAutoRevertDepsForTests({ unitLoadState: () => "masked", lastGood: () => NEW, unitActive: () => "inactive", unitStartedAt: () => 0 });
    expect(await mod.__landedCommitRunningHereForTests(NEW)).toBe("not served here");
  });

  it("(iv) a unit-backed vessel is judged by its unit as before: active and restarted after the commit is running; an older start is awaiting restart", async () => {
    const committedAt = Number(git(["log", "-1", "--format=%ct", NEW]));
    mod.__setAutoRevertDepsForTests({ unitLoadState: () => "loaded", lastGood: () => null, unitActive: () => "active", unitStartedAt: () => committedAt + 10 });
    expect(await mod.__landedCommitRunningHereForTests(NEW)).toBe("running");
    mod.__setAutoRevertDepsForTests({ unitLoadState: () => "loaded", lastGood: () => null, unitActive: () => "active", unitStartedAt: () => committedAt - 10 });
    expect(await mod.__landedCommitRunningHereForTests(NEW)).toBe("awaiting restart");
    mod.__setAutoRevertDepsForTests({ unitLoadState: () => "loaded", lastGood: () => NEW, unitActive: () => "inactive", unitStartedAt: () => committedAt + 10 });
    expect(await mod.__landedCommitRunningHereForTests(NEW)).toBe("not served here");
  });
});
