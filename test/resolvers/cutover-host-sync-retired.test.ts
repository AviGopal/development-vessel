// THE HOST-SYNC HANDOFF IS RETIRED: NO ENV VAR TURNS A LANDING INTO A POLLER INTENT.
//
// Defect: vessel-mitosis-cutover.ts read MITOSIS_HOST_SYNC_MODE in two places. (1) The refuse fallback:
// an INSUFFICIENT_DATA / NEUTRAL / missing verdict, or a live_source_unreadable / base_sha_mismatch
// freshness refusal, wrote a host-sync intent (a landing handed to a host poller) instead of refusing —
// and it ran in the resolver BEFORE runGitAwareCutoverInner, so before the autonomy-scope chokepoint.
// (2) The inner handoff: a FAVORABLE landing that passed the gates became an intent instead of a commit.
// The substrate can change its own env, so one env flip turned refusals the scope gate never saw into
// landings. No host poller consumes the intent queue any more. Law 1: behaviour is not env-gated.
//
// CONTRACT pinned here:
//   - With MITOSIS_HOST_SYNC_MODE=1 in the process env, a refused verdict (INSUFFICIENT_DATA, NEUTRAL,
//     none) or a base_sha_mismatch freshness refusal is a refusal: no intent written, no commit,
//     nothing pushed, the clone clean — on an autonomy-scope excluded path and on an open one.
//   - With MITOSIS_HOST_SYNC_MODE=1, an undirected FAVORABLE landing on an excluded path is refused by
//     the autonomy-scope gate (no intent), and on an open path lands git-aware (a commit, no intent).
//   - No file under src/ reads MITOSIS_HOST_SYNC_MODE.
//
// SEAMS: the real resolveVesselMitosisCutover against a temp clone with a bare origin (skip_push,
// skip_restart), the same harness as cutover-autonomy-scope.test.ts (copied, not imported: importing a
// test file registers its tests). Intents are looked for at the default path a real pointer uses
// (WORKSPACE_ROOT/mitosis-applied-host-sync.jsonl); the pointers carry no host_sync_intent_path.
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;
const { __resetPolicyReadsForTests } = await import("../../src/resolvers/gap-to-feature.js");
const clearScopeDefault = (): void => (cutoverMod as unknown as { __setAutonomyScopeDefaultForTests?: (r: null) => void }).__setAutonomyScopeDefaultForTests?.(null);

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT", "ATTEMPT_LEDGER_DIR", "METABOB_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let errLines: string[] = [];
let errSpy: ReturnType<typeof spyOn> | null = null;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
});

const AT = "2026-10-10T10:00:00.000Z";
const EXCLUDED_DV = "src/resolvers/feature-compose.ts";
const OPEN_DV = "src/resolvers/target.ts";
const SCOPE_BODY = {
  excluded_paths: ["repos/development-vessel/src/resolvers/feature-compose.ts", "repos/goal-host-vessel/src/index.ts", "scripts/substrate/"],
  reason: "fixture: contained",
};
const LOCAL_EP = "http://node-local:8090";
function routeScope(g: FetchGuard): void {
  const localRow = { vesselId: "development-vessel-local", endpoint: LOCAL_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
  g.route({
    name: "discovery (poolImpulse)",
    match: (_u, b) => b?.pointer?.type === "vesselCapability" && b?.pointer?.shape === "poolImpulse",
    respond: (_u, b) => Response.json({ content: { shape: b.pointer.shape, vessels: [localRow], found: true } }),
  });
  g.route({
    name: "pool (autonomyScope)",
    match: (u, b) => u.startsWith(LOCAL_EP) && b?.impulse?.type === "poolImpulse",
    respond: (_u, b) => Response.json({ body: { impulses: b.impulse.shape === "autonomyScope" ? [{ shape: "autonomyScope", updated_at: AT, body: SCOPE_BODY }] : [] } }),
  });
}

let currentHost = "";
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-host-sync-retired-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "attempt-ledger");
  process.env["METABOB_API_KEY"] = "hsync-fixture-node-key";
  // The retired switch, ON for every test in this file (set after the clear above).
  process.env["MITOSIS_HOST_SYNC_MODE"] = "1";
  currentHost = "";
  guard = installCutoverFetchGuard();
  clearScopeDefault();
  __resetPolicyReadsForTests();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  routeShell(guard, () => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS;
    return `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${BUN_NO_TESTS}`;
  });
  routeScope(guard);
  errLines = [];
  errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errLines.push(a.map(String).join(" ")); });
});

afterEach(async () => {
  errSpy?.mockRestore();
  errSpy = null;
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  __setOwnCheckDepsForTests(null);
  __resetPolicyReadsForTests();
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
const sha12 = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);
const ORIGINAL = (f: string) => `// original ${f}\n`;
const STAGED = (f: string) => `// patched by substrate: ${f}\n`;

type Verdict = "FAVORABLE" | "INSUFFICIENT_DATA" | "NEUTRAL" | undefined;
/** An undirected apply_proposal_as_patch landing (what mitosis-tick cuts over from the pending record). */
async function setup(o: { files: string[]; gap: string; verdict: Verdict; stagedBaseSha?: string }) {
  const vessel = "development-vessel";
  const mvid = "mitosis-2026-10-10T10-00-00-000Z-hsync";
  const baseRoot = join(ws, "git", "super-repo", "repos", vessel);
  const mitosisRoot = join(ws, "vessels", `${vessel}-${mvid}`);
  const hostRepoRoot = join(ws, "host-repo");
  for (const f of o.files) {
    for (const root of [baseRoot, mitosisRoot, hostRepoRoot]) await mkdir(join(root, f, ".."), { recursive: true });
    await writeFile(join(baseRoot, f), ORIGINAL(f));
    await writeFile(join(hostRepoRoot, f), ORIGINAL(f));
    await writeFile(join(mitosisRoot, f), STAGED(f));
  }
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
  const originSha = git(originRoot, "rev-parse", "dev");
  currentHost = hostRepoRoot;
  const baseSha = sha12(ORIGINAL(o.files[0]!));
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(pendingPath, JSON.stringify({
    vessel_name: vessel, base_version_id: "v1", mitosis_version_id: mvid, mitosis_root: mitosisRoot, base_sha: baseSha,
    authored_by: "patch_with_tools", gap_id: o.gap, proposal: o.gap, staged_files: o.files,
  }, null, 2));
  const evaluation_evidence: Record<string, unknown> = { base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] };
  if (o.verdict !== undefined) evaluation_evidence["verdict"] = o.verdict;
  const pointer = {
    type: "vessel_mitosis_cutover" as const, vessel_name: vessel, base_version_id: "v1",
    mitosis_version_id: mvid, mitosis_root: mitosisRoot, base_root: baseRoot, host_repo_root: hostRepoRoot,
    staged_base_sha: o.stagedBaseSha ?? baseSha, staged_files: o.files, gap_id: o.gap, proposal_id: o.gap,
    pending_pointer_path: pendingPath, applied_log_path: join(ws, "mitosis-applied.jsonl"),
    skip_push: true, skip_restart: true, evaluation_evidence,
  };
  return { vessel, hostRepoRoot, originRoot, originSha, pointer };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

function gapRow(id: string, editSite: string) {
  return {
    id, status: "open", category: "systematic_failure", summary: `fixture ${id}`, source: "substrate_detected",
    classification_metadata: {
      falsifier: "class2", edit_site: editSite,
      evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/resolvers/target.test.ts", only_tests: ["target > does what the gap asked"] }, zero_field: "requested_not_passing" },
    },
  };
}
function ownCheckPasses(s: Fixture, row: Record<string, unknown>): void {
  __setOwnCheckDepsForTests({
    readGap: async (p) => ({ shape: "substrateGap", body: { gaps: p["id"] === row["id"] ? [row] : [] } }),
    writeGap: async () => ({ shape: "substrateGapWriteResult", body: { ok: true } }),
    runSuite: async () => ({ shape: "test_suite", body: { vessel: `repos/${s.vessel}`, verified_root: s.hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } }),
  });
}

const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
/** Any host-sync queue file in the workspace (the default intent path and its results sibling). */
async function intentFiles(): Promise<string[]> {
  return (await readdir(ws)).filter((n) => n.startsWith("mitosis-applied-host-sync"));
}
/** What the landing produced, with the host-sync markers that the retired paths set. */
async function outcome(s: Fixture, r: { shape: string; body?: unknown }) {
  const body = bodyOf(r);
  return {
    shape: r.shape,
    mode: body["mode"] ?? null,
    emitted_via_refuse_fallback: body["emitted_via_refuse_fallback"] ?? null,
    intent_files: await intentFiles(),
    head_subject: git(s.hostRepoRoot, "log", "-1", "--format=%s"),
    origin_moved: git(s.originRoot, "rev-parse", "dev") !== s.originSha,
    clone_status: git(s.hostRepoRoot, "status", "--porcelain"),
  };
}
const REFUSED_NO_INTENT = {
  shape: "vesselMitosisCutoverResult", mode: null, emitted_via_refuse_fallback: null, intent_files: [],
  head_subject: "baseline", origin_moved: false, clone_status: "",
};

describe("cutover: MITOSIS_HOST_SYNC_MODE=1 no longer turns a refusal into a host-sync intent (it ran before the autonomy-scope gate)", () => {
  for (const verdict of ["INSUFFICIENT_DATA", "NEUTRAL", undefined] as const) {
    it(`MUST-FAIL an undirected landing on an EXCLUDED path with verdict ${verdict ?? "(none)"} is refused — no intent, no commit`, async () => {
      const gap = `gap-hsync-excl-${verdict ?? "none"}`;
      const s = await setup({ files: [EXCLUDED_DV], gap, verdict });
      ownCheckPasses(s, gapRow(gap, `repos/development-vessel/${EXCLUDED_DV}`));
      const r = await resolveVesselMitosisCutover(s.pointer as never);
      expect(await outcome(s, r)).toEqual(REFUSED_NO_INTENT);
      expect(bodyOf(r)["refused"]).toBe(true);
      expect(String(bodyOf(r)["refusal_reason"])).toContain("verdict not FAVORABLE");
    });
  }

  it("MUST-FAIL an undirected FAVORABLE landing on an EXCLUDED path whose base sha does not match is refused (mitosis_freshness_violation) — no intent, no commit", async () => {
    const gap = "gap-hsync-excl-mismatch";
    const s = await setup({ files: [EXCLUDED_DV], gap, verdict: "FAVORABLE", stagedBaseSha: "deadbeefcafe" });
    ownCheckPasses(s, gapRow(gap, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(await outcome(s, r)).toEqual(REFUSED_NO_INTENT);
    expect(String(bodyOf(r)["refusal_reason"])).toContain("mitosis_freshness_violation (base_sha_mismatch)");
  });

  it("MUST-FAIL a refused INSUFFICIENT_DATA verdict on an OPEN path emits no host-sync intent", async () => {
    const gap = "gap-hsync-open-insufficient";
    const s = await setup({ files: [OPEN_DV], gap, verdict: "INSUFFICIENT_DATA" });
    ownCheckPasses(s, gapRow(gap, `repos/development-vessel/${OPEN_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(await outcome(s, r)).toEqual(REFUSED_NO_INTENT);
  });
});

describe("cutover: MITOSIS_HOST_SYNC_MODE=1 no longer diverts a FAVORABLE landing past the git-aware path", () => {
  it("CONTROL an undirected FAVORABLE landing on an EXCLUDED path is refused by the autonomy-scope gate — no intent, no commit (green at the parent too: F1's gate precedes the old handoff)", async () => {
    const gap = "gap-hsync-excl-favorable";
    const s = await setup({ files: [EXCLUDED_DV], gap, verdict: "FAVORABLE" });
    ownCheckPasses(s, gapRow(gap, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(await outcome(s, r)).toEqual(REFUSED_NO_INTENT);
    expect({ refuse_class: bodyOf(r)["refuse_class"], non_attempt: bodyOf(r)["non_attempt"] }).toEqual({ refuse_class: "autonomy_scope_excluded", non_attempt: true });
  });

  it("MUST-FAIL an undirected FAVORABLE landing on an OPEN path lands git-aware (a commit of the staged content), with no intent", async () => {
    const gap = "gap-hsync-open-favorable";
    const s = await setup({ files: [OPEN_DV], gap, verdict: "FAVORABLE" });
    ownCheckPasses(s, gapRow(gap, `repos/development-vessel/${OPEN_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const o = await outcome(s, r);
    expect({ shape: o.shape, mode: o.mode, intent_files: o.intent_files, committed: o.head_subject !== "baseline" })
      .toEqual({ shape: "cutoverApplied", mode: "git_aware", intent_files: [], committed: true });
    expect(git(s.hostRepoRoot, "show", `HEAD:${OPEN_DV}`) + "\n").toBe(STAGED(OPEN_DV));
  });
});

describe("source: nothing under src/ reads MITOSIS_HOST_SYNC_MODE", () => {
  it("MUST-FAIL no src file names MITOSIS_HOST_SYNC_MODE or the retired refuse-fallback helper", async () => {
    const srcRoot = join(import.meta.dir, "..", "..", "src");
    expect(existsSync(join(srcRoot, "resolvers", "vessel-mitosis-cutover.ts"))).toBe(true);
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) {
          const text = await readFile(p, "utf8");
          if (text.includes("HOST_SYNC_MODE") || text.includes("maybeEmitIntentForRefuse")) offenders.push(p.slice(srcRoot.length + 1));
        }
      }
    };
    await walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
