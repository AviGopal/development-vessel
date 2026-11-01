// A TEST THAT CAN REACH THE SHAPED POLICIES TAKES ITS OWN POLICIES DIRECTORY (class detector).
//
// signal-window.ts shapedPolicyPath resolves every shaped policy to <super>/policies/<name>.json, where <super> is the
// first git checkout among SUPER_REPO_DIR, MITOSIS_SUPER_REPO_DIR and the hard-coded live clone /workspace/git/super-repo
// (write-containment.ts containmentZones). pull-sync's scrubbed env sets none of those names, so in the gate (and in any
// run on a node) a test that reaches the reader with no location of its own reads the LIVE clone's policies. The
// check-supply tick reads ownCheckEnvironmentPolicy (gap-check-supply.ts dispatchOwnCheckBaselines): once a live
// policy names a non-zero own_check_baseline_per_tick, such a test would dispatch baselines from that host.
//
// The class, as a static predicate over every test file in the vessel:
//   it drives the tick or the reader (resolveGapCheckSupplyTick / dispatchOwnCheckBaselines / readOwnCheckEnvPolicy),
//   AND it neither assigns process.env SUPER_REPO_DIR nor injects an env carrying SUPER_REPO_DIR.
// A file in the class must be fixed (point SUPER_REPO_DIR at a temp checkout of its own, restored after).
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const VESSEL = join(import.meta.dir, "..");
const SELF = relative(VESSEL, import.meta.path);

const DRIVES = new RegExp(`\\b(${["resolveGapCheckSupply" + "Tick", "dispatchOwnCheck" + "Baselines", "readOwnCheck" + "EnvPolicy"].join("|")})\\s*\\(`);
const ASSIGNS = /process\.env(\.SUPER_REPO_DIR|\[["']SUPER_REPO_DIR["']\])\s*=[^=]/;
const INJECTS = /\bSUPER_REPO_DIR\s*:/;

function unisolated(text: string): boolean {
  return DRIVES.test(text) && !ASSIGNS.test(text) && !INJECTS.test(text);
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "fixtures") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (/\.test\.(ts|js)$/.test(e)) out.push(p);
  }
  return out;
}

describe("a test that reaches the shaped policies reads its own policies directory", () => {
  it("CONTROL the predicate flags a tick driver with no location and passes one with either form", () => {
    const tick = "await supply.resolveGapCheckSupply" + "Tick({ type: \"gap_check_supply_tick\" });";
    expect(unisolated(tick)).toBe(true);
    expect(unisolated(`process.env["SUPER_REPO_DIR"] = join(ROOT, "policy-super");\n${tick}`)).toBe(false);
    expect(unisolated(`process.env.SUPER_REPO_DIR = SUPER;\n${tick}`)).toBe(false);
    expect(unisolated("await supply.dispatchOwnCheck" + "Baselines(open, { env: { SUPER_REPO_DIR: SUPER } });")).toBe(false);
    expect(unisolated("if (process.env.SUPER_REPO_DIR === x) " + tick)).toBe(true);
    expect(unisolated("const x = 1;")).toBe(false);
  });

  it("MUST-FAIL no test file drives the tick or the policy reader without its own SUPER_REPO_DIR", () => {
    const files = testFiles(join(VESSEL, "test")).map((p) => relative(VESSEL, p)).filter((r) => r !== SELF).sort();
    const drivers = files.filter((r) => DRIVES.test(readFileSync(join(VESSEL, r), "utf-8")));
    // The class is not empty (the check-supply tick tests are in it), so an empty list below is a real pass.
    expect(drivers.length).toBeGreaterThan(10);
    expect(drivers.filter((r) => unisolated(readFileSync(join(VESSEL, r), "utf-8")))).toEqual([]);
  });
});
