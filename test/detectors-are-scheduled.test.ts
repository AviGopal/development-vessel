import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A DETECTOR NOTHING RUNS IS INDISTINGUISHABLE FROM ONE NOBODY WROTE — except that it looks
 * like coverage.
 *
 * MEASURED BY ADVERSARIAL AUDIT, 2026-08-17. Two careful, negative-controlled instruments
 * had ZERO call sites:
 *
 *   scripts/substrate/memory-budget-check.sh        — 2 grep hits repo-wide, both comments
 *   validation/scripts/argument-chain-check.test.ts — 2 hits, its own header and one comment
 *
 * Neither had a systemd unit while ~25 other detectors did; neither had a Makefile target;
 * CI runs no tests at all (`grep -rn "bun test" .github/` is empty). The only automated
 * executor in this fleet is substrate-pull-sync.sh, which runs `bun test` inside each VESSEL
 * CLONE — so a check placed anywhere else is never executed by anything.
 *
 * The lesson the audit drew is the one this test encodes: CONSTRUCTION IS NOT THE FAILING
 * HALF, PLACEMENT IS. Both of those scripts were well built — guarded scans, explicit
 * negative controls, honest UNMEASURED reporting. They simply never ran.
 *
 * ⚠ SCOPE, STATED PLAINLY. This test asserts that a shell detector under scripts/substrate/
 * has a systemd unit naming it. It does NOT prove the unit is installed on any given
 * deployment (apply-inventory selects by role), nor that the timer ever fired. It closes the
 * cheapest and most common failure — writing the check and never wiring it — and nothing
 * beyond that. A test that claimed more would be the same defect one level up.
 */

// Resolve the super-repo root by WALKING UPWARD, not by fixed depth. `../../../` only lands on
// the root when the vessel is checked out as `<super>/repos/development-vessel/`. The container
// checks it out at `/workspace/git/vessels/development-vessel`, where three levels up is
// `/workspace/git/` — so SCRIPTS pointed at a directory that does not exist and four assertions
// failed with "missing detector units" while the units were present and correct. That is a
// portability bug in this file, not a defect in the thing it audits, and a validator that fails
// on correct code trains its readers to ignore it.
// The root predicate must DISCRIMINATE, not merely match. `repos/` + `scripts/substrate/`
// both exist under the container's `/workspace`, but that tree is a partial mirror: its
// scripts/substrate holds only `units/` with a single service file and zero detector scripts.
// The walk therefore "found" a super-repo that has none of what this test reads, and the
// instrument guard below did its job — reporting 0 detector scripts rather than sweeping a
// vacuous pass. Requiring vessels.inventory.json (present in the real super-repo next to its
// 38 detector scripts, absent from the mirror) tells the two apart, so a deployment without
// the super-repo skips honestly instead of failing against a decoy.
function findSuperRepoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (
      existsSync(join(dir, "repos")) &&
      existsSync(join(dir, "scripts", "substrate")) &&
      existsSync(join(dir, "scripts", "substrate", "vessels.inventory.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REPO = findSuperRepoRoot();
// A standalone vessel checkout genuinely CANNOT verify super-repo scheduling. Skip explicitly
// with a reason rather than reporting a false failure — but never skip silently, and never skip
// when the root IS found, so a real missing unit still fails.
const HAS_SUPER_REPO = REPO !== null;
const SCRIPTS = HAS_SUPER_REPO ? join(REPO!, "scripts/substrate") : "";
const UNITS = HAS_SUPER_REPO ? join(SCRIPTS, "units") : "";
if (!HAS_SUPER_REPO) {
  console.error(
    "[detectors-are-scheduled] SKIPPED: no super-repo root found above " +
      dirname(fileURLToPath(import.meta.url)) +
      " (needs a directory containing repos/, scripts/substrate/, and " +
      "scripts/substrate/vessels.inventory.json — the last one distinguishes the real " +
      "super-repo from a partial mirror that has the first two but no detector scripts). " +
      "Super-repo scheduling cannot be verified from a standalone vessel checkout.",
  );
}

/** Shell detectors: scripts whose job is to CHECK something rather than to do something. */
function detectorScripts(): string[] {
  if (!existsSync(SCRIPTS)) return [];
  return readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".sh"))
    .filter((f) => /-(check|audit|verify|assert|detect)\.sh$/.test(f));
}

function unitText(): string {
  if (!existsSync(UNITS)) return "";
  return readdirSync(UNITS)
    .filter((f) => f.endsWith(".service") || f.endsWith(".timer"))
    .map((f) => readFileSync(join(UNITS, f), "utf8"))
    .join("\n");
}

/** Anything in-repo that could plausibly invoke a script: units, Makefile, other scripts. */
function invokerText(): string {
  const parts: string[] = [unitText()];
  for (const rel of ["Makefile", "entrypoint.sh", "substrate-pull-sync.sh", "self-recovery-tick.sh"]) {
    const p = join(SCRIPTS, rel);
    if (existsSync(p) && statSync(p).isFile()) parts.push(readFileSync(p, "utf8"));
  }
  return parts.join("\n");
}

describe("detectors are wired to something that runs them", () => {
  it.skipIf(!HAS_SUPER_REPO)("guards the instrument: the scan finds the scripts and the units", () => {
    // Without this, a wrong path makes every assertion below pass vacuously — which is the
    // exact class this file exists to catch, and it would be embarrassing to commit here.
    expect(existsSync(SCRIPTS)).toBe(true);
    expect(existsSync(UNITS)).toBe(true);
    expect(detectorScripts().length).toBeGreaterThan(0);
    expect(unitText().length).toBeGreaterThan(500);
  });

  /** Detectors known to have no scheduler, each with the reason it is acceptable.
   *
   *  The list may SHRINK. It may not grow — a new unscheduled detector must either be wired
   *  or justified here, in writing, at the time it is added. */
  const KNOWN_UNSCHEDULED = new Map<string, string>([
    // (empty — memory-budget-check.sh was the last one and is now wired)
  ]);

  it.skipIf(!HAS_SUPER_REPO)("THE REGRESSION: every detector script is named by a unit or an invoker", () => {
    const invokers = invokerText();
    const orphans = detectorScripts()
      .filter((f) => !invokers.includes(f))
      .filter((f) => !KNOWN_UNSCHEDULED.has(f));
    // Was: memory-budget-check.sh (written, negative-controlled, committed, never run).
    expect(orphans).toEqual([]);
  });

  it.skipIf(!HAS_SUPER_REPO)("NEGATIVE CONTROL: the check can detect an orphan", () => {
    // Before trusting a clean sweep, prove a dirty one is visible. A scan that returns [] for
    // every input is the failure mode of every detector in this repo's history.
    const invokers = invokerText();
    expect(invokers.includes("a-script-that-does-not-exist-anywhere.sh")).toBe(false);
    // And prove the positive direction is real, not an accident of the substring test.
    expect(invokers.includes("memory-budget-check.sh")).toBe(true);
  });

  it.skipIf(!HAS_SUPER_REPO)("the frozen list does not go stale — every exemption is still an orphan", () => {
    // A baseline that quietly becomes false is how a detector stops detecting. If someone
    // wires an exempted script, this fails and the entry must come out.
    const invokers = invokerText();
    for (const [script] of KNOWN_UNSCHEDULED) {
      expect(invokers.includes(script)).toBe(false);
    }
  });

  it.skipIf(!HAS_SUPER_REPO)("a scheduled detector's FAIL is a finding, not a unit failure", () => {
    // A check that exits 1 on a real finding will be marked `failed` by systemd and then
    // "recovered" by the immune system — turning a report into an incident and training
    // everyone to mask the unit. SuccessExitStatus is what keeps a finding readable.
    const svc = join(UNITS, "memory-budget-check.service");
    expect(existsSync(svc)).toBe(true);
    expect(readFileSync(svc, "utf8")).toMatch(/SuccessExitStatus=.*1/);
  });

  it.skipIf(!HAS_SUPER_REPO)("the timer uses an absolute anchor, not OnUnitActiveSec", () => {
    // OnUnitActiveSec re-arms only relative to the triggered service's last activation, so a
    // single missed link leaves the timer `active` with `Trigger: n/a` and it never fires
    // again — observed dead for FIVE DAYS in this fleet while `is-active` read healthy.
    const timer = join(UNITS, "memory-budget-check.timer");
    expect(existsSync(timer)).toBe(true);
    const t = readFileSync(timer, "utf8");
    expect(t).toMatch(/OnCalendar=/);
    expect(t).not.toMatch(/^OnUnitActiveSec=/m);
  });
});
