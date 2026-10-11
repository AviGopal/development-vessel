// THE AUTO-REVERT LANDS THROUGH THE CUTOVER CHOKEPOINT (contained-self-development 8.3; vessel-mitosis-cutover.ts
// REVERT_OF). A `revert_of` pointer makes the real git-aware cutover land `git revert` of a lane landing: the same
// change-window lease, clean-slate, precutover suite, commit, push and mirror as any landing, with the staged-file
// copy replaced by the revert and four steps skipped (the gap landing lease, the 5c evidence-deletion guard, the
// gap's own check, the pending-outcome stamp). These pin each half: what the revert keeps and what it skips, and
// that every refusal leaves the push clone at origin/dev with no revert sequencer state.
//
// Hermetic: a temp bare origin and push clone, the REAL resolveVesselMitosisCutover pushing to that local origin,
// no restart (skip_restart), the attempt ledger in the temp dir (ATTEMPT_LEDGER_DIR), the gap store at the shared
// in-memory fixture, the network behind the shared cutover fetch guard (the precutover and post-land suites answer
// through a fixture shell), and every fs write outside os.tmpdir() blocked and recorded by the shared fs guard.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { readRecords } from "../../src/resolvers/attempt-ledger.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_PASSING, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;
const setBaseline = (cutoverMod as unknown as { __setPrecutoverBaselineForTests?: (f: ((v: string) => Promise<string[] | null>) | null) => void }).__setPrecutoverBaselineForTests;

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_REPO_ROOT", "MITOSIS_SKIP_CLONE_RESET", "MITOSIS_STAGED_MAX_AGE_MS", "PUSH_POLICY_PATH",
  "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE", "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT", "ATTEMPT_LEDGER_DIR",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let gapRows: Map<string, Record<string, any>>;
let suiteRed = false;
const notReached: string[] = [];
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
});

const VESSEL = "fixvessel";
const GAP = "gap-revert-fixture";
const ATT = "att-mrevert1-abcdefg";
const F = "src/target.ts";
const F_BASE = "// target\nexport const answer = 1;\nexport const other = 0;\n";
const F_LANDED = "// target\nexport const answer = 2;\nexport const other = 0;\n";
const LANDED_LINE = "export const answer = 2;";
const BUN_FAILING =
  "bun test v1.3.14 (0d9b296a)\n\ntest/target.test.ts:\n(fail) target > keeps the landed answer [0.20ms]\n\n 0 pass\n 1 fail\n 1 expect() calls\nRan 1 test across 1 file. [9.00ms]\n";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
function ident(cwd: string): void {
  git(cwd, "config", "user.email", "lane@example.com");
  git(cwd, "config", "user.name", "Lane Fixture");
  git(cwd, "config", "commit.gpgsign", "false");
}
async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}
const origin = () => join(ws, "origin.git");
const clone = () => join(ws, "git", "vessels", VESSEL);
const seed = () => join(ws, "seed");
const originHead = () => git(ws, "--git-dir", origin(), "rev-parse", "dev");
const originCount = () => Number(git(ws, "--git-dir", origin(), "rev-list", "--count", "dev"));

/** Origin with B then L (a lane landing of F with an Attempt-Id trailer); the push clone fast-forwarded to it. */
async function fixture(opts: { later?: string; addsFile?: boolean; alreadyReverted?: boolean } = {}): Promise<{ L: string; B: string }> {
  git(ws, "init", "-q", "--bare", "-b", "dev", origin());
  git(ws, "init", "-q", "-b", "dev", seed());
  ident(seed());
  await put(seed(), F, F_BASE);
  git(seed(), "add", "-A");
  git(seed(), "commit", "-q", "-m", "base");
  const B = git(seed(), "rev-parse", "HEAD");
  await put(seed(), F, F_LANDED);
  if (opts.addsFile) await put(seed(), "src/new-module.ts", "export const n = 1;\n");
  git(seed(), "add", "-A");
  git(seed(), "commit", "-q", "-m", `substrate-authored: apply prop-l via mitosis cutover\n\nApplied autonomously by apply_proposal_as_patch + vessel_mitosis_cutover.\nGap: ${GAP}\n\nAttempt-Id: ${ATT}\n`);
  const L = git(seed(), "rev-parse", "HEAD");
  if (opts.later !== undefined) {
    await put(seed(), F, opts.later);
    git(seed(), "commit", "-q", "-am", "a later edit of the same line");
  }
  if (opts.alreadyReverted) git(seed(), "revert", "--no-edit", L);
  git(seed(), "remote", "add", "origin", origin());
  git(seed(), "push", "-q", "origin", "dev");
  await mkdir(join(ws, "git", "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin(), clone());
  ident(clone());
  // The runtime tree the mirror writes (MITOSIS_RUNTIME_DIR/<vessel>), at origin's content.
  await put(join(ws, "runtime", VESSEL), F, await readFile(join(clone(), F), "utf8"));
  return { L, B };
}

function pointer(L: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "vessel_mitosis_cutover",
    vessel_name: VESSEL,
    base_version_id: "auto-revert",
    mitosis_version_id: `revert-${ATT}`,
    evaluation_evidence: { verdict: "AUTO_REVERT", base_success_rate: 0, mitosis_success_rate: 0, cited_trace_ids: [], cited_check_names: [] },
    skip_restart: true,
    pending_pointer_path: join(ws, "mitosis-pending.json"),
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    host_sync_intent_path: join(ws, "host-sync.jsonl"),
    revert_of: { sha: L, attempt_id: ATT, settlement_key: `${ATT}#2`, gap_id: GAP, files: [F], source: "falsified_after_restart" },
    ...over,
  };
}

/** The clone is at origin/dev, clean, with no revert in progress. */
function cloneSettled(): { clean: string; atOrigin: boolean; revertHead: boolean } {
  return {
    clean: git(clone(), "status", "--porcelain"),
    atOrigin: git(clone(), "rev-parse", "HEAD") === git(clone(), "rev-parse", "origin/dev"),
    revertHead: existsSync(join(clone(), ".git", "REVERT_HEAD")),
  };
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-revert-of-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["MITOSIS_DIRECT_PUSH"] = "1";
  process.env["MITOSIS_RUNTIME_DIR"] = join(ws, "runtime");
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["MAINTENANCE_LEASE_PATH"] = join(ws, "maintenance-lease.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "ledger");
  notReached.length = 0;
  const fail = (what: string) => async () => { notReached.push(what); throw new Error(`${what} must not be reached by a revert`); };
  // The landing gap HAS a row with its own test_suite check, so the landing lease, the own check and the pending
  // stamp would each be reached (and recorded in notReached) if the revert did not skip them.
  const gapRow = { id: GAP, status: "open", summary: "fixture gap", classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: "test/target.test.ts", only_tests: ["keeps the landed answer"] } } } };
  __setOwnCheckDepsForTests({
    readGap: async () => ({ shape: "substrateGap", body: { gaps: [gapRow] } }),
    writeGap: fail("own-check gap write"),
    runSuite: fail("own-check test_suite run"),
    lease: fail("gap landing lease"),
  });
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  gapRows = routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  suiteRed = false;
  // A last-landed baseline with one standing red test (an EMPTY baseline reads as unmeasured: computeNewlyFailing).
  setBaseline?.(async () => ["(fail) unrelated > standing red"]);
  // Precutover: the clone's working tree holds the reverted content. Red when suiteRed and the landed line is
  // gone. Post-land (the revert commit exists): no summary, so the post-land suite writes no baseline.
  routeShell(guard, () => {
    const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: clone(), encoding: "utf8" }).stdout;
    if (String(subject).startsWith("Revert ")) return BUN_NO_TESTS;
    const tree = spawnSync("cat", [join(clone(), F)], { encoding: "utf8" }).stdout;
    return suiteRed && !String(tree).includes(LANDED_LINE) ? BUN_FAILING : BUN_PASSING;
  });
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  __setOwnCheckDepsForTests(null);
  setBaseline?.(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
  expect(fsViolations).toEqual([]);
});

describe("cutover revert_of: a regressed lane landing is reverted through the landing chokepoint", () => {
  it("lands one revert commit on origin/dev naming the reverted sha, the settlement and an auto_revert attempt", async () => {
    const { L, B } = await fixture();
    await writeFile(join(ws, "mitosis-pending.json"), JSON.stringify({ mitosis_version_id: "mitosis-other-landing", gap_id: "gap-other" }));
    const before = originCount();
    const res = (await resolveVesselMitosisCutover(pointer(L) as never)) as { shape: string; body: Record<string, any> };
    expect(res.shape).toBe("cutoverApplied");
    expect(res.body.push_status).toBe("pushed");
    expect(originCount()).toBe(before + 1);
    const head = originHead();
    expect(res.body.new_git_sha).toBe(head);
    const msg = git(ws, "--git-dir", origin(), "log", "-1", "--format=%B", head);
    expect(msg.startsWith(`Revert "substrate-authored: apply prop-l via mitosis cutover"`)).toBe(true);
    expect(msg).toContain(`This reverts commit ${L}.`);
    expect(msg).toContain(`Settlement: ${ATT}#2`);
    expect(msg).toContain(`Reverts-Attempt: ${ATT}`);
    expect(msg).toContain(`Gap: ${GAP}`);
    const trailers = git(ws, "--git-dir", origin(), "log", "-1", "--format=%(trailers:key=Auto-Revert,valueonly)%(trailers:key=Attempt-Id,valueonly)", head);
    const [autoRevert, newAtt] = trailers.split("\n").map((s) => s.trim()).filter(Boolean);
    expect(autoRevert).toBe("true");
    expect(newAtt).toMatch(/^att-/);
    // The tree is L's parent for L's files.
    expect(git(ws, "--git-dir", origin(), "show", `${head}:${F}`) + "\n").toBe(git(ws, "--git-dir", origin(), "show", `${B}:${F}`) + "\n");
    // The revert's own attempt: route auto_revert, explicitly not directed, touching the reverted file.
    const intent = readRecords("attemptIntent", { key: newAtt })[0]?.record as Record<string, unknown> | undefined;
    expect(intent?.["route"]).toBe("auto_revert");
    expect(intent?.["directed"]).toBe(false);
    expect(intent?.["touched_files"]).toEqual([F]);
    // Skipped: the gap landing lease, the own check, the pending-outcome stamp.
    expect(notReached).toEqual([]);
    expect(gapRows.get(GAP)?.["classification_metadata"]?.["pending_outcome_verification"]).toBeUndefined();
    // Kept: the mirror into the runtime tree.
    expect(await readFile(join(ws, "runtime", VESSEL, F), "utf8")).toBe(F_BASE);
    expect(cloneSettled()).toEqual({ clean: "", atOrigin: true, revertHead: false });
    // A revert owns no pending slot: another landing's staged lock is left in place.
    expect(await readFile(join(ws, "mitosis-pending.json"), "utf8")).toContain("mitosis-other-landing");
  });

  it("a revert that conflicts with a later edit is refused revert_conflict, aborted, and nothing is pushed", async () => {
    const { L } = await fixture({ later: "// target\nexport const answer = 3;\nexport const other = 0;\n" });
    const before = originHead();
    const res = (await resolveVesselMitosisCutover(pointer(L) as never)) as { shape: string; body: Record<string, any> };
    expect(res.body.kind).toBe("revert_conflict");
    expect(originHead()).toBe(before);
    expect(cloneSettled()).toEqual({ clean: "", atOrigin: true, revertHead: false });
  });

  it("an empty revert (the change is already gone) is skip_reason already_reverted, with nothing committed", async () => {
    const { L } = await fixture({ alreadyReverted: true });
    const before = originHead();
    const res = (await resolveVesselMitosisCutover(pointer(L) as never)) as { shape: string; body: Record<string, any> };
    expect(res.body.skip_reason).toBe("already_reverted");
    expect(originHead()).toBe(before);
    expect(cloneSettled()).toEqual({ clean: "", atOrigin: true, revertHead: false });
  });

  it("the precutover suite still gates a revert: a tree it turns red is refused precutover_regression and aborted", async () => {
    const { L } = await fixture();
    suiteRed = true;
    const before = originHead();
    const res = (await resolveVesselMitosisCutover(pointer(L) as never)) as { shape: string; body: Record<string, any> };
    expect(res.body.kind).toBe("precutover_regression");
    expect(originHead()).toBe(before);
    expect(cloneSettled()).toEqual({ clean: "", atOrigin: true, revertHead: false });
  });

  it("a landing that added a file is refused revert_deletes_files, before the clone is touched", async () => {
    const { L } = await fixture({ addsFile: true });
    const before = originHead();
    const res = (await resolveVesselMitosisCutover(pointer(L, { revert_of: { sha: L, attempt_id: ATT, settlement_key: `${ATT}#2`, gap_id: GAP, files: [F, "src/new-module.ts"] } }) as never)) as { shape: string; body: Record<string, any> };
    expect(res.body.kind).toBe("revert_deletes_files");
    expect(originHead()).toBe(before);
    expect(cloneSettled()).toEqual({ clean: "", atOrigin: true, revertHead: false });
  });

  it("a revert is autonomous work: one touching an autonomy-scope excluded path is refused at the chokepoint", async () => {
    // PLAN3 guard 8 holds here as well as in the reader: the revert registers directed:false and carries its real
    // files in staged_files from entry, so the cutover's autonomy-scope gate checks them like any undirected landing.
    const setScope = (cutoverMod as unknown as { __setAutonomyScopeDefaultForTests?: (r: (() => Promise<unknown>) | null) => void }).__setAutonomyScopeDefaultForTests;
    expect(typeof setScope).toBe("function");
    setScope!(async () => ({ excluded: [`repos/${VESSEL}/${F}`], readable: true, reason: "fixture: the reverted file is excluded" }));
    const { L } = await fixture();
    const before = originHead();
    const res = (await resolveVesselMitosisCutover(pointer(L) as never)) as { shape: string; body: Record<string, any> };
    expect(res.body.kind).toBe("autonomy_scope_excluded");
    expect(originHead()).toBe(before);
    expect(cloneSettled()).toEqual({ clean: "", atOrigin: true, revertHead: false });
  });

  it("a malformed revert_of (the leaked literal-template values) is refused, never run", async () => {
    const { L } = await fixture();
    const before = originHead();
    for (const bad of [
      { sha: "sha", attempt_id: "attemptId", settlement_key: "attemptId#2", gap_id: "g.id", files: [F] },
      { sha: L, attempt_id: ATT, settlement_key: `${ATT}#2`, gap_id: GAP, files: ["../escape.ts"] },
      { sha: L.slice(0, 12), attempt_id: ATT, settlement_key: `${ATT}#2`, gap_id: GAP, files: [F] },
    ]) {
      const res = (await resolveVesselMitosisCutover(pointer(L, { revert_of: bad }) as never)) as { shape: string; body: Record<string, any> };
      expect(res.shape).toBe("structuredError");
      expect(res.body.kind).toBe("revert_of_malformed");
    }
    expect(originHead()).toBe(before);
  });
});
