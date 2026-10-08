// A DEFERRED CUTOVER RETURNS WHEN ITS WAIT IS OVER, NOT TEN SECONDS LATER (check-first, 2026-10-08).
//
// When the change_window lease is still held after the bounded wait (CUTOVER_LEASE_WAIT_MS), the cutover
// logs the deferral, sends negative feedback to the holding activity, and returns cutoverDeferred. A pwt
// landing (9d021554) added an unconditional 10 s sleep before that return, with no stated reason: no caller
// re-invokes the cutover on cutoverDeferred (feature-compose parks and resumes on a later compose, the
// mitosis tick re-runs on its own cadence, patch-with-tools returns landed:false), so the sleep throttles
// nothing and only holds every deferred landing's compose slot ten seconds longer.
//   - MUST-FAIL: with the lease held and CUTOVER_LEASE_WAIT_MS=0, cutoverDeferred returns in under 1 s.
//     0, not a small positive wait: the bounded-wait loop steps in 5 s increments, so any positive value
//     runs one full 5 s step and would hide the sleep under the loop's own granularity.
//   - CONTROL: on that path the negative holder feedback still fires, once, at the holding activity.
// Drives the REAL resolveVesselMitosisCutover through its git-aware path with the same temp-clone harness
// as cutover-landing-lease.test.ts (whose CONTROL lands, so every gate before the lease acquire passes).
// HOW THE DEFERRAL IS REACHED: an earlier pre-check reads the same change_window lease and soft-refuses
// at once when it is held, so the deferral branch is reached only when another activity takes the window
// AFTER that pre-check and BEFORE the cutover's own acquire. The test makes that race deterministic: the
// cutover's acquire is wrapped so the other holder takes the real lease file (under the test's
// WORKSPACE_ROOT) immediately before the real acquire runs and is refused.
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import * as realLease from "../../src/resolvers/maintenance-lease.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;
// The real module, saved: bun's mock.module is not undone by mock.restore(), so the only undo is re-mocking
// with the saved real exports (the same discipline as cutover-fs-guard.ts).
const LEASE_SPEC = "../../src/resolvers/maintenance-lease.js";
const ORIG_LEASE = { ...realLease };
const restoreLeaseModule = () => { mock.module(LEASE_SPEC, () => ORIG_LEASE); };

const ENV_KEYS = ["WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR", "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE", "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT", "CUTOVER_LEASE_WAIT_MS"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let store: Map<string, Record<string, any>>;
let feedback: Array<Record<string, any>>;
afterAll(() => { restoreLeaseModule(); restoreCutoverFsModules(); restoreCutoverFetch(); });

const VESSEL = "development-vessel";
const GAP = "gap-cutover-deferral-no-sleep-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-08T02-00-00-000Z";
const TARGET = "src/resolvers/target.ts";
const HOLDER = "trace-store-reconcile";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-deferral-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["CUTOVER_LEASE_WAIT_MS"] = "0";

  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  store = routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  routeShell(guard, () => BUN_NO_TESTS);
  // Later routes win: the holder-feedback POST is answered and recorded instead of declared unreachable.
  feedback = [];
  guard.route({
    name: "activity feedback (recorded)",
    match: (u) => { try { return /\/v2\/activities\/feedback$/.test(new URL(u).pathname); } catch { return false; } },
    respond: (_u, b) => { feedback.push(b); return Response.json({ ok: true }); },
  });
});
afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  __setOwnCheckDepsForTests(null);
  restoreLeaseModule();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
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
  await writeFile(join(mitosisRoot, TARGET), STAGED);
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

  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(pendingPath, JSON.stringify({ vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha, authored_by: "feature_compose", gap_id: GAP, proposal: GAP, staged_files: [TARGET] }, null, 2));
  const pointer = {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_root: baseRoot,
    host_repo_root: hostRepoRoot, staged_base_sha: baseSha, staged_files: [TARGET], proposal_id: GAP, gap_id: GAP,
    pending_pointer_path: pendingPath, applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    skip_push: true, skip_restart: true,
  };
  return { hostRepoRoot, originRoot, pointer };
}

/** The gap row in the fixture store: an armed class-2 check (so the own check is the measurement) plus `lease`. */
function seedRow(lease?: Record<string, unknown>): void {
  store.set(GAP, {
    id: GAP, status: "open", category: "missing_capability", summary: "target does what the gap asked", source: "substrate_detected",
    classification_metadata: {
      falsifier: "class2", edit_site: `repos/${VESSEL}/${TARGET}`,
      evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] }, zero_field: "requested_not_passing" },
      ...(lease ? { landing_lease: lease } : {}),
    },
  });
}
/** The gap read stays the real resolver (forwarded to the fixture store); the own check passes. */
function ownCheckPasses(s: { hostRepoRoot: string }): void {
  __setOwnCheckDepsForTests({
    writeGap: async () => ({ shape: "substrateGapWriteResult", body: { ok: true } }),
    runSuite: async () => ({ shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: s.hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } }),
  });
}
const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const head = (s: { hostRepoRoot: string }) => git(s.hostRepoRoot, "log", "-1", "--format=%s");

/**
 * Another activity takes the change_window lease between the cutover's pre-check and its own acquire:
 * the wrapped write takes the real hold for HOLDER right before the cutover's first acquire, then hands
 * the call to the real resolver, which refuses it (held_by HOLDER). Every other lease call is the real one.
 */
function holderTakesWindowBeforeAcquire(): void {
  let taken = false;
  mock.module(LEASE_SPEC, () => ({
    ...ORIG_LEASE,
    resolveMaintenanceLeaseWrite: async (p: realLease.MaintenanceLeaseWritePointer) => {
      if (!taken && p.op === "acquire" && p.name === "cutover" && String(p.holder ?? "").startsWith("cutover:")) {
        taken = true;
        const held = await ORIG_LEASE.resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", name: "cutover", holder: HOLDER, ttl_ms: 600000 });
        expect(bodyOf(held)["acquired"]).toBe(true);
      }
      return ORIG_LEASE.resolveMaintenanceLeaseWrite(p);
    },
  }));
}

describe("cutover: a deferral returns when its bounded wait is over", () => {
  it("[MUST-FAIL] change_window held past CUTOVER_LEASE_WAIT_MS=0 -> cutoverDeferred in under 1 s, nothing committed", async () => {
    const s = await setup();
    seedRow();
    ownCheckPasses(s);
    holderTakesWindowBeforeAcquire();
    const t0 = Date.now();
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const elapsed = Date.now() - t0;
    expect(r.shape).toBe("cutoverDeferred");
    expect(bodyOf(r)["deferred"]).toBe(true);
    expect(bodyOf(r)["held_by"]).toBe(HOLDER);
    expect(head(s)).toBe("baseline");
    expect(elapsed).toBeLessThan(1000);
  }, 15000);

  it("[CONTROL] on that deferral the negative holder feedback still fires once, at the holding activity", async () => {
    const s = await setup();
    seedRow();
    ownCheckPasses(s);
    holderTakesWindowBeforeAcquire();
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverDeferred");
    expect(feedback.length).toBe(1);
    expect(feedback[0]!["direction"]).toBe("negative");
    expect(feedback[0]!["activity_id"]).toBe(`development-vessel:${HOLDER}`);
    expect(guard.hits.filter((h) => h === "activity feedback (recorded)").length).toBe(1);
  }, 15000);
});
