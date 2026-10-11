// AUTO-REVERT OF A REGRESSED LANE LANDING (contained-self-development 8.3 / 8.4 / 8.6; PLAN3 §2 must-fails F1-F12, M0).
//
// The reader (gap-to-feature autoRevertRegressedLandings) takes the LOCAL LEDGER's regressed settlements and reverts
// each owned, autonomous, fresh lane landing once, through the revert cutover (vessel-mitosis-cutover.ts REVERT_OF).
// Each row below is a decision the reader must make, read from its one `[auto-revert]` line, the cutover calls, the
// commits on the fixture origin and the attemptRevert marker. Rows that must land a revert (F1, F4, F8, F11) drive
// the REAL cutover pushing to a temp bare origin; rows decided before any cutover use a counting stub, so a guard
// that fails shows as a call.
//
// Hermetic: temp bare origin + clone under VESSELS_CLONE_ROOT (= the cutover's MITOSIS_PUSH_CLONE_DIR, so the
// reverted-in-a-clone check sees the revert), the attempt ledger in ATTEMPT_LEDGER_DIR, tuning, unit start time, gap
// store and autonomy scope through the reader's seam (__setAutoRevertDepsForTests), the cutover's network behind the
// shared fetch guard and every fs write outside os.tmpdir() blocked and recorded by the shared fs guard. Nothing here
// reads or writes a live ledger, /vessels or /workspace, or pushes to a real remote.
//
// The module paths gap-to-feature captures at load (the class posterior among them) are pointed at this file's temp
// root BEFORE the first import; the imports are therefore dynamic.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "auto-revert-test-"));
const LOAD_ENV: Record<string, string> = {
  GAP_CLASS_POSTERIOR_PATH: join(ROOT, "gap-class-posteriors.json"),
  EXPECTATION_CALIB_PATH: join(ROOT, "expectation-calibration.json"),
  CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
};
const savedLoadEnv: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(LOAD_ENV)) { savedLoadEnv[k] = process.env[k]; process.env[k] = v; }

type Gtf = typeof import("../../src/judge/gap-landing-verdict.js");
type Cut = typeof import("../../src/resolvers/vessel-mitosis-cutover.js");
type Ledger = typeof import("../../src/resolvers/attempt-ledger.js");
type FetchMod = typeof import("./cutover-fetch-guard.js");
type FsMod = typeof import("./cutover-fs-guard.js");
let gtf: Gtf, cut: Cut, ledger: Ledger, fetchMod: FetchMod, fsMod: FsMod;

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_SKIP_CLONE_RESET", "PUSH_POLICY_PATH", "CUTOVER_PRECHECK_SUITE", "MAINTENANCE_LEASE_PATH",
  "GAP_STORE_ENDPOINT", "ATTEMPT_LEDGER_DIR", "VESSELS_CLONE_ROOT",
] as const;
const saved: Record<string, string | undefined> = {};
const VESSEL = "fixvessel";
const GAP = "gap-auto-revert-fixture";
const HOUR = 3_600_000;
const TUNING: Record<string, number> = { AUTO_REVERT_MAX_AGE_MS: HOUR, AUTO_REVERT_STRIKE_LIMIT: 2, AUTO_REVERT_HOLD_REVIEW_MS: 7 * 24 * HOUR };
const BUN_FAILING =
  "bun test v1.3.14 (0d9b296a)\n\ntest/target.test.ts:\n(fail) target > keeps the landed line [0.20ms]\n\n 0 pass\n 1 fail\n 1 expect() calls\nRan 1 test across 1 file. [9.00ms]\n";

let ws = "";
let guard: import("./cutover-fetch-guard.js").FetchGuard;
let fsGuard: import("./cutover-fs-guard.js").FsGuard;
let lines: string[] = [];
let origWarn: typeof console.warn;
let origError: typeof console.error;
let gaps: Map<string, Record<string, any>>;
let gapWrites: Array<Record<string, any>>;
let dropGapWrites = false;
let cutoverCalls = 0;
let suiteRed = false;
let tuning: Record<string, number | null> = { ...TUNING };
let scope: { excluded: string[]; readable: boolean; reason: string } = { excluded: [], readable: true, reason: "fixture: explicitly unrestricted" };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
const origin = () => join(ws, "origin.git");
const seed = () => join(ws, "seed");
const clone = () => join(ws, "vessels", VESSEL);
const originHead = () => git(ws, "--git-dir", origin(), "rev-parse", "dev");
const originCount = () => Number(git(ws, "--git-dir", origin(), "rev-list", "--count", "dev"));
async function put(root: string, rel: string, content: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}
function ident(cwd: string): void {
  git(cwd, "config", "user.email", "lane@example.com");
  git(cwd, "config", "user.name", "Lane Fixture");
  git(cwd, "config", "commit.gpgsign", "false");
}

/** Origin + seed with a base commit of src/f1.ts .. src/f3.ts. */
async function base(): Promise<void> {
  git(ws, "init", "-q", "--bare", "-b", "dev", origin());
  git(ws, "init", "-q", "-b", "dev", seed());
  ident(seed());
  for (const n of [1, 2, 3]) await put(seed(), `src/f${n}.ts`, `// f${n}\nexport const v${n} = 0;\n`);
  git(seed(), "add", "-A");
  git(seed(), "commit", "-q", "-m", "base");
  git(seed(), "remote", "add", "origin", origin());
}
/** A lane landing on src/f<n>.ts carrying `Attempt-Id: <att>` (or the subject/body given). */
async function land(n: number, att: string, opts: { subject?: string; extraBody?: string } = {}): Promise<string> {
  await put(seed(), `src/f${n}.ts`, `// f${n}\nexport const v${n} = ${att.length};\nexport const landed${n} = true;\n`);
  git(seed(), "add", "-A");
  const subject = opts.subject ?? `substrate-authored: apply prop-${n} via mitosis cutover`;
  git(seed(), "commit", "-q", "-m", `${subject}\n\nApplied autonomously by apply_proposal_as_patch + vessel_mitosis_cutover.\nGap: ${GAP}\n${opts.extraBody ?? ""}\nAttempt-Id: ${att}\n`);
  return git(seed(), "rev-parse", "HEAD");
}
/** Push the seed and (re)clone it as the vessel clone. */
async function publish(): Promise<void> {
  git(seed(), "push", "-q", "-f", "origin", "dev");
  rmSync(clone(), { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(ws, "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin(), clone());
  ident(clone());
  for (const n of [1, 2, 3]) await put(join(ws, "runtime", VESSEL), `src/f${n}.ts`, spawnSync("cat", [join(clone(), `src/f${n}.ts`)], { encoding: "utf8" }).stdout);
}
function intent(att: string, rec: Record<string, unknown>): void {
  ledger.appendRecord("attemptIntent", att, { attempt_id: att, route: "feature_compose", repo: clone(), touched_files: [], gap_id: GAP, ...rec });
}
function settle(att: string, seq: 1 | 2, rec: Record<string, unknown>): void {
  ledger.appendRecord("attemptSettlement", `${att}#${seq}`, { attempt_id: att, settlement_seq: seq, verdict: "regressed", credit_eligible: false, ...(seq === 2 ? { gap_id: GAP, source: "falsified_after_restart" } : {}), ...rec });
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function stamp(sha: string, att: string, over: Record<string, unknown> = {}): void {
  gaps.set(GAP, { id: GAP, category: "other", source: "substrate_detected", summary: "fixture", status: "open", classification_metadata: { regressed_by: { sha, at: minutesAgo(5), verdict: "present", attempt_id: att, vessel: VESSEL, revert_sha: null, by: "gap-sweep:falsified_after_restart", ...over } } });
}
function marks(att: string): Array<Record<string, any>> {
  return ledger.readRecords("attemptRevert").map((r) => r.record as Record<string, any>).filter((r) => r["reverted_attempt_id"] === att);
}
const autoLines = () => lines.filter((l) => l.startsWith("[auto-revert]"));
const linesFor = (att: string) => autoLines().filter((l) => l.includes(`settlement=${att}#`));
const decisionsFor = (r: { decisions: Array<{ settlement: string; result: string }> }, att: string) => r.decisions.filter((d) => d.settlement.startsWith(`${att}#`)).map((d) => d.result);

const realCutover = (p: Record<string, unknown>) => {
  cutoverCalls += 1;
  return cut.resolveVesselMitosisCutover({ ...p, skip_restart: true, pending_pointer_path: join(ws, "mitosis-pending.json"), applied_log_path: join(ws, "mitosis-applied.jsonl"), host_sync_intent_path: join(ws, "host-sync.jsonl") } as never);
};
const stubCutover = (answer: () => unknown) => async (_p: Record<string, unknown>) => { cutoverCalls += 1; return answer(); };
const PUSHED = () => ({ shape: "cutoverApplied", body: { push_status: "pushed", new_git_sha: "f".repeat(40) } });

function useDeps(cutover: (p: Record<string, unknown>) => Promise<unknown>, extra: Record<string, unknown> = {}): void {
  gtf.__setAutoRevertDepsForTests({
    cutover,
    unitStartedAt: () => 0,
    tuning: async (name: string) => tuning[name] ?? null,
    readGap: async (id: string) => gaps.get(id) ?? null,
    writeGap: async (gap: Record<string, unknown>) => {
      gapWrites.push(gap as Record<string, any>);
      if (dropGapWrites) return { shape: "substrateGapWriteResult", body: { id: gap["id"], action: "updated" } };
      const ex = gaps.get(String(gap["id"])) ?? {};
      gaps.set(String(gap["id"]), { ...ex, ...gap, classification_metadata: { ...(ex["classification_metadata"] ?? {}), ...((gap["classification_metadata"] ?? {}) as object) } });
      return { shape: "substrateGapWriteResult", body: { id: gap["id"], action: "updated" } };
    },
    scope: async () => scope as never,
    ...extra,
  } as never);
}

beforeAll(async () => {
  fetchMod = await import("./cutover-fetch-guard.js");
  fsMod = await import("./cutover-fs-guard.js");
  cut = await import("../../src/resolvers/vessel-mitosis-cutover.js");
  ledger = await import("../../src/resolvers/attempt-ledger.js");
  gtf = await import("../../src/judge/gap-landing-verdict.js");
});
afterAll(() => {
  fsMod?.restoreCutoverFsModules();
  fetchMod?.restoreCutoverFetch();
  for (const [k, v] of Object.entries(savedLoadEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  ws = mkdtempSync(join(ROOT, "case-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["MITOSIS_DIRECT_PUSH"] = "1";
  process.env["MITOSIS_RUNTIME_DIR"] = join(ws, "runtime");
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "vessels");
  process.env["VESSELS_CLONE_ROOT"] = join(ws, "vessels");
  process.env["MAINTENANCE_LEASE_PATH"] = join(ws, "maintenance-lease.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "ledger");
  gaps = new Map(); gapWrites = []; dropGapWrites = false; cutoverCalls = 0; suiteRed = false;
  tuning = { ...TUNING };
  scope = { excluded: [], readable: true, reason: "fixture: explicitly unrestricted" };
  lines = [];
  origWarn = console.warn; origError = console.error;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const fail = (what: string) => async () => { throw new Error(`${what} must not be reached by a revert`); };
  cut.__setOwnCheckDepsForTests({ readGap: async () => ({ shape: "substrateGap", body: { gaps: [] } }), writeGap: fail("own-check write"), runSuite: fail("own-check run"), lease: fail("gap landing lease") });
  guard = fetchMod.installCutoverFetchGuard();
  fsGuard = fsMod.installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = fetchMod.FIXTURE_GAP_STORE;
  fetchMod.routeFixtureGapStore(guard);
  fetchMod.routeFleetUnreachable(guard);
  (cut as unknown as { __setPrecutoverBaselineForTests: (f: ((v: string) => Promise<string[] | null>) | null) => void }).__setPrecutoverBaselineForTests(async () => ["(fail) unrelated > standing red"]);
  fetchMod.routeShell(guard, () => {
    const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: clone(), encoding: "utf8" }).stdout;
    if (String(subject).startsWith("Revert ")) return fetchMod.BUN_NO_TESTS;
    const tree = spawnSync("cat", [join(clone(), "src/f1.ts")], { encoding: "utf8" }).stdout;
    return suiteRed && !String(tree).includes("landed1") ? BUN_FAILING : fetchMod.BUN_PASSING;
  });
  await base();
});

afterEach(() => {
  console.warn = origWarn; console.error = origError;
  const violations = guard.restore();
  // The one write this file cannot redirect: when another file in the same process imported gap-to-feature first,
  // its class-posterior path was fixed then (M0's recorded landing updates it). The guard BLOCKED that write; it is
  // the only violation tolerated, and only for that file name.
  const fsViolations = fsGuard.restore().filter((v) => !/\/gap-class-posteriors\.json$/.test(v));
  gtf.__setAutoRevertDepsForTests(null);
  cut.__setOwnCheckDepsForTests(null);
  (cut as unknown as { __setPrecutoverBaselineForTests: (f: null) => void }).__setPrecutoverBaselineForTests(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
  expect(fsViolations).toEqual([]);
});

describe("auto-revert: a regressed lane landing is reverted once, by the lane, and nothing else is", () => {
  it("F1: an owned autonomous landing with a fresh #2 regressed settlement is reverted on origin/dev, once", async () => {
    const att = "att-mf1aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    stamp(L, att);
    useDeps(realCutover);
    const before = originCount();
    const parent = git(clone(), "rev-parse", `${L}^`);
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual([expect.stringMatching(/^reverted revert_sha=[0-9a-f]{12}$/)]);
    expect(originCount()).toBe(before + 1);
    const head = originHead();
    const msg = git(ws, "--git-dir", origin(), "log", "-1", "--format=%B", head);
    expect(msg).toContain(`This reverts commit ${L}.`);
    expect(msg).toContain(`Settlement: ${att}#2`);
    expect(git(ws, "--git-dir", origin(), "show", `${head}:src/f1.ts`)).toBe(git(ws, "--git-dir", origin(), "show", `${parent}:src/f1.ts`));
    expect(marks(att).at(-1)).toMatchObject({ status: "done", revert_sha: head });
    const reverted = autoLines().filter((l) => l.includes("result=reverted"));
    expect(reverted.length).toBe(1);
    expect(reverted[0]).toContain(`reverted_sha=${L.slice(0, 12)}`);
    expect(gaps.get(GAP)?.["classification_metadata"]?.["regressed_by"]).toMatchObject({ sha: L, revert_sha: head, revert_status: "done" });
    expect(cutoverCalls).toBe(1);
  });

  it("F2: a #1 held settlement is not a candidate (no cutover, no reverted line)", async () => {
    const att = "att-mf2aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 1, { shas: [L], verdict: "held", credit_eligible: true });
    useDeps(stubCutover(PUSHED));
    const before = originHead();
    await gtf.autoRevertRegressedLandings();
    expect(cutoverCalls).toBe(0);
    expect(autoLines().filter((l) => l.includes("result=reverted"))).toEqual([]);
    expect(originHead()).toBe(before);
  });

  it("F3: an operator-directed landing (intent directed:true) is not reverted: skipped=directed", async () => {
    const att = "att-mf3aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: true });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["skipped=directed"]);
    expect(cutoverCalls).toBe(0);
  });

  it("F3b: an intent with NO directed field (the 40 historical rows) is not autonomous: skipped=directed", async () => {
    const att = "att-mf3bbbb-landing";
    const L = await land(1, att);
    await publish();
    intent(att, {});
    settle(att, 1, { shas: [L] });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["skipped=directed"]);
    expect(cutoverCalls).toBe(0);
  });

  it("F4: a second observation (and a second regressed row) of a reverted landing does not revert it again", async () => {
    const att = "att-mf4aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    stamp(L, att);
    useDeps(realCutover);
    await gtf.autoRevertRegressedLandings();
    const afterFirst = originCount();
    settle(att, 1, { shas: [L] });
    gaps.get(GAP)!["classification_metadata"]["regressed_by"]["revert_sha"] = null; // the store lost the completion
    const r2 = await gtf.autoRevertRegressedLandings();
    expect(originCount()).toBe(afterFirst);
    expect(cutoverCalls).toBe(1);
    expect(decisionsFor(r2, att)).toEqual(["skipped=already_reverted"]);
    expect(linesFor(att).filter((l) => l.includes("result=skipped=already_reverted")).length).toBe(1);
  });

  it("F4b: the ledger marker, written before the cutover, holds when the gap write is dropped and the process dies mid-revert", async () => {
    const att = "att-mf4bbbb-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    dropGapWrites = true;
    useDeps(stubCutover(() => { throw new Error("simulated restart: the process died inside the cutover"); }));
    await gtf.autoRevertRegressedLandings();
    const r2 = await gtf.autoRevertRegressedLandings();
    expect(cutoverCalls).toBe(1);
    expect(decisionsFor(r2, att)).toEqual(["skipped=in_flight"]);
    expect(marks(att).map((m) => m["status"])).toEqual(["pending"]);
  });

  it("F5: a landing that is itself a revert is not reverted (by its commit, and by an auto_revert intent): skipped=is_revert", async () => {
    const a = "att-mf5aaaa-landing";
    const b = "att-mf5bbbb-landing";
    const La = await land(1, a, { extraBody: `This reverts commit ${"a".repeat(40)}.\n\nAuto-Revert: true\n` });
    const Lb = await land(2, b);
    await publish();
    intent(a, { directed: false, route: "vessel_mitosis_cutover" });
    intent(b, { directed: false, route: "auto_revert" });
    settle(a, 2, { shas: [La], at: minutesAgo(5) });
    settle(b, 2, { shas: [Lb], at: minutesAgo(5) });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, a)).toEqual(["skipped=is_revert"]);
    expect(decisionsFor(r, b)).toEqual(["skipped=is_revert"]);
    expect(cutoverCalls).toBe(0);
  });

  it("F6: a settlement older than AUTO_REVERT_MAX_AGE_MS is not reverted: skipped=stale", async () => {
    const att = "att-mf6aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(120) });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["skipped=stale"]);
    expect(cutoverCalls).toBe(0);
  });

  it("F7: an unreadable tuning row fails closed: skipped=no_tuning_row, counted", async () => {
    const att = "att-mf7aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    tuning = { ...TUNING, AUTO_REVERT_MAX_AGE_MS: null };
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["skipped=no_tuning_row name=AUTO_REVERT_MAX_AGE_MS"]);
    expect(gtf.getAutoRevertCounters()["no_tuning_row"]).toBe(1);
    expect(cutoverCalls).toBe(0);
  });

  it("F8: a revert that conflicts with a later edit lands nothing, leaves the clone clean at origin/dev, and is not retried", async () => {
    const att = "att-mf8aaaa-landing";
    const L = await land(1, att);
    await put(seed(), "src/f1.ts", "// f1\nexport const v1 = 99;\nexport const landed1 = 'edited later';\n");
    git(seed(), "commit", "-q", "-am", "a later edit of the landing's lines");
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    useDeps(realCutover);
    const before = originHead();
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["conflict"]);
    expect(originHead()).toBe(before);
    expect(git(clone(), "status", "--porcelain")).toBe("");
    expect(git(clone(), "rev-parse", "HEAD")).toBe(git(clone(), "rev-parse", "origin/dev"));
    expect(marks(att).at(-1)?.["status"]).toBe("conflict");
    const r2 = await gtf.autoRevertRegressedLandings();
    expect(cutoverCalls).toBe(1);
    expect(decisionsFor(r2, att)).toEqual(["skipped=already_attempted status=conflict"]);
  });

  it("F9: two done reverts on the gap put it under an operator hold with a lift condition and a review date; no third revert", async () => {
    const [a1, a2, a3] = ["att-mf9aaaa-one", "att-mf9bbbb-two", "att-mf9cccc-three"];
    await land(1, a1); await land(2, a2);
    const L3 = await land(3, a3);
    await publish();
    for (const a of [a1, a2]) ledger.appendRecord("attemptRevert", `${a}#revert:0:done`, { reverted_attempt_id: a, status: "done", gap_id: GAP, revert_sha: (a === a1 ? "1" : "2").repeat(40), at: minutesAgo(30) });
    intent(a3, { directed: false });
    settle(a3, 2, { shas: [L3], at: minutesAgo(5) });
    gaps.set(GAP, { id: GAP, category: "other", source: "substrate_detected", summary: "fixture", status: "open", classification_metadata: {} });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, a3)).toEqual(["strike_hold"]);
    expect(cutoverCalls).toBe(0);
    const meta = gaps.get(GAP)?.["classification_metadata"] ?? {};
    expect(meta["operator_hold"]).toBe(true);
    expect(meta["disposition"]).toBe("needs_information");
    const hold = meta["auto_revert_hold"] as Record<string, unknown>;
    expect(typeof hold["lift"]).toBe("string");
    expect((hold["lift"] as string).length).toBeGreaterThan(0);
    expect(Date.parse(String(hold["review_by"])) - Date.parse(String(hold["at"]))).toBe(TUNING["AUTO_REVERT_HOLD_REVIEW_MS"]!);
    expect(marks(a3).at(-1)?.["status"]).toBe("strike_hold");
  });

  it("F9 (strikes): a conflict is not a strike, so one done + one conflict still lets a fresh regressed landing be reverted", async () => {
    const [a1, a2, a3] = ["att-mf9dddd-one", "att-mf9eeee-two", "att-mf9ffff-three"];
    await land(1, a1); await land(2, a2);
    const L3 = await land(3, a3);
    await publish();
    ledger.appendRecord("attemptRevert", `${a1}#revert:0:done`, { reverted_attempt_id: a1, status: "done", gap_id: GAP, revert_sha: "1".repeat(40), at: minutesAgo(30) });
    ledger.appendRecord("attemptRevert", `${a2}#revert:0:pending`, { reverted_attempt_id: a2, status: "pending", gap_id: GAP, at: minutesAgo(30) });
    ledger.appendRecord("attemptRevert", `${a2}#revert:1:conflict`, { reverted_attempt_id: a2, status: "conflict", gap_id: GAP, at: minutesAgo(29) });
    intent(a3, { directed: false });
    settle(a3, 2, { shas: [L3], at: minutesAgo(5) });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, a3)).toEqual([`reverted revert_sha=${"f".repeat(12)}`]);
    expect(cutoverCalls).toBe(1);
  });

  it("F9 (reconcile): a revert that landed before its process died counts as a strike once guard 5 sees it", async () => {
    const [a1, a2, a3] = ["att-mf9gggg-one", "att-mf9hhhh-two", "att-mf9iiii-three"];
    await land(1, a1);
    const L2 = await land(2, a2);
    const L3 = await land(3, a3);
    git(seed(), "revert", "--no-edit", L2); // the self-revert landed; its `done` was never written
    await publish();
    ledger.appendRecord("attemptRevert", `${a1}#revert:0:done`, { reverted_attempt_id: a1, status: "done", gap_id: GAP, revert_sha: "1".repeat(40), at: minutesAgo(30) });
    ledger.appendRecord("attemptRevert", `${a2}#revert:0:pending`, { reverted_attempt_id: a2, status: "pending", gap_id: GAP, at: minutesAgo(9) });
    for (const a of [a2, a3]) intent(a, { directed: false });
    settle(a2, 2, { shas: [L2], at: minutesAgo(10) });
    settle(a3, 2, { shas: [L3], at: minutesAgo(5) });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, a2)).toEqual(["skipped=already_reverted"]);
    expect(marks(a2).at(-1)).toMatchObject({ status: "done", reconciled: true });
    expect(decisionsFor(r, a3)).toEqual(["strike_hold"]);
    expect(cutoverCalls).toBe(0);
  });

  it("F10: the leaked literal-template row (g.id / sha / attemptId / vessel) is refused: skipped=malformed, no throw, no write, counted", async () => {
    const att = "att-mf10aaa-landing";
    const L = await land(1, att);
    await publish();
    // (a) the ledger row itself is the literal template.
    ledger.appendRecord("attemptSettlement", "attemptId#2", { attempt_id: "attemptId", settlement_seq: 2, verdict: "regressed", credit_eligible: false, shas: ["sha"], gap_id: "g.id", source: "falsified_after_restart", at: minutesAgo(5) });
    gaps.set("g.id", { id: "g.id", category: "g.category", classification_metadata: { regressed_by: { sha: "sha", at: minutesAgo(5), verdict: "present", attempt_id: "attemptId", vessel: "vessel", revert_sha: null, by: "gap-sweep:falsified_after_restart" } } });
    // (b) a well-formed ledger row whose gap carries the literal stamp.
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    stamp(L, att, { sha: "sha", attempt_id: "attemptId", vessel: "vessel" });
    useDeps(stubCutover(PUSHED));
    const before = JSON.stringify([...gaps.entries()]);
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, "attemptId")).toEqual(["skipped=malformed"]);
    expect(decisionsFor(r, att)).toEqual(["skipped=malformed"]);
    expect(cutoverCalls).toBe(0);
    expect(gapWrites).toEqual([]);
    expect(JSON.stringify([...gaps.entries()])).toBe(before);
    expect(gtf.getAutoRevertCounters()["malformed_regressed_by"]).toBe(2);
    expect(autoLines().filter((l) => l.includes("gap=g.id") && l.includes("result=skipped=malformed")).length).toBe(1);
  });

  it("F11: a revert the precutover suite turns red is refused (precutover_regression) and nothing is pushed", async () => {
    const att = "att-mf11aaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    suiteRed = true;
    useDeps(realCutover);
    const before = originHead();
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["refused reason=precutover_regression"]);
    expect(originHead()).toBe(before);
    expect(git(clone(), "status", "--porcelain")).toBe("");
    expect(marks(att).at(-1)).toMatchObject({ status: "refused", reason: "precutover_regression" });
  });

  it("F12: a landing whose attempt another node registered (no local intent) is not reverted here: skipped=not_owned", async () => {
    const att = "att-mf12aaa-landing";
    const L = await land(1, att);
    await publish();
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["skipped=not_owned"]);
    expect(cutoverCalls).toBe(0);
  });

  it("guard 8: a landing on an autonomy-scope excluded path is escalated, not reverted", async () => {
    const att = "att-mg8aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5) });
    stamp(L, att);
    scope = { excluded: [`repos/${VESSEL}/src/`], readable: true, reason: "fixture: src excluded" };
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual(["skipped=out_of_scope"]);
    expect(cutoverCalls).toBe(0);
    expect(gaps.get(GAP)?.["classification_metadata"]?.["auto_revert_escalation"]).toMatchObject({ kind: "out_of_scope" });
  });

  it("a landing the operator already reverted (an operator_revert settlement) is not a candidate", async () => {
    const att = "att-mopraaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    settle(att, 2, { shas: [L], at: minutesAgo(5), source: "operator_revert", reverted_by: "e".repeat(40) });
    useDeps(stubCutover(PUSHED));
    const r = await gtf.autoRevertRegressedLandings();
    expect(decisionsFor(r, att)).toEqual([]);
    expect(linesFor(att)).toEqual([]);
    expect(cutoverCalls).toBe(0);
    expect(marks(att)).toEqual([]);
  });

  it("M0 (8.4a): the sweep's present branch records #2 regressed once after the unit restarted, and nothing while a restart is pending", async () => {
    const att = "att-mm0aaaa-landing";
    const L = await land(1, att);
    await publish();
    intent(att, { directed: false });
    const committedAt = Number(git(clone(), "log", "-1", "--format=%ct", L));
    const g = { id: GAP, category: "other", source: "substrate_detected", summary: "fixture", status: "open", classification_metadata: {} };
    useDeps(stubCutover(PUSHED), { unitStartedAt: () => committedAt - 10 });
    expect(await gtf.__recordFalsifiedAutonomousLandingForTests(g, {}, L)).toBe("awaiting_restart");
    expect(ledger.readRecords("attemptSettlement", { key: `${att}#2` })).toEqual([]);
    useDeps(stubCutover(PUSHED), { unitStartedAt: () => committedAt + 10 });
    expect(await gtf.__recordFalsifiedAutonomousLandingForTests(g, {}, L)).toBe("recorded");
    expect(await gtf.__recordFalsifiedAutonomousLandingForTests(g, {}, L)).toBe("recorded");
    const rows = ledger.readRecords("attemptSettlement", { key: `${att}#2` });
    expect(rows.length).toBe(1);
    expect(rows[0]!.record).toMatchObject({ verdict: "regressed", source: "falsified_after_restart", shas: [L], gap_id: GAP });
    expect(gapWrites.at(-1)?.["classification_metadata"]?.["regressed_by"]).toMatchObject({ sha: L, attempt_id: att, vessel: VESSEL, revert_sha: null, by: "gap-sweep:falsified_after_restart" });
  });
});
