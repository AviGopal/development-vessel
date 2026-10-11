// A NODE OWNS COMPOSES ONLY FOR VESSELS IT RUNS (check-first, 2026-10-07).
//
// Measured 2026-10-06/07: compose2 masks activity-api.service (/etc/systemd/system/activity-api.service ->
// /dev/null) yet landed activity-api b025380 and 4c626a0 for gap-env-gated-sf-discount, each "routed by
// ownership -> development-vessel-local". ownedVessels() (gap-to-feature) was clone presence intersected with
// SUBSTRATE_PUSH_VESSELS, and nothing on the compose or cutover path read the unit mask, so a node composed,
// landed and post-land-tested code for a vessel it never serves, and the landing could never be verified there.
//
// CONTRACT pinned here: a vessel whose systemd unit is MASKED on this node (<vessel>.service a symlink to
// /dev/null in a unit directory) is not owned, so it is not offered as composeOwnership and the picker does not
// take its gaps here. A clone with no unit (a library) and an unmasked unit stay owned (CONTROLS).
// SEAM: VESSELS_CLONE_ROOT (existing) and SYSTEMD_UNIT_DIRS (colon-separated unit directories, call-time), both
// pointed at a temp tree.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as g2f from "../../src/resolvers/gap-to-feature.js";
import * as g2fPolicy from "../../src/judge/gap-policy.js";
const ownedVessels = g2fPolicy.ownedVessels;
// Namespace read so a missing export fails ITS test, not the whole file.
const systemdUnitDirs = (): string[] => ((g2fPolicy as Record<string, unknown>)["systemdUnitDirs"] as (() => string[]) | undefined)?.() ?? [];

const ROOT = join(tmpdir(), `compose-ownership-mask-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "vessels");
const ETC = join(ROOT, "etc-systemd-system");
const RUN = join(ROOT, "run-systemd-system");
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const v of ["activity-api", "goal-host-vessel", "ias-executor-ts", "boredom-vessel"]) mkdirSync(join(CLONES, v, ".git"), { recursive: true });
  mkdirSync(ETC, { recursive: true }); mkdirSync(RUN, { recursive: true });
  symlinkSync("/dev/null", join(ETC, "activity-api.service")); //         masked persistently (compose2's form)
  symlinkSync("/dev/null", join(RUN, "boredom-vessel.service")); //       masked at runtime
  writeFileSync(join(ETC, "goal-host-vessel.service"), "[Unit]\n"); //    an ordinary, unmasked unit
  for (const k of ["VESSELS_CLONE_ROOT", "SYSTEMD_UNIT_DIRS", "SUBSTRATE_PUSH_VESSELS"]) saved[k] = process.env[k];
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
  process.env["SYSTEMD_UNIT_DIRS"] = `${ETC}:${RUN}`;
  delete process.env["SUBSTRATE_PUSH_VESSELS"];
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe("compose ownership respects the local unit mask", () => {
  it("MUST-FAIL: a vessel whose unit is masked on this node (symlink to /dev/null) is not owned", () => {
    expect([...ownedVessels()].sort()).not.toContain("activity-api");
  });
  it("MUST-FAIL: a runtime mask (/run/systemd/system) counts too", () => {
    expect([...ownedVessels()].sort()).not.toContain("boredom-vessel");
  });
  it("MUST-FAIL: the mask applies even when SUBSTRATE_PUSH_VESSELS names the vessel (compose2 declares activity-api)", () => {
    process.env["SUBSTRATE_PUSH_VESSELS"] = "activity-api,goal-host-vessel";
    expect([...ownedVessels()].sort()).toEqual(["goal-host-vessel"]);
  });
  it("CONTROL: an unmasked unit and a clone with no unit at all stay owned", () => {
    const owned = [...ownedVessels()].sort();
    expect(owned).toContain("goal-host-vessel");
    expect(owned).toContain("ias-executor-ts");
  });
  it("MUST-FAIL: with SYSTEMD_UNIT_DIRS unset, the default unit directories include BOTH /etc/systemd/system and /run/systemd/system (a `mask --runtime` lives in /run)", () => {
    delete process.env["SYSTEMD_UNIT_DIRS"];
    const dirs = systemdUnitDirs();
    expect(dirs).toContain("/etc/systemd/system");
    expect(dirs).toContain("/run/systemd/system");
  });
  it("CONTROL: with no unit directory readable, ownership is clone presence as before", () => {
    process.env["SYSTEMD_UNIT_DIRS"] = join(ROOT, "absent");
    expect([...ownedVessels()].sort()).toEqual(["activity-api", "boredom-vessel", "goal-host-vessel", "ias-executor-ts"]);
  });
});
