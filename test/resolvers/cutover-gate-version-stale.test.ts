// A NODE NEVER LANDS THROUGH LANDING-GATE CODE OLDER THAN THE VERSION ITS CLONE HAS ACCEPTED.
//
// Measured on node 2: development-vessel landed a commit through its cutover while the RUNNING process
// held gate code older than the clone's. The clone had the fail-closed own-check commit, but /vessels
// lagged ~75 min behind it (pull-sync re-attempt suppression held the mirror), and once the files did
// converge the restart was DEFERRED (one run in flight), so the process kept serving the old gate. Every
// check the new gate adds is void while the old module is the one that runs.
//
// Before these tests nothing in src/ knew which gate version the process runs: there is no build sha,
// no process-start stamp, no accepted-version file (grep for process start / build sha / accepted sha /
// .gate/accepted finds nothing). So these tests DEFINE THE SEAM the fix adds. The field contract:
//
//   src/resolvers/gate-version.ts — a LEAF module (node builtins only), imported STATICALLY by
//   vessel-mitosis-cutover.ts (which index.ts imports at boot), so its evaluation is process start:
//     GATE_FILES: readonly string[]      vessel-relative landing-gate sources; at least
//                                        "src/resolvers/vessel-mitosis-cutover.ts" (the cutover) and
//                                        "src/resolvers/staged-mitosis-gate.ts" (the own-check gate).
//     gateVersionOf(read: (rel) => string | null): string | null
//                                        one hash over GATE_FILES as `read` returns them; null when any
//                                        file is unreadable (a missing measurement is not a version).
//     loadedGateVersion(): string | null the version of the gate files beside this module AS READ WHEN
//                                        THE MODULE WAS EVALUATED. Never re-reads disk: it is what the
//                                        process loaded, not what pull-sync has since mirrored.
//     acceptedGateVersion(cloneRoot: string): string | null
//                                        gateVersionOf over the clone's HEAD COMMIT blobs (git show
//                                        HEAD:<file>), never its working tree — a staged mitosis may be
//                                        editing a gate file, and its own edit is not "accepted".
//
//   src/resolvers/vessel-mitosis-cutover.ts:
//     __setGateVersionDepsForTests(d: { running?, accepted? } | null) — the test seam, same shape as
//       __setOwnCheckDepsForTests. Real deps: running = loadedGateVersion(); accepted =
//       acceptedGateVersion(<development-vessel clone>). No env var decides whether the check runs
//       (law 1): the check is unconditional, and only these injectable readers stand in for tests.
//     Before any commit: running !== accepted -> soft refusal refuse_class "gate_version_stale";
//       running or accepted unknown (null, or the reader throws) -> refuse_class
//       "gate_version_unmeasurable" (FAIL CLOSED: a missing measurement is a refusal, never a pass).
//       Both carry running_gate_version / accepted_gate_version, are deferred:true, and KEEP the
//       pending lock, so the same staged tree lands once the process restarts onto the accepted gate.
//
// These drive the REAL resolveVesselMitosisCutover through its git-aware path against a temp clone with
// a bare origin (no push, no restart, no live services), modelled on staged-mitosis-own-check.test.ts.
// The own-check deps are set to a passing check so the gate version is the only thing that can refuse.
// Seams are reached optionally: on a tree without them the cutover runs its unpatched path, which is
// exactly what the MUST-FAIL tests expose (it lands).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveVesselMitosisCutover } = cutoverMod;

type MaybeAsync<T> = T | Promise<T>;
type GateDeps = { running?: () => MaybeAsync<string | null>; accepted?: () => MaybeAsync<string | null> };
type OwnDeps = { readGap?: (p: Record<string, unknown>) => Promise<unknown>; runSuite?: (p: Record<string, unknown>) => Promise<unknown> };
const setGateDeps = (d: GateDeps | null): void => {
  (cutoverMod as unknown as { __setGateVersionDepsForTests?: (d: GateDeps | null) => void }).__setGateVersionDepsForTests?.(d);
};
const setOwnDeps = (d: OwnDeps | null): void => {
  (cutoverMod as unknown as { __setOwnCheckDepsForTests?: (d: OwnDeps | null) => void }).__setOwnCheckDepsForTests?.(d);
};
type GateVersionMod = {
  GATE_FILES: readonly string[];
  gateVersionOf: (read: (rel: string) => string | null) => string | null;
  loadedGateVersion: () => string | null;
  acceptedGateVersion: (cloneRoot: string) => string | null;
};
const GATE_VERSION_SRC = join(import.meta.dir, "..", "..", "src", "resolvers", "gate-version.ts");
const importGateVersion = async (): Promise<GateVersionMod> => (await import(GATE_VERSION_SRC)) as GateVersionMod;

const ENV_KEYS = [
  "WORKSPACE_ROOT",
  "MITOSIS_CUTOVER_SKIP_SYSTEMCTL",
  "MITOSIS_DIRECT_PUSH",
  "MITOSIS_RUNTIME_DIR",
  "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE",
  "MITOSIS_HOST_REPO_ROOT",
  "PUSH_POLICY_PATH",
  "SUBSTRATE_REPO_OWNER",
  "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH",
  "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
const extraDirs: string[] = [];

const VESSEL = "development-vessel";
const GAP = "gap-gate-version-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-02T23-40-00-000Z";
// Two gate versions: what the node-2 process loaded, and the fail-closed own-check commit its clone held.
const GATE_OLD = "gate-3f1c0aa-before-fail-closed-own-check";
const GATE_ACCEPTED = "gate-9b27e41-fail-closed-own-check";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "gate-version-cut-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["CUTOVER_PRECHECK_SUITE"] = "0";
});

afterEach(async () => {
  setGateDeps(null);
  setOwnDeps(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  for (const d of extraDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

type Fixture = { baseRoot: string; mitosisRoot: string; hostRepoRoot: string; originRoot: string; baseSha: string; pendingPath: string };

async function setup(): Promise<Fixture> {
  const reposRoot = join(ws, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, "src", "resolvers", "target.ts"), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, "src", "resolvers", "target.ts"), STAGED);
  const hostRepoRoot = join(ws, "host-repo");
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, "src", "resolvers", "target.ts"), "// original\n");
  git(hostRepoRoot, "init", "-b", "dev");
  git(hostRepoRoot, "config", "user.email", "test@example.com");
  git(hostRepoRoot, "config", "user.name", "Test");
  git(hostRepoRoot, "add", ".");
  git(hostRepoRoot, "commit", "-m", "baseline");
  const originRoot = join(ws, "host-origin.git");
  spawnSync("git", ["init", "--bare", "-b", "dev", originRoot]);
  git(hostRepoRoot, "remote", "add", "origin", originRoot);
  git(hostRepoRoot, "push", "-u", "origin", "dev");
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(
    pendingPath,
    JSON.stringify({
      vessel_name: VESSEL,
      base_version_id: "v1",
      mitosis_version_id: MVID,
      mitosis_root: mitosisRoot,
      base_sha: baseSha,
      authored_by: "patch_with_tools",
      gap_id: GAP,
      proposal: GAP,
      staged_files: ["src/resolvers/target.ts"],
    }, null, 2),
  );
  return { baseRoot, mitosisRoot, hostRepoRoot, originRoot, baseSha, pendingPath };
}

function git(cwd: string, ...args: string[]): string {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
}

function pointerFor(s: Fixture) {
  return {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: s.mitosisRoot,
    base_root: s.baseRoot,
    host_repo_root: s.hostRepoRoot,
    staged_base_sha: s.baseSha,
    staged_files: ["src/resolvers/target.ts"],
    proposal_id: GAP,
    gap_id: GAP,
    pending_pointer_path: s.pendingPath,
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: {
      verdict: "FAVORABLE",
      verdict_reason: "static_checks_pass",
      base_success_rate: 1,
      mitosis_success_rate: 1,
      cited_trace_ids: [],
      cited_check_names: ["bun run typecheck"],
    },
    skip_push: true,
    skip_restart: true,
  };
}

const gapRow = {
  id: GAP,
  status: "open",
  category: "missing_capability",
  summary: "target does what the gap asked",
  classification_metadata: {
    falsifier: { class: "class2" },
    edit_site: `repos/${VESSEL}/src/resolvers/target.ts`,
    evidence_resolve: {
      shape: "test_suite",
      input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] },
      zero_field: "requested_not_passing",
    },
  },
};
/** A passing own check, so the gate version is the only thing in these fixtures that can refuse. */
function passingOwnCheck(s: Fixture): void {
  setOwnDeps({
    readGap: async (p) => ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [gapRow] : [] } }),
    runSuite: async () => ({ shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: s.hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } }),
  });
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Nothing landed: no commit on the clone, origin's dev ref where the fixture left it. */
function expectNothingLanded(s: Fixture, originDevBefore: string): void {
  expect(git(s.hostRepoRoot, "log", "-1", "--format=%s")).toBe("baseline");
  expect(git(s.originRoot, "rev-parse", "dev")).toBe(originDevBefore);
}

describe("cutover: the RUNNING landing gate must be the version the clone accepted", () => {
  it("MUST-FAIL: a running gate older than the accepted gate refuses with gate_version_stale, commits nothing, keeps the pending lock", async () => {
    const s = await setup();
    passingOwnCheck(s);
    setGateDeps({ running: () => GATE_OLD, accepted: () => GATE_ACCEPTED });
    const originBefore = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(pointerFor(s) as never);
    const body = r.body as Record<string, unknown>;
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refused"]).toBe(true);
    expect(body["refuse_class"]).toBe("gate_version_stale");
    expect(body["running_gate_version"]).toBe(GATE_OLD);
    expect(body["accepted_gate_version"]).toBe(GATE_ACCEPTED);
    expect(body["deferred"]).toBe(true);
    expectNothingLanded(s, originBefore);
    expect(await exists(s.pendingPath)).toBe(true);           // a restart, not a recompose, is what this tree needs
  });

  it("MUST-FAIL: the refused staged tree lands once the process restarts onto the accepted gate (same pending, running == accepted)", async () => {
    const s = await setup();
    passingOwnCheck(s);
    let running = GATE_OLD;
    setGateDeps({ running: () => running, accepted: () => GATE_ACCEPTED });
    const first = await resolveVesselMitosisCutover(pointerFor(s) as never);
    expect((first.body as Record<string, unknown>)["refuse_class"]).toBe("gate_version_stale");
    expect(git(s.hostRepoRoot, "log", "-1", "--format=%s")).toBe("baseline");
    running = GATE_ACCEPTED;                                    // the deferred restart finally happened
    const second = await resolveVesselMitosisCutover(pointerFor(s) as never);
    expect(second.shape).toBe("cutoverApplied");
    expect(git(s.hostRepoRoot, "log", "-1", "--format=%s")).not.toBe("baseline");
    expect(await readFile(join(s.hostRepoRoot, "src", "resolvers", "target.ts"), "utf8")).toBe(STAGED);
  });

  it("CONTROL: running == accepted lands", async () => {
    const s = await setup();
    passingOwnCheck(s);
    setGateDeps({ running: () => GATE_ACCEPTED, accepted: async () => GATE_ACCEPTED });
    const r = await resolveVesselMitosisCutover(pointerFor(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(git(s.hostRepoRoot, "log", "-1", "--format=%s")).not.toBe("baseline");
    expect(await readFile(join(s.hostRepoRoot, "src", "resolvers", "target.ts"), "utf8")).toBe(STAGED);
  });

  it("MUST-FAIL: an UNKNOWN running version refuses (gate_version_unmeasurable) — a missing measurement is never a pass", async () => {
    const s = await setup();
    passingOwnCheck(s);
    setGateDeps({ running: () => null, accepted: () => GATE_ACCEPTED });
    const originBefore = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(pointerFor(s) as never);
    const body = r.body as Record<string, unknown>;
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refuse_class"]).toBe("gate_version_unmeasurable");
    expect(body["accepted_gate_version"]).toBe(GATE_ACCEPTED);
    expectNothingLanded(s, originBefore);
    expect(await exists(s.pendingPath)).toBe(true);
  });

  it("MUST-FAIL: an UNREADABLE running version (the reader throws) refuses (gate_version_unmeasurable)", async () => {
    const s = await setup();
    passingOwnCheck(s);
    setGateDeps({ running: () => { throw new Error("EACCES: gate stamp unreadable"); }, accepted: () => GATE_ACCEPTED });
    const originBefore = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(pointerFor(s) as never);
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("gate_version_unmeasurable");
    expectNothingLanded(s, originBefore);
  });

  it("MUST-FAIL: an UNKNOWN accepted version refuses too (gate_version_unmeasurable)", async () => {
    const s = await setup();
    passingOwnCheck(s);
    setGateDeps({ running: () => GATE_ACCEPTED, accepted: () => null });
    const originBefore = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(pointerFor(s) as never);
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("gate_version_unmeasurable");
    expectNothingLanded(s, originBefore);
  });

  it("MUST-FAIL: by default the running version is the one the cutover module loaded (loadedGateVersion), not a fresh read", async () => {
    const gv = await importGateVersion();
    const loaded = gv.loadedGateVersion();
    expect(typeof loaded).toBe("string");
    // Only the accepted side is injected: the running side is the real default.
    const s = await setup();
    passingOwnCheck(s);
    setGateDeps({ accepted: () => "some-newer-accepted-gate" });
    const stale = await resolveVesselMitosisCutover(pointerFor(s) as never);
    expect((stale.body as Record<string, unknown>)["refuse_class"]).toBe("gate_version_stale");
    expect((stale.body as Record<string, unknown>)["running_gate_version"]).toBe(loaded);
    setGateDeps({ accepted: () => loaded });
    const landed = await resolveVesselMitosisCutover(pointerFor(s) as never);
    expect(landed.shape).toBe("cutoverApplied");
  });
});

describe("gate-version: running = what the process loaded, accepted = the clone's HEAD commit", () => {
  it("MUST-FAIL: GATE_FILES names the cutover and the own-check gate", async () => {
    const gv = await importGateVersion();
    expect(gv.GATE_FILES).toContain("src/resolvers/vessel-mitosis-cutover.ts");
    expect(gv.GATE_FILES).toContain("src/resolvers/staged-mitosis-gate.ts");
  });

  it("MUST-FAIL: loadedGateVersion() is fixed when the module is evaluated — rewriting a gate file on disk moves the disk version but not the loaded one", async () => {
    // A private copy of the leaf module beside fake gate files, so the disk can change under a loaded module
    // without touching this repo's src/. The copy resolves its gate files relative to itself.
    const root = await mkdtemp(join(tmpdir(), "gate-version-loaded-"));
    extraDirs.push(root);
    const gv0 = await importGateVersion();
    await mkdir(join(root, "src", "resolvers"), { recursive: true });
    await copyFile(GATE_VERSION_SRC, join(root, "src", "resolvers", "gate-version.ts"));
    for (const f of gv0.GATE_FILES) {
      await mkdir(join(root, f, ".."), { recursive: true });
      await writeFile(join(root, f), `// ${f} — the gate this process booted with\n`);
    }
    const gv = (await import(join(root, "src", "resolvers", "gate-version.ts"))) as GateVersionMod;
    const diskReader = (rel: string): string | null => {
      try { return readFileSync(join(root, rel), "utf8"); } catch { return null; }
    };
    const atLoad = gv.loadedGateVersion();
    expect(typeof atLoad).toBe("string");
    expect(atLoad).toBe(gv.gateVersionOf(diskReader));
    // pull-sync mirrors the fail-closed gate onto disk; the process is not restarted.
    await writeFile(join(root, "src", "resolvers", "vessel-mitosis-cutover.ts"), "// the fail-closed own-check gate, mirrored later\n");
    const onDisk = gv.gateVersionOf(diskReader);
    expect(onDisk).not.toBeNull();
    expect(onDisk).not.toBe(atLoad);
    expect(gv.loadedGateVersion()).toBe(atLoad);
    // And a gate file that cannot be read is not a version.
    await rm(join(root, "src", "resolvers", "staged-mitosis-gate.ts"));
    expect(gv.gateVersionOf(diskReader)).toBeNull();
  });

  it("MUST-FAIL: acceptedGateVersion(clone) is read from the clone's HEAD commit, not its working tree", async () => {
    const gv = await importGateVersion();
    const clone = await mkdtemp(join(tmpdir(), "gate-version-clone-"));
    extraDirs.push(clone);
    for (const f of gv.GATE_FILES) {
      await mkdir(join(clone, f, ".."), { recursive: true });
      await writeFile(join(clone, f), `// ${f} @ accepted commit\n`);
    }
    git(clone, "init", "-b", "dev");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "fail-closed own-check");
    const headReader = (rel: string): string | null => {
      const r = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: clone, encoding: "utf8" });
      return r.status === 0 ? r.stdout : null;
    };
    const atHead = gv.gateVersionOf(headReader);
    expect(atHead).not.toBeNull();
    expect(gv.acceptedGateVersion(clone)).toBe(atHead);
    // A staged edit to the cutover in the working tree is not accepted.
    await writeFile(join(clone, "src", "resolvers", "vessel-mitosis-cutover.ts"), "// a staged mitosis editing the gate itself\n");
    expect(gv.acceptedGateVersion(clone)).toBe(atHead);
    // A directory that is not a clone has no accepted version.
    const notAClone = await mkdtemp(join(tmpdir(), "gate-version-none-"));
    extraDirs.push(notAClone);
    expect(gv.acceptedGateVersion(notAClone)).toBeNull();
  });
});
