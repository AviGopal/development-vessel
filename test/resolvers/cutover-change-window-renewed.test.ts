// THE CHANGE WINDOW IS HELD THROUGH THE SUITES (vessel-mitosis-cutover.ts renewChangeWindow; row
// the-cutover-change-window-lease-expires-after-600s-mid-cutover-so-the-window-reopens-while-a-landing-is-still-running-
// its-suites). The node-global maintenanceLease "cutover" was acquired once for CUTOVER_LEASE_TTL_MS (600 s) and never
// renewed, and an expired hold blocks nothing (maintenance-lease.ts: listHolds and acquire skip it). A development-vessel
// or activity-api landing runs a pre-cutover and a post-land whole suite of up to 870 s each, so the change window
// reopened mid-cutover: another cutover could take it while this one was still running its suites.
// Pinned through the REAL resolveVesselMitosisCutover on its git-aware path, PUSHED to a local bare origin, with the
// harness of cutover-post-land-suite-not-run.test.ts. The lease's clock is injected (__setMaintenanceLeaseDepsForTests):
// the stubbed suites advance it, and a second "cutover" acquire is tried from INSIDE a suite run.
//   MUST-FAIL: a single suite run past 600 s, and two suites whose sum is past 600 s: the second acquire is refused,
//     naming this cutover's holder.
//   CONTROLS: a cutover that ends within 600 s holds the window while it runs and releases it at its end, as before; a
//     holder that stops renewing (a crashed one) still has its hold expire, both through the cutover (the clock past the
//     renewed horizon) and on the lease alone (the cutover's acquire, never renewed, past 600 s).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import * as leaseMod from "../../src/resolvers/maintenance-lease.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCutoverFetchGuard, routeFleetUnreachable, routeShell,
  BUN_PASSING, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests, CUTOVER_LEASE_TTL_MS } = cutoverMod;
const { resolveMaintenanceLease, resolveMaintenanceLeaseWrite, namedLeasePath, __setMaintenanceLeaseDepsForTests } = leaseMod;

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT", "ATTEMPT_LEDGER_DIR", "METABOB_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let execGuard: ExecGuard;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverExecModules();
  restoreCutoverFetch();
  __setMaintenanceLeaseDepsForTests(null);
});

const VESSEL = "development-vessel";
const HOLDER = `cutover:${VESSEL}`;
const GAP = "gap-change-window-renewed";
const MVID = "mitosis-2026-11-01T17-00-00-000Z";
const TARGET = "src/resolvers/target.ts";
const BASELINE_DIR = "/workspace/post-land-baseline";
const S = 1000;

/** The lease's clock (maintenance-lease deps.now), advanced only by the stubbed suites. */
let clock = 0;
type Probe = { at_s: number; body: Record<string, unknown> };
/** What a second "cutover" acquire (another vessel's cutover) got, tried from inside a suite run. */
const probes: Probe[] = [];
const rogueAcquire = async (): Promise<Record<string, unknown>> =>
  ((await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", name: "cutover", holder: "cutover:other-vessel", ttl_ms: CUTOVER_LEASE_TTL_MS })).body ?? {}) as Record<string, unknown>;

let currentHost = "";
const isPreCutover = () => !currentHost || git(currentHost, "log", "-1", "--format=%s") === "baseline";
/** Both suites pass. The FIRST pre-cutover suite run advances the clock by `pre` ms and the post-land run by `post` ms;
 *  after each advance, if asked, the second acquire is tried (`probeIn`). */
function suites(o: { pre: number; post: number; probeIn: Array<"pre" | "post"> }): void {
  routeShell(guard, () => `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${BUN_PASSING}`);
  let preSeen = false;
  guard.route({
    name: "fixture shell (clocked suites)",
    match: (u) => u.startsWith("http://shell.fixture"),
    respond: async (_u, b) => {
      const command = String(b?.impulse?.pointer?.command ?? "");
      if (/ bun test /.test(command)) {
        const step = isPreCutover() ? (preSeen ? null : "pre") : "post";
        if (step === "pre") preSeen = true;
        if (step) {
          clock += step === "pre" ? o.pre : o.post;
          if (o.probeIn.includes(step)) probes.push({ at_s: Math.round((clock - T0) / S), body: await rogueAcquire() });
        }
      }
      return Response.json({ stdout: `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${BUN_PASSING}` });
    },
  });
}
let T0 = 0;

const writes: Array<Record<string, unknown>> = [];
const noCheckRow = { id: GAP, status: "open", category: "missing_capability", summary: "target does what the gap asked", source: "substrate_detected", classification_metadata: { falsifier: "none", edit_site: `repos/${VESSEL}/${TARGET}` } };
function noCheck(hostRepoRoot: string): void {
  __setOwnCheckDepsForTests({
    readGap: async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [noCheckRow] : [] } }),
    writeGap: async (p: Record<string, unknown>) => { writes.push(JSON.parse(JSON.stringify(p))); return { shape: "substrateGapWriteResult", body: { ok: true } }; },
    runSuite: async () => ({ shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } }),
  });
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-change-window-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "attempt-ledger");
  process.env["METABOB_API_KEY"] = "cutover-change-window-fixture-node-key";
  writes.length = 0;
  probes.length = 0;
  currentHost = "";
  T0 = Date.now();
  clock = T0;
  __setMaintenanceLeaseDepsForTests({ now: () => clock, maxTotalHoldS: async () => null });
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "attempt-check-unit", match: (c) => /systemctl show \S+ -p LoadState --value/.test(c), respond: () => ({ exitCode: 1, stdout: "" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
});

afterEach(async () => {
  const violations = guard.restore();
  // A post-land suite that RAN writes its baseline under the literal /workspace/post-land-baseline: the fs guard blocks
  // that write before anything lands (the cutover swallows it, best-effort). Only that path is excused here.
  const fsViolations = fsGuard.restore().filter((v) => !v.includes(BASELINE_DIR));
  const execViolations = execGuard.restore();
  __setOwnCheckDepsForTests(null);
  __setMaintenanceLeaseDepsForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
  expect(execViolations).toEqual([]);
  expect(fsViolations).toEqual([]);
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

async function setup() {
  const baseRoot = join(ws, "git", "super-repo", "repos", VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, TARGET), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, TARGET), "// patched by substrate\n");
  const hostRepoRoot = join(ws, "host-repo");
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, TARGET), "// original\n");
  git(hostRepoRoot, "init", "-q", "-b", "dev");
  git(hostRepoRoot, "config", "user.email", "test@example.com");
  git(hostRepoRoot, "config", "user.name", "Test");
  git(hostRepoRoot, "config", "commit.gpgsign", "false");
  git(hostRepoRoot, "add", ".");
  git(hostRepoRoot, "commit", "-q", "-m", "baseline");
  const originRoot = join(ws, "host-origin.git");
  git(ws, "init", "-q", "--bare", "-b", "dev", originRoot);
  git(hostRepoRoot, "remote", "add", "origin", originRoot);
  git(hostRepoRoot, "push", "-q", "-u", "origin", "dev");
  currentHost = hostRepoRoot;
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(pendingPath, JSON.stringify({
    vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha,
    authored_by: "patch_with_tools", gap_id: GAP, proposal: GAP, staged_files: [TARGET],
  }, null, 2));
  const pointer = {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: mitosisRoot,
    base_root: baseRoot,
    host_repo_root: hostRepoRoot,
    staged_base_sha: baseSha,
    staged_files: [TARGET],
    proposal_id: GAP,
    gap_id: GAP,
    pending_pointer_path: pendingPath,
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    // NOT skip_push: the landing is pushed to the local bare origin, so the pending-land stamp is reached.
    skip_restart: true,
  };
  return { hostRepoRoot, originRoot, pointer };
}

const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
async function land(o: { pre: number; post: number; probeIn: Array<"pre" | "post"> }): Promise<Record<string, unknown>> {
  const s = await setup();
  suites(o);
  noCheck(s.hostRepoRoot);
  const r = await resolveVesselMitosisCutover(s.pointer as never);
  expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
  expect(r.shape).toBe("cutoverApplied");
  const body = bodyOf(r);
  expect(body["push_status"]).toBe("pushed");
  expect(body["new_git_sha"]).toBe(git(s.originRoot, "rev-parse", "dev"));
  return body;
}
const refusedByThisCutover = (p: Probe | undefined) => {
  expect(p?.body["acquired"]).toBe(false);
  expect(p?.body["held_by"]).toBe(HOLDER);
};

describe("cutover: the change window stays held while a landing runs its suites", () => {
  it("[MUST-FAIL] one suite run past 600 s: a second 'cutover' acquire 700 s in is refused, naming this cutover", async () => {
    await land({ pre: 700 * S, post: 0, probeIn: ["pre"] });
    expect(probes.map((p) => p.at_s)).toEqual([700]);
    refusedByThisCutover(probes[0]);
  });

  it("[MUST-FAIL] a pre-cutover and a post-land suite of 500 s each: a second acquire 1000 s in is refused, naming this cutover", async () => {
    await land({ pre: 500 * S, post: 500 * S, probeIn: ["post"] });
    expect(probes.map((p) => p.at_s)).toEqual([1000]);
    refusedByThisCutover(probes[0]);
  });
});

describe("cutover: the change window still opens when the cutover ends, and when its holder stops renewing", () => {
  it("[CONTROL] a cutover within 600 s holds the window while it runs (a second acquire is refused) and releases it at its end", async () => {
    await land({ pre: 100 * S, post: 100 * S, probeIn: ["pre", "post"] });
    expect(probes.map((p) => p.at_s)).toEqual([100, 200]);
    for (const p of probes) refusedByThisCutover(p);
    expect(existsSync(namedLeasePath("cutover"))).toBe(false);
    expect(bodyOf(await resolveMaintenanceLease({ type: "maintenanceLease", name: "cutover" }))["held"]).toBe(false);
    expect((await rogueAcquire())["acquired"]).toBe(true);
  });

  it("[CONTROL] past the renewed horizon (the holder renews no more, as a crashed one would not) the hold has expired: the second acquire is granted", async () => {
    // The post-land renew is for the suite's 870 s budget plus the 600 s TTL; 1500 s on, it has lapsed.
    await land({ pre: 0, post: 1500 * S, probeIn: ["post"] });
    expect(probes.map((p) => p.at_s)).toEqual([1500]);
    expect(probes[0]!.body["acquired"]).toBe(true);
  });

  it("[CONTROL] the cutover's own acquire, never renewed, expires at CUTOVER_LEASE_TTL_MS", async () => {
    expect(CUTOVER_LEASE_TTL_MS).toBe(600_000);
    const acq = bodyOf(await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", name: "cutover", holder: HOLDER, ttl_ms: CUTOVER_LEASE_TTL_MS }));
    expect(acq["acquired"]).toBe(true);
    clock += CUTOVER_LEASE_TTL_MS - S;
    expect((await rogueAcquire())["held_by"]).toBe(HOLDER);
    clock += 2 * S;
    expect((await rogueAcquire())["acquired"]).toBe(true);
  });
});
