// THE OWNED SET IS REAL, NOT SILENTLY EMPTY (gap-to-feature judge split, BOUNDARY.md 10 (c)).
//
// composer-interruption-sweep reads ownedVessels through a dynamic import of a module namespace and a
// `typeof fn === "function"` fallback: if the module it names does not export ownedVessels, the sweep gets an EMPTY
// owned set and reports "owned set unavailable" on every run, with no error anywhere. ownedVessels moved out of
// gap-to-feature into src/judge/gap-policy.ts, so a stale specifier is exactly that silent failure.
//
// This drives the real resolver: a fake `journalctl` on PATH prints restart-attribution lines. The fixture clone root
// holds two vessels: one this node owns, and one whose unit is MASKED here (a symlink to /dev/null), which
// ownedVessels must not count. The owned vessel's restart must be classified owned, and the masked one's foreign.
// The "owned set unavailable" report is the failure, and so is an owned set that claims every vessel.
// Mutants: point the sweep's import at a module without ownedVessels; make ownedVessels return every clone.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The sweep spawns `journalctl` by name, and Bun resolves a command against the PATH the process started with, so the
// fake journalctl only takes effect in a child process started with it: the resolver runs in a child bun.
const ROOT = join(tmpdir(), `cis-owned-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const BIN = join(ROOT, "bin");
const SWEEP = join(import.meta.dir, "..", "..", "src", "resolvers", "composer-interruption-sweep.ts");

beforeAll(() => {
  mkdirSync(join(ROOT, "vessels", "fixture-owned-vessel", ".git"), { recursive: true });
  mkdirSync(join(ROOT, "vessels", "fixture-masked-vessel", ".git"), { recursive: true });
  mkdirSync(join(ROOT, "units"), { recursive: true });
  symlinkSync("/dev/null", join(ROOT, "units", "fixture-masked-vessel.service"));
  mkdirSync(join(ROOT, "ws"), { recursive: true });
  mkdirSync(BIN, { recursive: true });
  const owned = "[restart-attribution] restarted by mitosis-cutover: cutover fixture-owned-vessel-fc-2026-10-10T00-00-00-000Z — it observed 1 in flight, so this restart was LOSSY";
  const foreign = "[restart-attribution] restarted by mitosis-cutover: cutover fixture-masked-vessel-fc-2026-10-10T00-05-00-000Z — it observed 0 in flight";
  writeFileSync(join(BIN, "journalctl"), `#!/bin/sh\necho '${owned}'\necho '${foreign}'\n`);
  chmodSync(join(BIN, "journalctl"), 0o755);
  writeFileSync(join(ROOT, "run.ts"), `const { resolveComposerInterruptionSweep } = await import(${JSON.stringify(SWEEP)});\nconst r = await resolveComposerInterruptionSweep({ type: "composerInterruptionReport", hours: 1 });\nconsole.log("REPORT " + JSON.stringify(r.body));\n`);
});
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe("composer-interruption-sweep reads a real owned set", () => {
  it("MUST-FAIL: an owned vessel's restart is classified owned and a masked vessel's foreign, never 'owned set unavailable'", () => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "run.ts")], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT, WORKSPACE_ROOT: join(ROOT, "ws"), VESSELS_CLONE_ROOT: join(ROOT, "vessels"), SYSTEMD_UNIT_DIRS: join(ROOT, "units"), SUBSTRATE_NAME: "fixture-node" },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const out = new TextDecoder().decode(p.stdout);
    const line = out.split("\n").find((l) => l.startsWith("REPORT "));
    expect(line, new TextDecoder().decode(p.stderr).slice(0, 2000)).toBeDefined();
    const body = JSON.parse(line!.slice("REPORT ".length)) as Record<string, unknown>;
    expect(body["detail"]).not.toBe("owned set unavailable");
    expect(body["lines_read"]).toBe(2);
    expect(body["restarts"]).toBe(2);
    expect(body["foreign_cutovers"]).toBe(1);
    expect(body["lossy"]).toBe(1);
    const entries = body["entries"] as Array<{ vessel?: string; foreign_cutover: boolean }>;
    expect(entries.map((e) => [e.vessel, e.foreign_cutover])).toEqual([["fixture-owned-vessel", false], ["fixture-masked-vessel", true]]);
  });
});
