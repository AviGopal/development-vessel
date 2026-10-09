// VESSEL NAMES AND TARGET PATHS FROM GAP ROWS / POINTERS NEVER REACH A SHELL UNVALIDATED (security, check-first).
//
// Sibling sites of the test_suite only_tests injection (same class: gap-row or pointer data interpolated
// into a shell command string, JSON-in-double-quotes or unquoted):
//   - perf_canary_resolve derives the unit from the gap's edit_site and runs `systemctl restart ${unit}`
//     UNQUOTED through the shell producer (root in the container);
//   - feature_compose takes pointer.verify_vessels into many shell commands (`rg … ${v}` unquoted,
//     `cd ${JSON.stringify(vAbs)}`, …);
//   - composeTargetFiles accepted any characters in a gap's edit_site / relocation_hint path after the
//     vessel segment (`.+`), and those paths reach `rg … ${JSON.stringify(f)}`.
// The fix validates at entry: a plain vessel name ([A-Za-z0-9_.-], no '..'), a path charset for target
// files. These assert the refusal, never by running a payload (at base the resolvers are not driven past
// the point where a payload could run).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installCutoverFetchGuard, restoreCutoverFetch, routeDiscoveryNoShell, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// This file drives feature_compose: give it its own temp runtime root whatever loaded the module first
// (test/helpers/runtime-root.ts); it refuses to run before any write when it cannot.
await isolateRuntimeRoot("gap-and-pointer-vessel-names-never-reach-a-shell", { who: "gap-and-pointer-vessel-names-never-reach-a-shell.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const { resolvePerfCanaryResolve } = await import("../../src/resolvers/perf-canary-resolve.js");

let fetchGuard: FetchGuard;
let execGuard: ExecGuard;
let fsGuard: FsGuard;
const prevGapStore = process.env["GAP_STORE_ENDPOINT"];

beforeEach(() => {
  fetchGuard = installCutoverFetchGuard();
  execGuard = installCutoverExecGuard();
  fsGuard = installCutoverFsGuard();
});
afterEach(() => {
  if (prevGapStore === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = prevGapStore;
  const v = [...fetchGuard.restore(), ...execGuard.restore(), ...fsGuard.restore()];
  expect(v).toEqual([]);
});
afterAll(() => {
  restoreCutoverFetch();
  restoreCutoverExecModules();
  restoreCutoverFsModules();
});

describe("composeTargetFiles: a target path is a path, never shell text", () => {
  it("MUST-FAIL: an edit_site or relocation_hint file carrying $( ), backticks, quotes or spaces is not a target", () => {
    const bad = [
      "repos/goal-host-vessel/src/a$(touch x).ts",
      "repos/goal-host-vessel/src/a`id`.ts",
      "repos/goal-host-vessel/src/a\".ts",
      "repos/goal-host-vessel/src/a b;id.ts",
      "repos/goal-host-vessel/src/../../../etc/x.ts",
    ];
    for (const f of bad) {
      expect(fc.composeTargetFiles({ edit_site: f }, "")).toEqual([]);
      expect(fc.composeTargetFiles({ relocation_hint: { files: [f] } }, "")).toEqual([]);
    }
  });
  it("CONTROL: a real target path (with a :line suffix) is still a target", () => {
    expect(fc.composeTargetFiles({ edit_site: "repos/goal-host-vessel/src/walk/plan.ts:120" }, "")).toEqual(["repos/goal-host-vessel/src/walk/plan.ts"]);
  });
});

describe("feature_compose: verify_vessels are plain vessel names", () => {
  it("MUST-FAIL: a verify_vessels entry that is not a plain name is refused at entry, before any I/O", async () => {
    // At base the check does not exist: fail here rather than drive a compose with a hostile name.
    expect(typeof fc.featureComposeInputProblem).toBe("function");
    for (const v of ["repos/x`touch y`", "repos/x;id", "x $(id)", "repos/../etc", "repos/a/b"]) {
      expect(fc.featureComposeInputProblem({ verify_vessels: [v] })).not.toBeNull();
      const r = await fc.resolveFeatureCompose({ type: "feature_compose", spec: "fixture", verify_vessels: ["repos/goal-host-vessel", v] });
      expect(r.shape).toBe("featureComposeReport");
      expect(r.body.verdict).toBe("REFUSED");
      expect(r.body.stage).toBe("input");
    }
  });
  it("CONTROL: plain names, with or without repos/, pass the entry check", () => {
    expect(typeof fc.featureComposeInputProblem).toBe("function");
    expect(fc.featureComposeInputProblem({ verify_vessels: ["repos/goal-host-vessel", "development-vessel", "repos/ias-executor-ts"] })).toBeNull();
    expect(fc.featureComposeInputProblem({})).toBeNull();
  });
});

describe("perf_canary_resolve: the restart unit comes from a validated edit_site", () => {
  it("MUST-FAIL: a gap whose edit_site vessel segment is not a plain name is refused (no plan, no restart)", async () => {
    process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
    const rows = routeFixtureGapStore(fetchGuard);
    routeDiscoveryNoShell(fetchGuard);
    rows.set("perf-unit-injection", {
      id: "perf-unit-injection",
      status: "open",
      summary: "fixture",
      classification_metadata: { path: "/v2/x", measured_latency_ms: 900, edit_site: "repos/x;touch y/src/a.ts" },
    });
    const r = await resolvePerfCanaryResolve({ type: "perf_canary_resolve", gap_id: "perf-unit-injection", dry_run: true });
    const b = r.body as Record<string, any>;
    expect(b.ok).toBe(false);
    expect(String(b.error ?? "")).toContain("edit_site");
    expect(b.restart_unit).toBeUndefined();
  });
  it("CONTROL: a plain edit_site still plans (dry run reports the unit)", async () => {
    process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
    const rows = routeFixtureGapStore(fetchGuard);
    routeDiscoveryNoShell(fetchGuard);
    rows.set("perf-unit-plain", {
      id: "perf-unit-plain",
      status: "open",
      summary: "fixture",
      classification_metadata: { path: "/v2/x", measured_latency_ms: 900, edit_site: "repos/activity-api/src/routes/x.ts" },
    });
    const r = await resolvePerfCanaryResolve({ type: "perf_canary_resolve", gap_id: "perf-unit-plain", dry_run: true });
    const b = r.body as Record<string, any>;
    expect(b.ok).toBe(true);
    expect(b.restart_unit).toBe("activity-api");
  });
});
