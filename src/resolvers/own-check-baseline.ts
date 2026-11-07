/**
 * THE OWN-CHECK BASELINE (activity development-vessel:own-check-baseline, seed/own-check-baseline.ts).
 *
 * A gap's own check (its evidence_resolve test_suite input) is run ONCE on a pinned base sha, its vessel's origin/dev, and
 * the run is classified by why it is red or green there:
 *   - green_at_parent      the named tests pass at base: a draft cannot be certified by the check;
 *   - red_code_reachable   red, and nothing says the red is the test's environment: code the check runs is the target;
 *   - red_environmental    red because of where the check runs, not what the code does: a live client the test imports
 *                          answering nothing (an empty result asserted non-empty), or a precondition failure (a refused
 *                          connection, a timeout). The signals are the shaped ownCheckEnvironmentPolicy, read at use time;
 *   - unrunnable           no measurement (no row, no check, a run that printed no summary, named tests not in the file).
 * The reading is written onto the gap row (classification_metadata.own_check_baseline) through the substrateGap write
 * shape, so the gap-store holder keeps it and every node reads it with the row it already has: admission excludes a gap
 * green or environmental at the CURRENT base (gap-admission.ts), and the compose grounds its draft on the check's call
 * path and reuses the reading for its parent comparison (feature-compose.ts ownParentRun).
 *
 * The policy fails safe: absent, unreadable or invalid, no signal fires and nothing is environmental (a red check stays
 * admitted, as before this existed). The per-tick bound of the measuring trigger (gap-check-supply.ts) lives in it too.
 */
import type { ResolverResult } from "./types.js";
import { readShapedPolicy, type PolicySpec, type ShapedPolicy } from "../lib/signal-window.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";
import { resolveTestSuite, testSuiteFileProblem } from "./test-suite.js";
import { sweepGitOut } from "../judge/gap-check-judge.js";
import type { CallPathEntry, CheckRunClass, OwnCheckFailure } from "./retry-evidence.js";
import * as credit from "./own-check-baseline-credit.js";
import { ownCheckVesselOf } from "../judge/gap-eligibility.js";

type Row = Record<string, unknown>;

// ── the policy ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const OWN_CHECK_ENV_POLICY_NAME = "ownCheckEnvironmentPolicy";
export interface OwnCheckEnvPolicy {
  live_client_imports: string[];
  empty_result_received: string[];
  count_assert_expected: string[];
  precondition_failure_text: string[];
  min_failures_for_env: number;
  require_all_failures_empty: number;
  own_check_baseline_per_tick: number;
}
/** EMPTY literal lists and a ZERO bound: with no policy file nothing is measured and nothing reads environmental (as
 *  before this existed). The policy, written through the normal policy path, turns both on. */
export const DEFAULT_OWN_CHECK_ENV_POLICY: OwnCheckEnvPolicy = {
  live_client_imports: [], empty_result_received: [], count_assert_expected: [], precondition_failure_text: [],
  min_failures_for_env: 1, require_all_failures_empty: 1, own_check_baseline_per_tick: 0,
};
export const OWN_CHECK_ENV_POLICY_SPEC: PolicySpec<OwnCheckEnvPolicy> = {
  live_client_imports: { kind: "literals", max_items: 32, max_len: 120 },
  empty_result_received: { kind: "literals", max_items: 32, max_len: 60 },
  count_assert_expected: { kind: "literals", max_items: 32, max_len: 60 },
  precondition_failure_text: { kind: "literals", max_items: 32, max_len: 120 },
  min_failures_for_env: { kind: "int", min: 1, max: 1000 },
  require_all_failures_empty: { kind: "int", min: 0, max: 1 },
  own_check_baseline_per_tick: { kind: "int", min: 0, max: 50 },
};
export function readOwnCheckEnvPolicy(env: Record<string, string | undefined> = process.env): Promise<ShapedPolicy<OwnCheckEnvPolicy>> {
  const d = DEFAULT_OWN_CHECK_ENV_POLICY;
  return readShapedPolicy(OWN_CHECK_ENV_POLICY_NAME, { ...d, live_client_imports: [], empty_result_received: [], count_assert_expected: [], precondition_failure_text: [] }, OWN_CHECK_ENV_POLICY_SPEC, env);
}

// ── the classification ─────────────────────────────────────────────────────────────────────────────────────────────
export type OwnCheckBaselineVerdict = "green_at_parent" | "red_code_reachable" | "red_environmental" | "unrunnable";
export type EnvPolicyState = "policy" | "absent" | "invalid";
export type EnvSignal = "S_live_import" | "S_empty_received" | "S_count_expected" | "S_precondition";
export type OwnCheckBaseline = {
  gap_id: string; vessel: string; test_file: string; only_tests: string[]; base_sha: string;
  verdict: OwnCheckBaselineVerdict; why?: string;
  red: string[] | null; failing: OwnCheckFailure[]; expect_count: number | null;
  call_path: CallPathEntry[]; call_path_source: "frames" | "static" | null;
  env_signals: EnvSignal[]; env_policy: EnvPolicyState;
  dispatch_id: string | null; measured_at: string;
  /** Stamped once by the consumer that used the reading to decide (admission's exclusion): the content grade's join. */
  consumed?: { by: "admission"; at: string };
};

const envPolicyState = (p: ShapedPolicy<OwnCheckEnvPolicy>): EnvPolicyState => (!p.ok ? "invalid" : p.source === "policy" ? "policy" : "absent");

/**
 * The verdict of one test_suite body of the check's file at base. `importSpecs` are the check file's import
 * specifiers (read at base). Environmental only under a policy READ FROM ITS FILE: the defaults decide nothing.
 */
export function classifyOwnCheckRun(run: Row | null, onlyTests: string[], importSpecs: string[], policy: ShapedPolicy<OwnCheckEnvPolicy>, testFile?: string): { verdict: OwnCheckBaselineVerdict; why?: string; env_signals: EnvSignal[]; env_policy: EnvPolicyState } {
  const env_policy = envPolicyState(policy);
  const none = { env_signals: [] as EnvSignal[], env_policy };
  // A CHECK THAT IS NOT A TEST MODULE MEASURES NOTHING (test-suite.ts testSuiteFileProblem, the arming rule): a gap whose
  // evidence_resolve names a source file was read red_code_reachable, which says code the check runs is the target.
  if (testFile !== undefined) { const why = testSuiteFileProblem(testFile); if (why) return { verdict: "unrunnable", why, ...none }; }
  if (!run) return { verdict: "unrunnable", why: "the check's run returned no test_suite report", ...none };
  if (run["filter_matched_none"] === true) return { verdict: "unrunnable", why: "none of the named tests is in the check file at base", ...none };
  if (run["ran"] !== true) return { verdict: "unrunnable", why: "the check's run printed no bun summary", ...none };
  const rnp = typeof run["requested_not_passing"] === "number" ? (run["requested_not_passing"] as number) : null;
  const green = onlyTests.length > 0 ? rnp === 0 : Number(run["fail"] ?? 1) === 0 && Number(run["pass"] ?? 0) > 0;
  if (green) return { verdict: "green_at_parent", ...none };
  // A RED WITH NO FAILING TEST AND NO expect() LINE MEASURED NOTHING the classes below can read: a file that failed to load,
  // or a run with no test in it. Not code-reachable (there is no failing assertion, and so no call path, to ground on).
  if ((Array.isArray(run["own_failing"]) ? (run["own_failing"] as unknown[]).length : 0) === 0 && typeof run["expect_count"] !== "number") {
    return { verdict: "unrunnable", why: "the check's run is red with no failing test and no expect() line: nothing was measured", ...none };
  }
  if (!policy.ok || policy.source !== "policy") return { verdict: "red_code_reachable", ...none };
  const pol = policy.policy;
  const rr = (run["red_reason"] ?? null) as CheckRunClass | null;
  const failures = rr?.failures ?? [];
  const compared = rr?.compared ?? [];
  const has = (text: string | null | undefined, lits: string[]): boolean => !!text && lits.some((l) => text.includes(l));
  const signals: EnvSignal[] = [];
  const errors = [...failures.map((f) => f.error), rr?.unhandled_error ?? null];
  if (failures.some((f) => f.cause === "network" || f.cause === "timeout") || rr?.unhandled_cause === "network" || rr?.unhandled_cause === "timeout"
    || errors.some((e) => has(e, pol.precondition_failure_text))) signals.push("S_precondition");
  if (importSpecs.some((s) => has(s, pol.live_client_imports))) signals.push("S_live_import");
  const emptyAll = compared.length > 0 && compared.every((c) => c.received !== null && pol.empty_result_received.includes(c.received.trim()))
    && (pol.require_all_failures_empty !== 1 || compared.length === failures.length);
  if (emptyAll) signals.push("S_empty_received");
  if (compared.some((c) => has(c.expected, pol.count_assert_expected)) || failures.some((f) => has(f.error, pol.count_assert_expected))) signals.push("S_count_expected");
  const enough = failures.length >= pol.min_failures_for_env || rr?.unhandled === true;
  const env = enough && (signals.includes("S_precondition")
    || (signals.includes("S_live_import") && signals.includes("S_empty_received") && (signals.includes("S_count_expected") || pol.require_all_failures_empty === 1)));
  return { verdict: env ? "red_environmental" : "red_code_reachable", env_signals: signals, env_policy };
}

// ── reading it back: ownCheckVesselOf / ownCheckBaselineFor live in the judge core (judge/gap-eligibility.ts), which
// admission reads them from; the core imports nothing from this module.

// ── the classify resolver ──────────────────────────────────────────────────────────────────────────────────────────
const clonesRoot = (): string => process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";
const SHA40 = /^[0-9a-f]{40}$/;

export type OwnCheckBaselinePointer = { type?: "own_check_baseline_classify"; gap_id?: unknown; base_ref?: unknown };
export type OwnCheckBaselineDeps = {
  runTestSuite?: (input: Row) => Promise<ResolverResult>;
  git?: (dir: string, args: string[]) => string | null;
  env?: Record<string, string | undefined>;
  credit?: import("./own-check-baseline-credit.js").CreditDeps;
};

async function readRow(id: string): Promise<Row | null | "unreadable"> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  if (r?.shape !== "substrateGap") return "unreadable";
  return (((r.body ?? {}) as { gaps?: Row[] }).gaps ?? [])[0] ?? null;
}

export async function resolveOwnCheckBaselineClassify(pointer: OwnCheckBaselinePointer, deps: OwnCheckBaselineDeps = {}): Promise<ResolverResult> {
  const err = (detail: string, extra: Row = {}): ResolverResult => ({ shape: "structuredError", body: { resolver: "own_check_baseline_classify", detail, ...extra } });
  const id = typeof pointer.gap_id === "string" ? pointer.gap_id.trim() : "";
  if (!id || id.includes("{{")) return err("gap_id is required", { failure_mode: "validation_rejected", field: "gap_id" });
  const git = deps.git ?? sweepGitOut;
  const row = await readRow(id);
  if (row === "unreadable") return err(`the gap store could not be read for ${id}`);
  if (!row) return err(`no gap row ${id}`);
  const meta = (row["classification_metadata"] ?? {}) as Row;
  const vessel = ownCheckVesselOf(meta);
  const er = (meta["evidence_resolve"] ?? {}) as { input?: Row };
  const testFile = String(er.input?.["test_file"] ?? "").replace(/^(\.\/)+/, "");
  const onlyTests = Array.isArray(er.input?.["only_tests"]) ? (er.input!["only_tests"] as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  if (!vessel || !/^[A-Za-z0-9_.-]+$/.test(vessel)) return err(`gap ${id} has no test_suite own check`, { failure_mode: "validation_rejected", field: "evidence_resolve" });
  const clone = `${clonesRoot()}/${vessel}`;
  const asked = typeof pointer.base_ref === "string" ? pointer.base_ref.trim() : "";
  const base = SHA40.test(asked) ? asked : (git(clone, ["rev-parse", "origin/dev"]) ?? "");
  if (!SHA40.test(base)) return err(`no base sha for ${vessel} (origin/dev unreadable in its clone)`);
  const policy = await readOwnCheckEnvPolicy(deps.env);

  // A check file test_suite cannot run as a test module is not run (classifyOwnCheckRun reads it unrunnable).
  const run = testSuiteFileProblem(testFile) ? null : await (deps.runTestSuite ?? ((i: Row) => resolveTestSuite(i as never)))({ type: "test_suite", vessel: `repos/${vessel}`, test_file: testFile, only_tests: onlyTests, base_ref: base, gap_id: id });
  const body = run?.shape === "test_suite" ? ((run.body ?? {}) as Row) : null;
  // The check file and its imports AS OF THE BASE (the run's worktree is gone): git show base:<path> in the clone.
  const readAtBase = (rel: string): string | null => git(clone, ["show", `${base}:${rel}`]);
  const checkSrc = readAtBase(testFile);
  const fc = await import("../gates/own-check-static.js");
  const importSpecs = checkSrc ? [...fc.relativeImportBindings(checkSrc, true).values()] : [];
  const c = classifyOwnCheckRun(body, onlyTests, importSpecs, policy, testFile);
  const failing = (Array.isArray(body?.["own_failing"]) ? body!["own_failing"] : []) as OwnCheckFailure[];
  // THE CALL PATH: the run's frames; when they name none (an expect() on a returned value), the static path of the
  // failing tests' calls through the check's imports (feature-compose staticCheckCallPath), read at base.
  let call_path = (Array.isArray(body?.["call_path"]) ? body!["call_path"] : []) as CallPathEntry[];
  let call_path_source: OwnCheckBaseline["call_path_source"] = call_path.length > 0 ? "frames" : null;
  if (call_path.length === 0 && c.verdict === "red_code_reachable" && checkSrc && failing.length > 0) {
    call_path = fc.staticCheckCallPath({ vessel_root: clone, test_file: testFile, failing, prefix: `repos/${vessel}/`, read: readAtBase });
    call_path_source = call_path.length > 0 ? "static" : null;
  }
  // The dispatch that asked for this run (the trigger records it on the row once goal-host answers, before the walk
  // reaches here; re-read, since the row read above may predate it).
  const reread = await readRow(id);
  const dmeta = (reread && reread !== "unreadable" ? (reread["classification_metadata"] ?? {}) : meta) as Row;
  const disp = credit.baselineDispatchAt(dmeta, base);
  const projection: OwnCheckBaseline = {
    gap_id: id, vessel, test_file: testFile, only_tests: onlyTests, base_sha: base,
    verdict: c.verdict, ...(c.why ? { why: c.why } : {}),
    red: Array.isArray(body?.["own_red"]) ? (body!["own_red"] as string[]) : null,
    failing, expect_count: typeof body?.["expect_count"] === "number" ? (body!["expect_count"] as number) : null,
    call_path, call_path_source, env_signals: c.env_signals, env_policy: c.env_policy,
    dispatch_id: disp?.dispatch_id ?? null,
    measured_at: new Date().toISOString(),
  };
  // A MERGE through the write shape (forwarded to the gap-store holder on a node that is not it): one key is sent.
  const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open", classification_metadata: { own_check_baseline: projection } } } as never);
  const written = w?.shape !== "structuredError";
  // THE RE-MEASURE GRADES ITS PREDECESSOR (own-check-baseline-credit.ts): an environmental reading admission used,
  // read again at a new sha.
  const prev = dmeta["own_check_baseline"] as OwnCheckBaseline | undefined;
  if (written && prev && typeof prev === "object" && prev.base_sha !== base && credit.consumedByAdmission(prev)) {
    const agree = credit.remeasureAgreement(prev, projection);
    const g = await credit.creditOwnCheckBaseline({ gap_id: id, meta: dmeta, baseline: prev, consumer: "remeasure", reached: agree, reason: `re-measured ${projection.verdict} [${projection.env_signals.join(",")}] at ${base.slice(0, 12)}` }, deps.credit);
    console.log(`[own-check-baseline] ${id}: predecessor at ${prev.base_sha.slice(0, 12)} (${prev.verdict}): ${g.posted ? "graded" : "not graded"} (${g.why})`);
  }
  console.log(`[own-check-baseline] ${id}: ${projection.verdict} at ${base.slice(0, 12)} (${vessel}/${testFile}) env_policy=${projection.env_policy} signals=[${projection.env_signals.join(",")}] call_path=${projection.call_path.length}${call_path_source ? `(${call_path_source})` : ""} written=${written}${written ? "" : ` (${JSON.stringify(w?.body ?? null).slice(0, 200)})`}`);
  return { shape: "ownCheckBaseline", body: { ...projection, written } };
}
