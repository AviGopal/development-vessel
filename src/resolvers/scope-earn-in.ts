/**
 * SCOPE EARN-IN — autonomy earns its way into the core by the adopted criterion (REALIGNMENT §7 step 9, C8/C20).
 * WIRING, NOT A NEW SUBSYSTEM (§2.0): every organ below exists; the one mint is the mutation runner, which is an
 * extension of test_suite's base-tree run (mutate_revert), because "covered" is defined by a mutation and nothing in
 * the fleet ran one.
 *
 * THE CRITERION (user ruling 10-03, goal-learn-flow/WIRING.md "scope widening on evidence is ADOPTED" and "covered is
 * defined by MUTATION"). A file leaves autonomyScope excluded_paths when the armed check-first suites cover the
 * behaviours its regressions have historically broken:
 *   - REGRESSIONS: the gap store is the inventory. A row whose edit site is the file and that carries
 *     classification_metadata.regressed_by (a falsified or reverted landing) or reopen_count > 0 (a closure that did
 *     not hold). No regression history on record proposes nothing: vacuous coverage is the gameable-metric class.
 *   - MAPPED: each regression's own row is armed (falsifier class1/class2) with a test_suite check naming its tests.
 *     An unmapped regression keeps the file excluded and names the missing check.
 *   - COVERED BY MUTATION: on the accepted tree (the vessel clone's HEAD, base_ref HEAD) the must-fail is green, and
 *     with the guard commit's change to the file reverse-applied (landed_sha / landed_commit, else the revert
 *     regressed_by.revert_sha) every named test fails. Survives, red at HEAD, or an unappliable mutation: no proposal.
 *   - NEVER RUNTIME GLUE: a path executed straight from the clone (scripts/**, or named by a unit under
 *     ${SUBSTRATE_ROOT}) goes live within one tick of a landing, ungated by pull-sync, so it is never proposed and the
 *     evaluator refuses it.
 *
 * TWO ROLES, NEVER ONE (no self-certification, K15/K18; "there shouldn't be a trust root per-se", 10-02):
 *   - PROPOSER (scope_earn_in_tick, a seeded tick activity gated on its own timeShapedRhythm "scope-earn-in"): writes
 *     an autonomyScopeProposal {path, change, evidence, criterion_version}. It holds no credential and never writes
 *     autonomyScope (the pool refuses it: trust-root shape).
 *   - EVALUATOR (scope_earn_in_apply, run by the accepted code beside the landing sweep in gap_to_feature): reads a
 *     proposal only for {path, change}, RE-RUNS the criterion itself on the live store and the accepted tree (never
 *     reading the proposal's evidence), and only then writes autonomyScope through the pool's one writer with the
 *     evaluator grant (EVALUATOR_TRUST_ROOT_WRITERS), an append-only autonomyScopeChange record (who, what, its own
 *     evidence, a one-step undo) and a notice on the surface humans read (uiPanel_write). Humans are informed, never
 *     gating.
 *   - TIGHTENING needs less evidence (an open, unreverted regressed_by on the file) and carries a TTL hold; a hold is
 *     lifted by expiry (or by a widening that meets the criterion), never by deleting a record.
 *
 * EXIT METRIC (§7 step 9): criterion-made changes applied with no operator record edit in between. Each change record
 * stores the scope row's prior attestation; an operator write in between resets the consecutive count.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { WORKSPACE_ROOT } from "../config.js";
import { readFamilyRhythm, rhythmDueScore, writeFamilyRhythm, type RhythmBody } from "./rhythm-conductor-tick.js";
import { gapCheckKeys } from "./gap-to-feature.js";
import { resolvePoolImpulse, resolvePoolImpulseWrite, type PoolWriteAuth } from "./pool-impulse.js";

export const SCOPE_EARN_IN_FAMILY = "scope-earn-in";
export const SCOPE_CRITERION_VERSION = "wiring-2026-10-03";
export const SCOPE_EVALUATOR = "scope_earn_in_apply";
export const PROPOSAL_SHAPE = "autonomyScopeProposal";
export const CHANGE_SHAPE = "autonomyScopeChange";
export const GLUE_REASON = "runtime glue is executed from the clone (ungated)";
/**
 * THE EVALUATOR'S OWN FILES. The criterion may never move the code that judges it into autonomous reach: a lane
 * landing there could weaken the re-run, the mutation runner, the pool grant or the landing verdict and then certify
 * itself (no self-certification, K15/K18). A proposal touching any of these is REFUSED by the proposer and the
 * evaluator alike, whatever excluded_paths says. The grant-scan test that pins "only this file constructs the
 * evaluator grant" is listed too.
 */
export const EVALUATOR_FILES: readonly string[] = [
  "repos/development-vessel/src/resolvers/scope-earn-in.ts",
  "repos/development-vessel/src/resolvers/pool-impulse.ts",
  "repos/development-vessel/src/resolvers/test-suite.ts",
  "repos/development-vessel/src/resolvers/gap-to-feature.ts",
  "repos/development-vessel/src/resolvers/feature-compose.ts",
  "repos/development-vessel/test/resolvers/scope-earn-in.test.ts",
  "repos/development-vessel/test/resolvers/evaluator-grant-scan.test.ts",
  // The judge of scope changes: self-fact autonomy_scope_pinned, and the test that pins what it accepts.
  "repos/development-vessel/src/resolvers/self-fact-reconcile.ts",
  "repos/development-vessel/test/resolvers/scope-change-pin.test.ts",
  // The evaluator's pacing (readFamilyRhythm / writeFamilyRhythm and the due formula) lives here.
  "repos/development-vessel/src/resolvers/rhythm-conductor-tick.ts",
  // Operator-excluded 10-05 and on the evaluator's own import closure (evaluator-grant-scan.test.ts): the trust-root
  // gate's identity check, the self-call auth of the rhythm read/write, and a self-fact row helper.
  "repos/development-vessel/src/lib/caller-credential.ts",
  "repos/development-vessel/src/lib/self-auth.ts",
  "repos/development-vessel/src/resolvers/retry-evidence.ts",
];
export const EVALUATOR_FILE_REASON = "refused: the path is one of the evaluator's own files (EVALUATOR_FILES)";
export function isEvaluatorFile(path: string): boolean {
  const target = canonicalScopePath(path);
  return EVALUATOR_FILES.some((f) => target === f || (target.endsWith("/") && f.startsWith(target)));
}
const MAX_TTL_HOURS = 720;
const MAX_APPLY_PER_PASS = 5;

type Row = Record<string, unknown>;
type Scope = { excluded: string[]; readable: boolean; reason: string };
type Rhythm = { id: string; body: RhythmBody & Row; updated_at?: string };

export type ScopeEarnInDeps = {
  readGaps: () => Promise<Row[]>;
  readScope: () => Promise<Scope>;
  readRhythm: () => Promise<Rhythm | null>;
  /** Merge `overlay` into the family's rhythm row; with ifUpdatedAt a compare-and-set (false: someone moved it first). */
  pace: (rhythm: Rhythm, overlay: Row, ifUpdatedAt?: string) => Promise<boolean>;
  /** One test_suite run (its body), or null when it could not be asked. */
  runCheck: (input: Row) => Promise<Row | null>;
  poolRead: (shape: string) => Row[];
  poolWrite: (pointer: Row, auth?: PoolWriteAuth) => { body: { ok: boolean; error?: string; conflict?: boolean } };
  report: (panel: Row) => Promise<void>;
  unitsText: () => string | null;
  /** The commit the RUNTIME runs for a vessel (pull-sync's last-good pin), or null when none is recorded. */
  runtimeSha: (vessel: string) => string | null;
  now: () => number;
};

const defaultDeps: ScopeEarnInDeps = {
  readGaps: async () => {
    const { resolveSubstrateGap } = await import("./substrate-gap.js");
    const r = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
    return (((r.body ?? {}) as { gaps?: Row[] }).gaps ?? []).filter((g) => typeof g["id"] === "string");
  },
  readScope: async () => {
    const { autonomyScope } = await import("./gap-to-feature.js");
    return autonomyScope();
  },
  readRhythm: () => readFamilyRhythm(SCOPE_EARN_IN_FAMILY),
  pace: (rhythm, overlay, ifUpdatedAt) => writeFamilyRhythm(rhythm, overlay, "scope-earn-in-tick", ifUpdatedAt),
  runCheck: async (input) => {
    const { resolveTestSuite } = await import("./test-suite.js");
    const r = await resolveTestSuite({ type: "test_suite", ...input });
    return r.shape === "test_suite" ? (r.body as Row) : null;
  },
  poolRead: (shape) => resolvePoolImpulse({ type: "poolImpulse", shape }).body.impulses as unknown as Row[],
  poolWrite: (pointer, auth) => resolvePoolImpulseWrite(pointer as Parameters<typeof resolvePoolImpulseWrite>[0], auth),
  report: async (panel) => {
    const { resolveUiWritePassthrough } = await import("./ui-write-passthrough.js");
    await resolveUiWritePassthrough(panel as never);
  },
  unitsText: () => {
    try {
      const dir = join(WORKSPACE_ROOT, "scripts", "substrate", "units");
      return readdirSync(dir).map((f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } }).join("\n");
    } catch {
      return null;
    }
  },
  // pull-sync writes the sha it last mirrored healthy for each vessel to <LAST_GOOD_DIR>/<vessel> (LAST_GOOD_DIR is
  // /workspace/.last-good on every node; the env name is the same bootstrap path pull-sync uses). The clone's HEAD can
  // be ahead of it (pushed, not mirrored), so evidence is judged at this sha: the code that actually runs.
  runtimeSha: (vessel) => {
    try {
      const v = readFileSync(join(process.env["LAST_GOOD_DIR"] ?? "/workspace/.last-good", vessel), "utf8").trim();
      return /^[0-9a-f]{7,40}$/i.test(v) ? v : null;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};
let depsOverride: Partial<ScopeEarnInDeps> | null = null;
/** Tests only: replace any dependency (null restores the defaults). */
export function __setScopeEarnInDepsForTests(d: Partial<ScopeEarnInDeps> | null): void { depsOverride = d; }
const deps = (): ScopeEarnInDeps => ({ ...defaultDeps, ...(depsOverride ?? {}) });

const metaOf = (row: Row): Row => {
  const m = row["classification_metadata"] ?? row["metadata"];
  return (m && typeof m === "object" ? m : {}) as Row;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const HEX = /^[0-9a-f]{7,40}$/i;

/** A path in the scope's own form: `repos/<vessel>/<file>` or a super-repo path such as `scripts/...`. */
export function canonicalScopePath(path: string, vessel?: string): string {
  let s = String(path).replace(/:\d+.*$/, "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
  s = s.replace(/^\/workspace\/git\/super-repo\//, "").replace(/^\/workspace\/git\/vessels\//, "repos/").replace(/^\/vessels\//, "repos/");
  if (s.startsWith("repos/") || s.startsWith("scripts/")) return s;
  const v = str(vessel).replace(/^repos\//, "");
  if (v && /^(src|test|tests|lib|sql)\//.test(s)) return `repos/${v}/${s}`;
  if (/^[A-Za-z0-9_.-]+\/(src|test|tests|lib|sql)\//.test(s)) return `repos/${s}`;
  return s;
}
function siteOf(row: Row): string | null {
  const meta = metaOf(row);
  for (const f of ["edit_site", "file_path", "change_site", "path"]) {
    const v = str(meta[f]);
    if (v) return canonicalScopePath(v, str(meta["vessel"]));
  }
  const top = str(row["file_path"]);
  return top ? canonicalScopePath(top, str(meta["vessel"])) : null;
}

/** Why `path` is runtime glue executed from the clone (never proposed, refused by the evaluator), or null. */
export function runtimeGlueReason(path: string, unitsText: string | null): string | null {
  const rel = canonicalScopePath(path);
  if (rel.startsWith("scripts/")) return `${GLUE_REASON}: scripts/** runs from SUBSTRATE_ROOT, which pull-sync judges but does not guard`;
  if (unitsText && (unitsText.includes("${SUBSTRATE_ROOT}/" + rel) || unitsText.includes("$SUBSTRATE_ROOT/" + rel))) {
    return `${GLUE_REASON}: a unit executes ${rel} from SUBSTRATE_ROOT`;
  }
  return null;
}

export function isRegression(row: Row): boolean {
  const rb = metaOf(row)["regressed_by"];
  return (!!rb && typeof rb === "object") || Number(row["reopen_count"] ?? 0) > 0;
}
/** An open regression whose landing was not reverted: the (lighter) evidence a tightening needs. */
export function isOpenRegression(row: Row): boolean {
  if (String(row["status"] ?? "open") !== "open") return false;
  const rb = metaOf(row)["regressed_by"] as { revert_sha?: unknown } | null | undefined;
  return !!rb && typeof rb === "object" && !str(rb.revert_sha);
}
function armedMustFail(row: Row): { vessel: string; test_file: string | null; only_tests: string[] } | null {
  const meta = metaOf(row);
  const f = meta["falsifier"];
  const cls = String((f && typeof f === "object" ? (f as { class?: unknown }).class : f) ?? "").toLowerCase();
  if (cls !== "class1" && cls !== "class2") return null;
  const er = meta["evidence_resolve"] as { shape?: unknown; input?: Row } | null | undefined;
  if (!er || typeof er !== "object" || er.shape !== "test_suite" || !er.input) return null;
  const only = Array.isArray(er.input["only_tests"]) ? (er.input["only_tests"] as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  const vessel = str(er.input["vessel"]).replace(/^repos\//, "");
  if (only.length === 0 || !vessel) return null;
  return { vessel, test_file: str(er.input["test_file"]) || null, only_tests: only };
}
function guardCommit(row: Row): string | null {
  const meta = metaOf(row);
  const rb = (meta["regressed_by"] ?? {}) as { revert_sha?: unknown };
  for (const v of [meta["landed_sha"], meta["landed_commit"], rb.revert_sha]) if (HEX.test(str(v))) return str(v);
  return null;
}

/** reason_key: the compact class of the outcome ("qualified" when covered), counted in the tick's journal line. */
/**
 * RED FOR THE RIGHT REASON (the judge of a check run; moved here from gap-check-supply.ts, which is lane-editable,
 * because the evaluator must not depend on a file the lane can change. Item 2 imports it from here): the check's own run report shows the run collected tests and EVERY named test is one of
 * its failures. A load or collection error ("Cannot find module", a syntax error, nothing ran) leaves the named
 * tests absent from the failures, so it is not a reproduction, however red the run reads.
 */
export function redForTheRightReason(report: Record<string, unknown> | null, titles: string[]): string | null {
  if (!report) return "no run report: the check's failure cannot be attributed";
  if (report["ran"] === false || !(Number(report["total"] ?? 0) > 0)) return "the test file did not run (load or collection error)";
  const failing = Array.isArray(report["failingTests"]) ? (report["failingTests"] as unknown[]).map(String) : [];
  const missing = titles.find((t) => !failing.some((f) => f.includes(t)));
  return missing === undefined ? null : `the named test "${missing.slice(0, 120)}" is not among the run's failures (a load error, or it passes)`;
}

export type EarnInEvaluation = { path: string; verdict: "covered" | "not_covered" | "unjudgeable"; reason_key: string; reason: string; evidence: Row[]; ran_checks: boolean };

/** The widening criterion for one excluded entry, judged now on the live store and the accepted tree. */
export async function evaluateWidening(path: string, gaps: Row[], d: ScopeEarnInDeps = deps()): Promise<EarnInEvaluation> {
  const out = (verdict: EarnInEvaluation["verdict"], reason_key: string, reason: string, evidence: Row[] = [], ran = false): EarnInEvaluation => ({ path, verdict, reason_key, reason, evidence, ran_checks: ran });
  if (isEvaluatorFile(path)) return out("not_covered", "evaluator_file", EVALUATOR_FILE_REASON);
  if (path.endsWith("/")) return out("not_covered", "directory", "not_evaluated(directory): the criterion is applied per file");
  const glue = runtimeGlueReason(path, d.unitsText());
  if (glue) return out("not_covered", "runtime_glue", glue);
  const target = canonicalScopePath(path);
  const m = target.match(/^repos\/([^/]+)\/(.+)$/);
  if (!m) return out("not_covered", "not_a_vessel_file", `${target} is not a vessel file`);
  const [, vessel, fileRel] = m as unknown as [string, string, string];
  const regs = gaps.filter((g) => siteOf(g) === target && isRegression(g));
  if (regs.length === 0) return out("not_covered", "no_regression_history", "no_regression_history: no gap on record shows a regression in this file, so there is nothing for the criterion to cover");
  // 1. MAP every regression before running anything: one unmapped regression decides the file.
  const mapped: Array<{ id: string; mf: NonNullable<ReturnType<typeof armedMustFail>>; guard: string }> = [];
  for (const g of regs) {
    const id = String(g["id"]);
    const mf = armedMustFail(g);
    if (!mf) return out("not_covered", "unmapped_regression", `regression ${id} maps to no armed must-fail (it needs a class1/class2 test_suite check naming its tests)`);
    if (mf.vessel !== vessel) return out("not_covered", "must_fail_other_vessel", `regression ${id}'s must-fail lives in ${mf.vessel}, not ${vessel}: the mutation cannot run in that tree`);
    const guard = guardCommit(g);
    if (!guard) return out("not_covered", "no_guard_commit", `regression ${id} has no guard commit (landed_sha / landed_commit / regressed_by.revert_sha) to mutate`);
    mapped.push({ id, mf, guard });
  }
  // 2. COVERED BY MUTATION: green on the accepted tree (the sha the RUNTIME runs, never the clone's HEAD, which may be
  // pushed but not mirrored), red there with the guard removed.
  const runtime = d.runtimeSha(vessel);
  if (!runtime) return out("unjudgeable", "no_runtime_pin", `no runtime sha recorded for ${vessel} (pull-sync last-good pin): the accepted tree is unknown`);
  const evidence: Row[] = [];
  for (const { id, mf, guard } of mapped) {
    const input = { vessel: `repos/${vessel}`, ...(mf.test_file ? { test_file: mf.test_file } : {}), only_tests: mf.only_tests, base_ref: runtime };
    const plain = await d.runCheck(input).catch(() => null);
    if (!plain || plain["ran"] !== true) return out("unjudgeable", "must_fail_did_not_run", `regression ${id}: its must-fail did not run on the runtime tree ${runtime.slice(0, 12)}`, evidence, true);
    if (Number(plain["requested_not_passing"] ?? 1) !== 0) return out("not_covered", "red_at_runtime", `regression ${id}: its must-fail is red at the runtime sha ${runtime.slice(0, 12)} without any mutation (the defect is live where it runs)`, evidence, true);
    const mutated = await d.runCheck({ ...input, mutate_revert: { sha: guard, file: fileRel } }).catch(() => null);
    if (!mutated || (mutated["mutation"] as Row | undefined)?.["applied"] !== true) return out("unjudgeable", "mutation_not_applied", `regression ${id}: reverting ${guard.slice(0, 12)} on ${fileRel} could not be applied at the runtime sha ${runtime.slice(0, 12)}`, evidence, true);
    const wrong = redForTheRightReason(mutated, mf.only_tests);
    if (wrong) return out("not_covered", "survives_mutation", `regression ${id}: its must-fail survives the mutation (reverting ${guard.slice(0, 12)} on ${fileRel}): ${wrong}`, evidence, true);
    evidence.push({
      gap_id: id, runtime_sha: runtime, must_fail: { vessel: `repos/${vessel}`, test_file: mf.test_file, only_tests: mf.only_tests }, guard_commit: guard,
      unmutated: { green: true, verified_head: plain["verified_head"] ?? null },
      mutated: { red: true, verified_head: mutated["verified_head"] ?? null, failing: ((mutated["failingTests"] as unknown[]) ?? []).slice(0, 10) },
    });
  }
  return out("covered", "qualified", `every regression (${mapped.length}) maps to an armed must-fail that reddens under mutation`, evidence, true);
}

/** The tightening evidence for a path: its open, unreverted regressions in the live store. */
export function evaluateTightening(path: string, gaps: Row[]): Row[] {
  const target = canonicalScopePath(path);
  return gaps.filter((g) => siteOf(g) === target && isOpenRegression(g)).map((g) => {
    const rb = metaOf(g)["regressed_by"] as Row;
    return { gap_id: String(g["id"]), regressed_by: { sha: rb["sha"] ?? null, by: rb["by"] ?? null } };
  });
}

/**
 * The lineage a tightening hold carries (gap-to-feature gapInHoldLineage): the gap ids its evidence names, and those
 * gaps' own test_suite checks. Empty when the evidence names no gap: such a hold exempts nothing.
 */
export function holdLineage(evidence: Row[], gaps: Row[]): { lineage_roots: string[]; lineage_checks: string[] } {
  const roots = [...new Set(evidence.map((e) => str(e["gap_id"])).filter(Boolean))];
  const byId = new Map(gaps.map((g) => [String(g["id"]), g] as [string, Row]));
  const checks = [...new Set(roots.flatMap((r) => (byId.has(r) ? gapCheckKeys(byId.get(r)!) : [])))];
  return { lineage_roots: roots, lineage_checks: checks };
}

/** The exit metric over the change records. */
export function scopeEarnInExitMetric(changes: Row[]): { criterion_changes_applied: number; consecutive_without_operator_edit: number; exit_met: boolean } {
  const recs = changes.filter((c) => (c["body"] as Row | undefined)?.["applied_by"] === SCOPE_EVALUATOR);
  const latest = recs.slice().sort((a, b) => Number((b["body"] as Row)["seq"] ?? 0) - Number((a["body"] as Row)["seq"] ?? 0))[0];
  const consecutive = latest ? Number((latest["body"] as Row)["consecutive_criterion_changes"] ?? 0) : 0;
  return { criterion_changes_applied: recs.length, consecutive_without_operator_edit: consecutive, exit_met: consecutive >= 2 };
}

const posNum = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);
const idFor = (prefix: string, ...parts: string[]): string => `${prefix}-${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}`;
function excludes(scope: Scope, path: string): boolean {
  const target = canonicalScopePath(path);
  return scope.excluded.some((e) => {
    const s = canonicalScopePath(e);
    return s.endsWith("/") ? target.startsWith(s) : target === s;
  });
}

/** What a tick that passed the due gate writes before its work: its demand is being answered now. */
export const RAN_PACING: Readonly<Row> = { staleness: 0 };

export interface ScopeEarnInTickPointer { type: "scope_earn_in_tick"; settled_by?: string; dry_run?: boolean }

/** THE PROPOSER. Never writes autonomyScope, never passes a credential. */
export async function resolveScopeEarnInTick(pointer: ScopeEarnInTickPointer): Promise<ResolverResult> {
  const d = deps();
  const now = d.now();
  const rhythm = await d.readRhythm();
  if (!rhythm) return { shape: "scopeEarnInReport", body: { fired: false, reason: "no_rhythm", family: SCOPE_EARN_IN_FAMILY } };
  const due = rhythmDueScore(rhythm.body, rhythm.updated_at, now);
  const threshold = posNum(rhythm.body["due_threshold"], 1);
  if (due.due_score < threshold) return { shape: "scopeEarnInReport", body: { fired: false, reason: "not_due", due_score: due.due_score, due_threshold: threshold } };
  // CLAIM THE SLOT BEFORE THE WORK (live 10-05: a tick that proposed nothing never settled, so the family stayed due
  // forever and every caller, the conductor and the boredom selector alike, re-ran all evaluations every ~30 s). A tick
  // that passes the gate first resets the family's pacing (RAN_PACING: staleness 0, updated_at now) by a
  // compare-and-set on the row it read, so the next caller within the cadence reads not_due and a concurrent caller
  // that read the same row loses the CAS. Credit for the outcome is a separate leg written after the work.
  if (!pointer.dry_run && !(await d.pace(rhythm, RAN_PACING, rhythm.updated_at))) {
    return { shape: "scopeEarnInReport", body: { fired: false, reason: "not_due", detail: "another tick claimed this due slot (rhythm row moved since it was read)", due_score: due.due_score } };
  }
  const perTick = Math.floor(posNum(rhythm.body["max_per_tick"], 2));
  const ttlHours = Math.min(MAX_TTL_HOURS, posNum(rhythm.body["tighten_ttl_hours"], 72));

  const scope = await d.readScope();
  if (!scope.readable) return { shape: "scopeEarnInReport", body: { fired: false, reason: "scope_unreadable", detail: scope.reason } };
  const gaps = await d.readGaps();
  const pending = new Set(d.poolRead(PROPOSAL_SHAPE).map((p) => canonicalScopePath(str((p["body"] as Row | undefined)?.["path"]))));
  const evaluated: Array<Omit<EarnInEvaluation, "evidence" | "ran_checks">> = [];
  const proposed: Row[] = [];
  let ranFiles = 0;
  let unjudgeable = 0;
  const write = (path: string, change: "widen" | "tighten", body: Row): void => {
    if (pointer.dry_run) { proposed.push({ path, change }); return; }
    const w = d.poolWrite({
      type: "poolImpulse_write", id: idFor("scope-proposal", path, change, new Date(now).toISOString()), shape: PROPOSAL_SHAPE, source: "scope_earn_in_tick",
      body: { path, change, criterion_version: SCOPE_CRITERION_VERSION, proposer: "scope_earn_in_tick", proposed_at: new Date(now).toISOString(), ...body },
    });
    if (w.body.ok) { proposed.push({ path, change }); pending.add(path); }
  };

  // WIDENINGS: each excluded entry, by the full criterion.
  for (const entry of scope.excluded) {
    const path = canonicalScopePath(entry);
    if (pending.has(path)) { evaluated.push({ path, verdict: "not_covered", reason_key: "proposal_pending", reason: "a proposal for this path is already pending" }); continue; }
    if (ranFiles >= perTick) { evaluated.push({ path, verdict: "not_covered", reason_key: "deferred", reason: "deferred: this tick's max_per_tick is spent" }); continue; }
    const ev = await evaluateWidening(path, gaps, d);
    if (ev.ran_checks) ranFiles += 1;
    if (ev.verdict === "unjudgeable") unjudgeable += 1;
    evaluated.push({ path: ev.path, verdict: ev.verdict, reason_key: ev.reason_key, reason: ev.reason });
    if (ev.verdict === "covered") write(path, "widen", { evidence: ev.evidence });
  }
  // TIGHTENINGS: an in-scope file with an open, unreverted regression. Less evidence, and a TTL.
  const sites = new Set(gaps.filter(isOpenRegression).map(siteOf).filter((s): s is string => !!s && s.startsWith("repos/")));
  for (const path of sites) {
    if (excludes(scope, path) || pending.has(path) || isEvaluatorFile(path)) continue;
    write(path, "tighten", { ttl_hours: ttlHours, evidence: evaluateTightening(path, gaps) });
  }

  const leg: "alpha" | "beta" | null = proposed.length > 0 ? "alpha" : unjudgeable > 0 && ranFiles === unjudgeable ? "beta" : null;
  if (leg && !pointer.dry_run) {
    // The credit leg, on the row as it is now (the claim already moved it): alpha or beta only; staleness stays reset.
    const fresh = (await d.readRhythm()) ?? rhythm;
    const a = typeof fresh.body["alpha"] === "number" ? (fresh.body["alpha"] as number) : due.alpha;
    const b = typeof fresh.body["beta"] === "number" ? (fresh.body["beta"] as number) : due.beta;
    await d.pace(fresh, leg === "alpha" ? { alpha: a + 0.5 } : { beta: b + 0.5 });
  }
  // VISIBILITY: every excluded entry's outcome and reason, in the report and as ONE journal line, so an exit the
  // criterion cannot reach (every file stuck on the same missing check, say) is visible on the first tick.
  const by_reason = scopeEarnInReasonCounts(evaluated);
  console.log(scopeEarnInJournalLine(evaluated));
  return {
    shape: "scopeEarnInReport",
    body: {
      fired: proposed.length > 0, reason: leg === "alpha" ? "proposed" : leg === "beta" ? "unjudgeable" : "nothing_to_propose",
      settlement: leg ?? (pointer.dry_run ? "none" : "ran"), due_score: due.due_score, criterion_version: SCOPE_CRITERION_VERSION,
      proposed, evaluated, by_reason, exit_metric: scopeEarnInExitMetric(d.poolRead(CHANGE_SHAPE)), dry_run: pointer.dry_run === true,
    },
  };
}

/** Excluded entries by reason_key. */
export function scopeEarnInReasonCounts(evaluated: Array<{ reason_key: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of evaluated) out[e.reason_key] = (out[e.reason_key] ?? 0) + 1;
  return out;
}
/** The tick's one compact journal line: counts by verdict and by reason, then up to `max` file:reason pairs. */
export function scopeEarnInJournalLine(evaluated: Array<{ path: string; verdict: string; reason_key: string }>, max = 12): string {
  const verdicts = { qualified: 0, not_covered: 0, unjudgeable: 0 };
  for (const e of evaluated) {
    if (e.verdict === "covered") verdicts.qualified += 1;
    else if (e.verdict === "unjudgeable") verdicts.unjudgeable += 1;
    else verdicts.not_covered += 1;
  }
  const pairs = evaluated.slice(0, max).map((e) => `${e.path.replace(/^repos\//, "")}:${e.reason_key}`);
  const more = evaluated.length > max ? ` (+${evaluated.length - max} more)` : "";
  return `[scope-earn-in] tick: ${evaluated.length} excluded entr(ies) → qualified=${verdicts.qualified} not_covered=${verdicts.not_covered} unjudgeable=${verdicts.unjudgeable}; by reason ${JSON.stringify(scopeEarnInReasonCounts(evaluated))}; ${pairs.join(" ")}${more}`;
}

type Applied = { path: string; change: "widen" | "tighten" | "expire"; change_id: string };

/**
 * THE ACCEPTED EVALUATOR. Run by the deployed (accepted) code beside the landing sweep. Re-derives every proposal's
 * evidence itself; writes autonomyScope only with the evaluator grant; consumes every proposal it judged.
 */
export async function applyScopeProposals(): Promise<{ applied: Applied[]; refused: Array<{ path: string; reason: string }>; waiting: string | null }> {
  const d = deps();
  const now = d.now();
  const nowIso = new Date(now).toISOString();
  const applied: Applied[] = [];
  const refused: Array<{ path: string; reason: string }> = [];
  const localScope = (): Row | null => d.poolRead("autonomyScope").slice().sort((a, b) => String(b["updated_at"] ?? "").localeCompare(String(a["updated_at"] ?? "")))[0] ?? null;
  let row = localScope();
  // CHEAP FIRST: this runs on every gap_to_feature tick, so with no open proposal and no expired hold it returns before
  // reading the scope over discovery or the whole gap store.
  const openProposals = d.poolRead(PROPOSAL_SHAPE);
  const holds0 = Array.isArray((row?.["body"] as Row | undefined)?.["tightening_holds"]) ? (((row!["body"] as Row)["tightening_holds"]) as Row[]) : [];
  if (openProposals.length === 0 && !holds0.some((h) => Date.parse(String(h["expires_at"] ?? "")) <= now || !Array.isArray(h["lineage_roots"]))) return { applied, refused, waiting: null };
  const effective = await d.readScope();
  const excludedOf = (r: Row | null): string[] => (Array.isArray((r?.["body"] as Row | undefined)?.["excluded_paths"]) ? ((r!["body"] as Row)["excluded_paths"] as string[]) : []);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  // This node changes only the record that IS the effective scope; otherwise the node that holds it applies.
  if (!row || !effective.readable || !sameSet(excludedOf(row), effective.excluded)) {
    return { applied, refused, waiting: !row ? "no local autonomyScope record" : "the local autonomyScope record is not the effective one" };
  }
  const changes = d.poolRead(CHANGE_SHAPE);
  let lastConsecutive = scopeEarnInExitMetric(changes).consecutive_without_operator_edit;
  let seq = changes.reduce((m, c) => Math.max(m, Number(((c["body"] ?? {}) as Row)["seq"] ?? 0)), 0);

  // THE ONE autonomyScope WRITE, under the evaluator grant (the grant-scan test counts exactly one construction).
  const writeScopeBody = (prior: Row, excluded: string[], holds: Row[]) => d.poolWrite({
    type: "poolImpulse_write", id: String(prior["id"]), shape: "autonomyScope", source: SCOPE_EVALUATOR, if_updated_at: String(prior["updated_at"] ?? ""),
    body: { ...((prior["body"] ?? {}) as Row), excluded_paths: excluded, tightening_holds: holds },
  }, { operator: false, evaluator: SCOPE_EVALUATOR });
  const writeScope = (excluded: string[], holds: Row[], change: Applied["change"], path: string, evidence: Row[], proposalId: string | null, extra: Row = {}): string | null => {
    const prior = row!;
    const priorBody = (prior["body"] ?? {}) as Row;
    const priorHolds = Array.isArray(priorBody["tightening_holds"]) ? (priorBody["tightening_holds"] as Row[]) : [];
    const w = writeScopeBody(prior, excluded, holds);
    if (!w.body.ok) { refused.push({ path, reason: `scope write refused: ${w.body.error ?? (w.body.conflict ? "concurrent edit" : "unknown")}` }); return null; }
    const priorBy = String(((prior["attested"] ?? {}) as Row)["by"] ?? "unattested");
    const consecutive = priorBy === "evaluator" ? lastConsecutive + 1 : 1;
    lastConsecutive = consecutive;
    const changeId = idFor("scope-change", path, change, nowIso);
    d.poolWrite({
      type: "poolImpulse_write", id: changeId, shape: CHANGE_SHAPE, source: SCOPE_EVALUATOR,
      body: {
        path, change, proposal_id: proposalId, applied_by: SCOPE_EVALUATOR, criterion_version: SCOPE_CRITERION_VERSION, evidence,
        prior_excluded_paths: excludedOf(prior), excluded_paths_after: excluded, undo: { excluded_paths: excludedOf(prior), tightening_holds: priorHolds },
        prior_attested_by: priorBy, consecutive_criterion_changes: consecutive, seq: ++seq, applied_at: nowIso, scope_record_id: String(prior["id"]), ...extra,
      },
    });
    applied.push({ path, change, change_id: changeId });
    row = localScope();
    void d.report({
      type: "uiPanel_write", id: changeId, kind: "notice", importance: "normal",
      title: `Autonomy scope ${change === "widen" ? "widened" : change === "tighten" ? "tightened" : "hold expired"}: ${path}`,
      body: `${change} of ${path} by ${SCOPE_EVALUATOR} (criterion ${SCOPE_CRITERION_VERSION}). Evidence: ${JSON.stringify(evidence).slice(0, 1500)}. ` +
        `Undo in one step: write autonomyScope excluded_paths back to the change record ${changeId}'s undo.excluded_paths (or place a hold). ` +
        `Consecutive criterion-made changes with no operator edit: ${consecutive}.`,
    }).catch(() => { /* delivery is checked by effect elsewhere; never blocks the change */ });
    return changeId;
  };

  // 1. EXPIRED TIGHTENING HOLDS lift by expiry.
  {
    const body = (row["body"] ?? {}) as Row;
    const holds = Array.isArray(body["tightening_holds"]) ? (body["tightening_holds"] as Row[]) : [];
    for (const h of holds.filter((x) => Date.parse(String(x["expires_at"] ?? "")) <= now)) {
      const p = str(h["path"]);
      const cur = excludedOf(row);
      const curHolds = ((((row["body"] ?? {}) as Row)["tightening_holds"] as Row[]) ?? []).filter((x) => str(x["path"]) !== p);
      writeScope(cur.filter((e) => canonicalScopePath(e) !== canonicalScopePath(p)), curHolds, "expire", p, [{ hold: h, expired_at: nowIso }], null);
    }
  }

  // 1b. A HOLD PLACED BEFORE IT CARRIED ITS LINEAGE gets it from its own tighten change record's evidence, so it stops
  // blocking the repair of its regression (gapInHoldLineage). Not a limit change: excluded_paths is unchanged, so no
  // change record and no notice; the write is the evaluator's, so the exit metric's chain is not reset.
  const gaps = await d.readGaps();
  {
    const held = row!;
    const holds = Array.isArray(((held["body"] ?? {}) as Row)["tightening_holds"]) ? ((((held["body"] ?? {}) as Row)["tightening_holds"]) as Row[]) : [];
    if (holds.some((h) => !Array.isArray(h["lineage_roots"]))) {
      const next = holds.map((h) => {
        if (Array.isArray(h["lineage_roots"])) return h;
        const rec = changes.map((c) => (c["body"] ?? {}) as Row).filter((b) => b["change"] === "tighten" && canonicalScopePath(str(b["path"])) === canonicalScopePath(str(h["path"])))
          .sort((a, b) => Number(b["seq"] ?? 0) - Number(a["seq"] ?? 0))[0];
        return { ...h, ...holdLineage(Array.isArray(rec?.["evidence"]) ? (rec!["evidence"] as Row[]) : [], gaps) };
      });
      if (writeScopeBody(held, excludedOf(held), next).body.ok) row = localScope();
    }
  }

  // 2. PROPOSALS, each re-judged from scratch.
  const consume = (p: Row, outcome: Row) => d.poolWrite({ type: "poolImpulse_write", id: String(p["id"]), shape: PROPOSAL_SHAPE, status: "consumed", body: { ...((p["body"] ?? {}) as Row), outcome: { ...outcome, at: nowIso, by: SCOPE_EVALUATOR } } });
  for (const p of d.poolRead(PROPOSAL_SHAPE).slice(0, MAX_APPLY_PER_PASS)) {
    const body = (p["body"] ?? {}) as Row;
    const path = canonicalScopePath(str(body["path"]));
    const change = body["change"];
    const cur = excludedOf(row);
    const curHolds = Array.isArray(((row!["body"] ?? {}) as Row)["tightening_holds"]) ? ((((row!["body"] ?? {}) as Row)["tightening_holds"]) as Row[]) : [];
    const isExcluded = cur.some((e) => canonicalScopePath(e) === path);
    if (!path || (change !== "widen" && change !== "tighten")) { consume(p, { applied: false, reason: "malformed proposal" }); refused.push({ path, reason: "malformed proposal" }); continue; }
    if (isEvaluatorFile(path)) { consume(p, { applied: false, reason: EVALUATOR_FILE_REASON }); refused.push({ path, reason: EVALUATOR_FILE_REASON }); continue; }
    if (change === "widen") {
      if (!isExcluded) { consume(p, { applied: false, reason: "noop: not in excluded_paths" }); continue; }
      const ev = await evaluateWidening(path, gaps, d);
      if (ev.verdict !== "covered") { consume(p, { applied: false, reason: ev.reason }); refused.push({ path, reason: ev.reason }); continue; }
      const id = writeScope(cur.filter((e) => canonicalScopePath(e) !== path), curHolds.filter((h) => str(h["path"]) !== path), "widen", path, ev.evidence, String(p["id"]));
      consume(p, { applied: !!id, change_id: id });
    } else {
      if (isExcluded) { consume(p, { applied: false, reason: "noop: already excluded" }); continue; }
      const evidence = evaluateTightening(path, gaps);
      if (evidence.length === 0) { const reason = "not reproduced: no open, unreverted regression on this path in the store"; consume(p, { applied: false, reason }); refused.push({ path, reason }); continue; }
      const ttl = Math.min(MAX_TTL_HOURS, posNum(body["ttl_hours"], 72));
      const expires = new Date(now + ttl * 3600_000).toISOString();
      const id = writeScope([...cur, path], [...curHolds, { path, expires_at: expires, placed_at: nowIso, by: SCOPE_EVALUATOR, ...holdLineage(evidence, gaps) }], "tighten", path, evidence, String(p["id"]), { expires_at: expires });
      consume(p, { applied: !!id, change_id: id });
    }
  }
  return { applied, refused, waiting: null };
}
