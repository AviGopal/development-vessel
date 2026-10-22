/**
 * substrateGap resolver — substrate-resident gap-statement store.
 *
 * Per investigation-031 design (operator-authorized commit 71a28d5):
 * `substrateGap` is a *problem statement* — distinct from `memoryNote`
 * which is *candidate answer*. The gap-closing activity (future iter)
 * consumes `substrateGap` impulses and produces `memoryNote` impulses.
 *
 * This is the SHAPE primitive only — the activity that closes gaps lives
 * separately. By itself this resolver enables: operator-filed gaps
 * (validation/gaps/*.yaml ingestion), substrate-detected gaps from
 * lifecycle:gap:classified subscribers, and any consumer that wants to
 * query open gaps by category/source.
 *
 * Storage: WORKSPACE_ROOT/gaps/gaps.json — flat JSON array, atomic writes.
 * Same pattern as memory-note.ts (the parallel structure is intentional;
 * keeps the resolver pair coherent).
 *
 * Categories (per inv-032's mapping validation):
 *   - conversation_only      → gap-closing activity's primary feedstock
 *   - training_knowledge     → gap-closing activity (alt entry)
 *   - missing_concept        → routes to ribosome (not this resolver's
 *                              consumer)
 *   - missing_idiom          → routes to idiom extraction
 *   - other                  → uncategorized
 *
 * Sources:
 *   - operator_narration     → manually filed via validation/gaps/*.yaml
 *   - substrate_detected     → lifecycle:gap:classified emitter (iter-023)
 *   - substrate_generative   → Seam ① closure-driven generative frontier
 *                              (generative_frontier_gap_tick) — the only source
 *                              that ORIGINATES intent rather than reacting.
 */

import { WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT } from "../config.js";
import { isWritePointerType, credentialSendRefusal } from "../lib/caller-credential.js";
import { selfAuthHeaders } from "../lib/self-auth.js";
import { currentCallCredential, runWithoutCallCredential } from "../lib/call-credential.js";
import { bumpQueuedAttempt, deadLetterQueued, enqueueGapWrite, queuedFiles, readQueued, removeQueued } from "../lib/gap-forward-queue.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { gateGapDirected } from "../lib/operator-direct.js";
import type { ResolverResult } from "./types.js";
import { onlyTestsProblem, TEST_SUITE_RESPONSE_FIELDS, testSuiteFileProblem, testSuiteCheckRoot } from "./test-suite.js";
import type { GoalReachVerdict } from "./goal-deficiency.js";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { tmpdir } from "node:os";
import { carryGoalReachEntries, isGoalReachEntry, mergeDemandGoal, type GoalReachDemandEntry } from "../lib/demand-goals.js";
import { regionLiteralVerdict, regionOf, falsifierClassOf } from "../lib/region-literal.js";
import { countLiteralOnEvaluatorTree, evaluatorEditSite } from "../lib/evaluator-tree.js";
import { EDIT_SITE_IS_OWN_CHECK, editSiteIsOwnCheck, routedOffCompose } from "../judge/gap-eligibility.js";

// EXPECTATION CALIBRATION, HELD WITH THE GAP STORE (value-per-cost-selection 5.5). Same file and
// format gap-to-feature reads ({category: {attempts, lands}}). It lives on the node that holds the
// store because every compose node's outcomes already arrive here as gap writes; a node-local copy
// saw only its own composes and sealed categories the fleet lands. Path read at call time so tests
// that point EXPECTATION_CALIB_PATH at a fixture never touch the live file. Loader duplicated, not
// imported: gap-to-feature imports this module.
function expectationCalibPath(): string {
  return process.env["EXPECTATION_CALIB_PATH"] ?? "/workspace/expectation-calibration.json";
}
function readExpectationCalibration(): Record<string, { attempts: number; lands: number }> {
  try {
    const p = expectationCalibPath();
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, { attempts: number; lands: number }>) : {};
  } catch { return {}; }
}
function creditExpectationCalibration(category: string, landed: boolean): void {
  try {
    const c = readExpectationCalibration();
    const rec = c[category] ?? { attempts: 0, lands: 0 };
    rec.attempts += 1;
    if (landed) rec.lands += 1;
    c[category] = rec;
    writeFileSync(expectationCalibPath(), JSON.stringify(c));
  } catch (err) {
    console.warn(`[expectation-calibration] credit failed for ${category}: ${String(err).slice(0, 200)}`);
  }
}

// I4: THE LEARNING CREDIT TABLES, SERVED WITH THE GAP STORE. The gap-class posterior, the close-oracle calibration and the
// detector closure credit are credited where the gap store lives (write-through, I4 step 1′) and read by every node
// through `substrateGap{include_calibration:true}`, as expectation calibration already is. Same files and paths as their
// writers (read at call time; loaders duplicated, not imported, for the same cycle reason as above).
const LEARNING_CREDIT_PATHS = {
  class_posteriors: () => process.env["GAP_CLASS_POSTERIOR_PATH"] ?? "/workspace/gap-class-posteriors.json",
  close_oracle: () => process.env["CLOSE_ORACLE_CALIB_PATH"] ?? "/workspace/close-oracle-calibration.json",
  detector_credit: () => process.env["DETECTOR_CLOSURE_LEDGER_PATH"] ?? "/workspace/detector-closure-credit.json",
  // beside the class posteriors (a new table needs no location of its own)
  priority_weights: () => join(dirname(process.env["GAP_CLASS_POSTERIOR_PATH"] ?? "/workspace/gap-class-posteriors.json"), "gap-priority-weights.json"),
} as const;
function readLearningCredit(rows?: readonly SubstrateGap[]): Record<keyof typeof LEARNING_CREDIT_PATHS, Record<string, unknown>> {
  const out = {} as Record<keyof typeof LEARNING_CREDIT_PATHS, Record<string, unknown>>;
  for (const k of Object.keys(LEARNING_CREDIT_PATHS) as Array<keyof typeof LEARNING_CREDIT_PATHS>) {
    try { const f = LEARNING_CREDIT_PATHS[k](); out[k] = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : {}; }
    catch { out[k] = {}; }
  }
  // I3 cold start: the baseline arm, absent from the table until its first credit, is SERVED from its earned record (pure:
  // nothing is written on this read; applyMath persists the same seed at the first credit).
  if (rows && !out.priority_weights[BASELINE_ARM]) out.priority_weights = { ...out.priority_weights, [BASELINE_ARM]: baselineEarnedRecord(rows) };
  return out;
}

/** The ranking arm every pick used before the terms variant existed. */
export const BASELINE_ARM = "variant:baseline";
/**
 * The baseline arm's EARNED record (qa ruling (a), I3): every joined pick decision in the store that the baseline made
 * (no priority decision recorded, i.e. before the variant existed, or variant "baseline"), landed or not. Derived from the
 * gap ledger's own approach_decisions, never declared. Beta(1 + landed, 1 + not landed).
 */
export function baselineEarnedRecord(rows: readonly SubstrateGap[]): { alpha: number; beta: number } {
  let landed = 0, other = 0;
  for (const g of rows) {
    const ds = ((g.classification_metadata ?? {}) as Record<string, unknown>)["approach_decisions"];
    if (!Array.isArray(ds)) continue;
    for (const d of ds) {
      if (!d || typeof d !== "object") continue;
      const e = d as { outcome?: { landed?: unknown }; priority?: { variant?: unknown } };
      if (!e.outcome || typeof e.outcome !== "object") continue;
      if (e.priority && e.priority.variant !== "baseline") continue;
      if (e.outcome.landed === true) landed++; else other++;
    }
  }
  return { alpha: 1 + landed, beta: 1 + other };
}
export async function baselineEarnedRecordFromStore(): Promise<{ alpha: number; beta: number }> {
  return baselineEarnedRecord((await loadGapsForRead()).rows);
}

/** Whether this node holds the gap store (no holder endpoint configured): the one test every gap-store caller uses. */
export function gapStoreIsLocal(): boolean { return !process.env["GAP_STORE_ENDPOINT"]; }
/** The shapes whose resolvers in THIS module read or write the gap store (gaps.json, its leases and its write events):
 *  HELD data, so a router must take them to the holder's own route, never to an interchangeable peer (discovery
 *  held-shape routing). */
export const GAP_STORE_HELD_SHAPES = ["substrateGap", "substrateGap_write", "substrateGapLease_write", "gapWriteEvent", "substrateGapMerge_write"] as const;

/**
 * FORWARDED CALLS AUTHENTICATE PER CALL, AND NEVER IN CLEARTEXT (2026-10-22).
 *   - WHOSE KEY. A call this node's route received for a held shape travels with that caller's own credential
 *     (lib/call-credential.ts), so the holder's identity decides about the caller, per call. A call this node makes
 *     itself travels with the node key.
 *   - WHERE A KEY MAY GO. Any key goes only over https, or over http to a host that cannot be on the public
 *     internet: the same check identity calls use (lib/caller-credential.ts credentialSendRefusal). Otherwise the call
 *     goes WITHOUT a key. A read still answers. A write is refused at the holder, and the answer is typed
 *     gap_store_cleartext_refused. That refusal is a placement error, not an outage, so it is never retried.
 */
export async function forwardToGapStore(pointer: Record<string, unknown>): Promise<ResolverResult | null> {
  const ep = process.env["GAP_STORE_ENDPOINT"];
  if (!ep) return null;
  const callAuth = currentCallCredential();
  const nodeKey = process.env["METABOB_API_KEY"] ?? process.env["API_KEY"];
  const auth = callAuth ?? (nodeKey ? `ApiKey ${nodeKey}` : null);
  const withheld = auth ? await credentialSendRefusal(ep, "gap-store holder") : null;
  try {
    const r = await fetch(ep, { method: "POST", headers: { "Content-Type": "application/json", ...(auth && !withheld ? { Authorization: auth } : {}) }, body: JSON.stringify({ impulse: { pointer } }), signal: AbortSignal.timeout(15_000) });
    // The holder answered over HTTP: the link is up, so writes queued while it was away may replay (GAP-WRITE QUEUE).
    noteGapStoreHolderAnswered();
    if (GAP_STORE_TRANSIENT_HTTP.has(r.status)) {
      return { shape: "structuredError", body: { resolver: "substrateGap", failure_mode: "gap_store_unreachable", http_status: r.status, detail: `gap store at ${ep} answered HTTP ${r.status}` } } as ResolverResult;
    }
    const j = await r.json() as { shape?: string; body?: unknown; success?: unknown };
    if (withheld && (j.success === false || !r.ok || !j.shape || j.shape === "structuredError")) {
      return { shape: "structuredError", body: { resolver: "substrateGap", failure_mode: "gap_store_cleartext_refused", detail: `gap store at ${ep}: no credential was sent (${withheld}), and the holder answered HTTP ${r.status}. Use https or a private address.` } } as ResolverResult;
    }
    return { shape: String(j.shape ?? "structuredError"), body: j.body ?? { detail: `gap store at ${ep} answered HTTP ${r.status}` } } as ResolverResult;
  } catch (e) {
    return { shape: "structuredError", body: { resolver: "substrateGap", failure_mode: "gap_store_unreachable", detail: `gap store at ${ep} unreachable: ${(e as Error).message}` } } as ResolverResult;
  }
}

// From ../shape-vocabulary.js, NOT from feature-compose.ts where this loader used to
// live: feature-compose.ts imports THIS module, so importing back would close a cycle.
// It was extracted rather than copied — see the header of that file.
import { loadFleetShapeVocabulary, vocabularyIsJudgeable, type ShapeVocabulary } from "../shape-vocabulary.js";


// Captured ONCE at module load (matches config.ts's own WORKSPACE_ROOT export),
// not re-read at call time. Read-at-call-time was deliberate so tests could set
// process.env.WORKSPACE_ROOT after importing this module — but it also means
// ANY later runtime mutation of that env var, from anywhere in the process,
// would permanently redirect every subsequent read/write for the rest of the
// process lifetime. No such mutation has been observed in production: this
// vessel's WORKSPACE_ROOT is set once, at process start, by
// /etc/substrate/env (to /workspace/git/super-repo, per that file's law-11
// rationale) and never changes afterward. This is defensive hardening against
// a hypothetical future runtime mutation, not a fix for an incident — the
// 2026-08-30 investigation that prompted this change turned out to be a
// misdiagnosis: an operator probe was checking /workspace/gaps/gaps.json,
// a stale fossil left over from before WORKSPACE_ROOT pointed at the
// super-repo clone, while the live store at
// /workspace/git/super-repo/gaps/gaps.json was persisting writes correctly
// the whole time. Existing tests already set the env var BEFORE importing
// this module (see substrate-gap.test.ts), so capturing at load time changes
// nothing for them.
const WORKSPACE_ROOT_AT_LOAD = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;

/**
 * ARM-TIME REGION GATE (2026-10-03). Compose grounding centres the draft on the line containing
 * classification_metadata.region; a region that is not a literal of edit_site grounds the draft on the file
 * top (see lib/region-literal.ts). A write that ARMS a gap with a region must therefore carry a region that
 * occurs exactly once in edit_site, or it is refused (region_not_literal_once {occurrences, edit_site},
 * region_spans_lines, or edit_site_unreadable — fail closed).
 *
 * THE RULE. Armed = the stamped falsifier is class2 and the row has an edit_site. The check runs only when the
 * resulting row is OPEN, armed, and carries a non-empty region, AND one of:
 *   - there was no stored row (a new arm),
 *   - the stored row was not open (a reopen re-arms),
 *   - the stored row was not class2 (this write arms it),
 *   - the region or the edit_site differs from the stored one (compared after carry-forward).
 * An update to an already-armed open row that leaves region and edit_site as stored is NOT checked, so rows armed
 * before this gate stay editable; gap_lifecycle_scan {region_lint:true} lists those. Closes, rejects and unarmed
 * writes are never checked.
 */
export function armRegionGate(
  id: string,
  status: string,
  meta: Record<string, unknown>,
  priorStatus: string,
  priorMeta: Record<string, unknown>,
): ResolverResult | null {
  if (status !== "open") return null;
  if (falsifierClassOf(meta) !== "class2") return null;
  const editSite = typeof meta["edit_site"] === "string" ? (meta["edit_site"] as string).trim() : "";
  const region = regionOf(meta);
  if (!editSite || !region) return null;
  const newArm = priorStatus !== "open" || falsifierClassOf(priorMeta) !== "class2";
  const changed = regionOf(priorMeta) !== region || String(priorMeta["edit_site"] ?? "").trim() !== editSite;
  if (!newArm && !changed) return null;
  const v = regionLiteralVerdict(region, editSite);
  if (v.ok) return null;
  console.log(`[gap-arm-region] refused ${id}: ${v.error} occurrences=${v.occurrences ?? "n/a"} edit_site=${editSite}`);
  return {
    shape: "structuredError",
    body: {
      resolver: "substrateGap_write", failure_mode: "validation_rejected", error: v.error,
      field: v.error === "edit_site_unreadable" ? "classification_metadata.edit_site" : "classification_metadata.region",
      id, region: v.region, edit_site: v.edit_site, occurrences: v.occurrences,
      detail: `gap ${id}: ${v.detail}`,
    },
  };
}

function workspaceRoot(): string {
  return WORKSPACE_ROOT_AT_LOAD;
}

/**
 * Where THIS module will actually read and write gaps — exported so a test can PROVE it is
 * isolated instead of hoping.
 *
 * A test that sets process.env.WORKSPACE_ROOT before importing this module is only isolated
 * if it wins the import race. config.ts:43 captures WORKSPACE_ROOT at module load, defaulting
 * to process.cwd(), and `bun test` shares one module registry across files — so in a
 * multi-file run ANOTHER suite can import config.ts first and this module's path is already
 * frozen to a real store by the time the env is set.
 *
 * That is not hypothetical. Rows named `falsifier-*` were found in the LIVE gap store at
 * /workspace/git/super-repo/gaps/gaps.json, written by test/resolvers/substrate-gap-falsifier
 * .test.ts, and they false-closed under the newly-armed Class-2 verifier. Compose runs the
 * suite inside the container during verification, so the blast radius is the running
 * substrate's own state — the same class as the suite that once shelled a real
 * `systemctl start gap-compose.service`.
 *
 * The env capture itself is correct and stays: law 1 makes WORKSPACE_ROOT bootstrap-only,
 * frozen at process start. The defect is a test that cannot tell whether it won the race.
 * This getter lets it assert rather than assume, turning silent live-store pollution into a
 * loud failure in the suite that causes it.
 */
export function gapStoreRootForTest(): string {
  return WORKSPACE_ROOT_AT_LOAD;
}

/**
 * A SCRATCH gap store: one rooted in the temp dir, the way every gap-writing test and the in-container suite runs
 * (WORKSPACE_ROOT="$(mktemp -d)") isolate themselves. The deployed store root (/workspace) never is one.
 */
export function isScratchGapStoreRoot(root: string): boolean {
  const r = resolvePath(root);
  const t = resolvePath(tmpdir());
  return r === t || r.startsWith(t + sep) || r.startsWith("/tmp/");
}

// THE GAP-WRITTEN PUBLISH STAYS OFF THE LIVE BUS IN TESTS. Inside a container the publish URL is the live
// activity-api and the suite runs there (post-land, compose verify): a listener counted 38 publishes from four
// gap-writing test files in one run. A write to a scratch store is a test's, so its publish is refused (logged once
// per module instance) unless a test opts in to observe it.
let gapEventPublishFromScratchAllowed = false;
/** devvessel.gap.written publishes skipped because no API key was configured (module lifetime). */
let gapEventPublishNoKey = 0;
export function gapEventPublishSkippedNoKey(): number {
  return gapEventPublishNoKey;
}
let gapEventPublishRefusalLogged = false;
export function __allowGapEventPublishFromScratchForTests(on: boolean): void {
  gapEventPublishFromScratchAllowed = on;
}

export type SubstrateGapCategory =
  | "conversation_only"
  | "training_knowledge"
  | "missing_concept"
  | "missing_idiom"
  | "route-edit-f3fa9300"
  | "compose_execution_failure"
  // systematic_failure (2026-06-28): an EXISTING capability that fails the same
  // way repeatedly — emitted by trace_failure_pattern_report(emit_gap) so the
  // gap_to_feature -> feature_compose loop authors an improvement. Distinct from
  // missing_capability (no resolver at all): here the capability exists but is
  // deficient, so the fix is an improvement, not a net-new resolver.
  | "systematic_failure"
  // performance_inefficiency (2026-06-28): a hot internal endpoint/query that is
  // SLOW or SATURATED — emitted by efficiency_scan(emit_gap). The author loop fixes
  // it, so the substrate manages its own internal systems (load/latency) efficiently.
  | "performance_inefficiency"
  // documentation_drift (2026-07-01): a doc CLAIM the substrate holds about itself that a
  // landed code change FALSIFIED — emitted by docs-align-scan (closure detector). Routed to
  // doc_drift_fix (a prose reach-gate), NOT feature_compose (whose typecheck gate is a no-op
  // for a .md edit). A document is an expectation; drift is a closure failure.
  | "documentation_drift"
  // trace_store_reconciliation (2026-07-08): AET row_count exceeded its
  // configured cap — emitted by trace_store_health_observer. Routed by
  // gap_to_feature to the development-vessel:trace-store-reconcile seed
  // activity via goal-host, NOT feature_compose (this is an operational
  // maintenance swap, not a code change). See openspec
  // 2026-07-08-substrate-self-managed-db-reconciliation/design.md.
  | "trace_store_reconciliation"
  | "other";

export type SubstrateGapSource =
  | "operator_narration"
  | "substrate_detected"
  // Seam ① (2026-06-19): closure-driven generative frontier — the only source
  // that ORIGINATES intent (generative_frontier_gap_tick), not reacts.
  | "substrate_generative";

export interface SubstrateGap {
  id: string; // idempotency key — typically gap_id from validation/gaps/<id>.yaml
  category: SubstrateGapCategory;
  source: SubstrateGapSource;
  summary: string;
  detected_at: string;
  status: "open" | "closed" | "rejected";
  closed_by_memory_note_id?: string; // populated by gap-closing activity
  // L7 gap-triple plumbing (all optional, backward-compatible):
  // first_detected_at is the EARLIEST detection, never overwritten by a
  // re-emission's detected_at — the anchor for durability/recurrence.
  first_detected_at?: string;
  // closed_at is stamped on the transition INTO "closed" — the anchor for
  // detection->close latency. Cleared when a closed gap is reopened.
  closed_at?: string;
  // closed_by_trace records the trace that closed the gap, when one is in scope.
  closed_by_trace?: string;
  // reopen_count increments each time a previously-closed gap is re-detected as
  // open (recurrence) — a durable fix keeps this at 0.
  reopen_count?: number;
  // reopened_at is stamped on the closed -> open transition (the RE-DETECTION time) and carried forward
  // while the row lives. The pending-land sweep compares a landing's commit time against it: a landing
  // older than the re-detection is the fix that did not hold, not evidence for a new close.
  reopened_at?: string;
  route?: "dispatchable" | "composable" | "human_required" | "route-edit-e9b22f20" | "route-edit-f3fa9300" | "compose_execution_failure";
  remedy?: { vessel: string; impulse_type?: string; goal?: string };
  classification_metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SubstrateGapReadPointer {
  type: "substrateGap";
  id?: string;
  category?: SubstrateGapCategory;
  source?: SubstrateGapSource;
  status?: SubstrateGap["status"];
  limit?: number;
  /**
   * Categories to EXCLUDE from the result set (e.g. decision-log noise like
   * auto_draft_triggered). Applied BEFORE the limit slice so an actionable
   * consumer (gap_to_feature) is not starved by a window full of log entries.
   * Typed as string[] because some categories (the goal-host auto_draft_*
   * decision log) are written with looser typing than SubstrateGapCategory.
   */
  exclude_categories?: string[];
  /** Also return the store holder's per-category expectation calibration (value-per-cost 5.5). */
  include_calibration?: boolean;
  /**
   * List held gaps too. A status:"open" list read omits gaps under classification_metadata.operator_hold
   * by default, because that read is the open-gap SUPPLY (boredom, the auto-pick, demand scans) and a
   * hold that suppliers can see does not contain. Operator views and bookkeeping readers (dedupe,
   * landing verification, self-fact closure) pass include_held:true. By-id reads are never filtered.
   */
  include_held?: boolean;
}

/**
 * Decision-log categories that are LOGS, not fixable work. Emitted by goal-host
 * `emitAuthoringDecision` every time it auto-drafts a goal (source
 * goal_host_auto_draft) — a per-dispatch record, not a gap a feature can close.
 * They MUST stay in the store (useful authoring-decision log) but MUST be
 * excluded from the actionable gap set the gap_to_feature picker considers,
 * else they starve the limited window and outrank penalized real gaps.
 */
export const DECISION_LOG_GAP_CATEGORIES = [
  "auto_draft_triggered",
  "auto_draft_fallback_recommend",
  "auto_draft_reused",
] as const;

export interface SubstrateGapWritePointer {
  type: "substrateGap_write";
  gap: Omit<SubstrateGap, "created_at" | "updated_at"> & {
    created_at?: string;
    updated_at?: string;
  };
  /** CONDITIONAL WRITE: applied only if a row with this exact id exists and its stored status equals
   *  this value, checked under withGapLock; otherwise a no-op (`skip_reason: status_precondition_failed`).
   *  For read-modify-write callers whose row may be closed between their read and their write. */
  expect_status?: string;
  /** ARRAY-MERGE APPEND to classification_metadata.demand_goals, applied under withGapLock against the
   *  STORED array (idempotent on goal_hash+dispatch_id), so two writers attaching goals to one gap at
   *  once keep both. Only `{source:"goal_reach", ...}` entries are accepted (lib/demand-goals.ts).
   *  Pair it with expect_status:"open" to attach only to a gap that is still open. */
  demand_goals_append?: GoalReachDemandEntry[];
  /** OPERATOR MARKER: "operator:<id>" when an operator makes this write by hand. Pointer-level on purpose:
   *  it is never stored, so a later writer that re-sends a row's stored fields cannot inherit it. It is an
   *  explicitness marker, not authentication (see operatorMarkerOf). */
  operator?: string;
  /** In-process only (lib/operator-direct.ts): the operator grant for a directed:true write. The route sets it
   *  from a validated operator:direct credential and deletes any inbound copy; it is never stored. */
  _directed_grant?: string;
}

const GAPS_PATH = () => join(workspaceRoot(), "gaps", "gaps.json");

/**
 * Gap CLASS key: the gap id with volatile tokens stripped (epoch ms/sec, ISO
 * datetimes, bare dates). Detectors mint per-run ids like
 * `responsibility-${vessel}-${principle}-${Date.now()}`, so the SAME logical gap
 * accumulated as hundreds of distinct open rows (observed 2026-06-14: 140
 * responsibility_misallocation, 78 trace_outcome_inconsistency, …), diluting the
 * drafter's random pick ~80× — the gap-store analogue of the scenario-bloat
 * dilution. Deduping on this class key (instead of the raw id) collapses
 * re-emissions onto one open row. Same root cause as finding-novelty grading:
 * volatile ids defeat dedup.
 */
export function gapClassKey(id: string): string {
  // Total by construction. This is called while scanning EVERY stored row, so a
  // single row that does not carry a string id must not be able to throw here —
  // see hasClassifiableId for what that cost the hub once.
  return String(id ?? "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "U")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.\-Z]+/g, "T")
    .replace(/\d{4}-\d{2}-\d{2}/g, "D")
    .replace(/\d{13}/g, "M")
    .replace(/\d{10}/g, "S");
}

/**
 * SAME DISPATCH, SAME GAP (2026-10-18). goal-host's floor offers substrateGap_write as a tool and the model
 * invents the id, so each attempt of one goal filed its own row: one run left
 * `repair-light-dispatch-vessel-pull-sync-test-failure` and `repair-needed-light-dispatch-vessel-6-consecutive-runs`
 * open side by side. Neither the exact id nor gapClassKey can see that (the ids share no volatile token), and the
 * consumption cap covers detector sources only, while the floor model writes whatever source it likes.
 *
 * What the write does carry is its dispatch: goal-host stamps the pointer with `dispatch_id` on every floor tool
 * call (ufExecuteTool). No goal hash travels with a gap write today, so the dispatch is the origin. `execution_id`
 * is not read: it is not shown to mark the floor alone, and templated detector summaries from one execution score
 * near-identical while naming different gaps. A NEW open row records it as classification_metadata.origin_dispatch_id;
 * a later NEW write from the same dispatch whose summary is near-identical to an open row it filed within the
 * window lands on that row instead of creating another.
 */
/**
 * Jaccard over normalised summary tokens: a byte-for-byte copy of comprehensibility-check.ts's Jaccard and its stop
 * words. Copied, not imported: this file is in the evaluator's closure and comprehensibility-check.ts is lane-editable, so
 * importing it would let a lane edit move the evaluator's dedupe (test/resolvers/evaluator-grant-scan.test.ts pins that
 * closure to the recorded debt; an import here widened it).
 */
const SUMMARY_STOP_WORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been","being",
  "of","in","to","for","on","with","at","by","from","as","that","this","these",
  "those","it","its","they","them","their","there","then","than","so","such",
  "if","not","no","do","does","did","done","has","have","had","will","would",
  "shall","should","can","could","may","might","must","into","onto","over","under",
  "out","up","down","off","about","against","between","through","during","before",
  "after","above","below","because","when","while","where","what","which","who",
  "whom","whose","why","how","all","any","both","each","few","more","most","other",
  "some","such","only","own","same","s","t","also","etc",
]);
function summaryTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !SUMMARY_STOP_WORDS.has(w)));
}
function summaryJaccard(a: string, b: string): number {
  const sa = summaryTokens(a);
  const sb = summaryTokens(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}

export const ORIGIN_DEDUPE_WINDOW_MS = 6 * 3600_000;
export const ORIGIN_DEDUPE_MIN_JACCARD = 0.6;

/** The dispatch a write came from, or null when the pointer names none. */
export function writeOriginOf(pointer: Record<string, unknown>): string | null {
  const v = pointer["dispatch_id"];
  return typeof v === "string" && v.trim().length > 0 && !/\{\{[^}]*\}\}/.test(v) ? v.trim() : null;
}

/** Index of an open row filed by the same dispatch within the window whose summary is near-identical, else -1. */
export function sameOriginDuplicateIdx(gaps: SubstrateGap[], origin: string, summary: string, nowMs: number): number {
  return gaps.findIndex((g) => {
    if (!hasClassifiableId(g) || g.status !== "open") return false;
    if ((g.classification_metadata as Record<string, unknown> | undefined)?.["origin_dispatch_id"] !== origin) return false;
    const born = Date.parse(String(g.created_at ?? ""));
    if (!Number.isFinite(born) || nowMs - born > ORIGIN_DEDUPE_WINDOW_MS) return false;
    return typeof g.summary === "string" && summaryJaccard(g.summary, summary) >= ORIGIN_DEDUPE_MIN_JACCARD;
  });
}

/**
 * Whether a STORED row can take part in class matching at all.
 *
 * A malformed row must degrade to "not a match", never take the store down with
 * it. Observed live 2026-08-08 on the hub: gaps.json held exactly one row,
 * hand-written with the wrong field names —
 *
 *     {"gap_id": "terminal-write-...", "gap_status": "closed"}
 *
 * — so `status` was `undefined`, which sails through a `status !== "closed"`
 * guard, and `gapClassKey(undefined)` then threw. Every substrateGap_write on
 * that hub 500'd for DAYS with `undefined is not an object (evaluating
 * 'id.replace')`. Detectors kept firing and pull-sync kept logging
 * "(substrateGap)" while nothing was ever filed — the store was not merely
 * empty, it was unwritable, and the one condition that would have reported the
 * outage was itself a gap write.
 *
 * The lesson is narrow and worth keeping: a dedup index built over
 * operator-touchable storage must treat every stored row as untrusted input.
 * One bad row is a row; one bad row that throws is an outage.
 */
function hasClassifiableId(g: SubstrateGap): boolean {
  return typeof g.id === "string" && g.id.length > 0;
}

async function loadGaps(): Promise<SubstrateGap[]> {
  const raw = await readGapBytes(GAPS_PATH());
  return raw === null ? [] : parseGapBytes(raw);
}
// The store's bytes, or null when the file doesn't exist (an empty store, not an error). Any other failure
// (permissions, I/O) is unrecoverable, never an empty store.
async function readGapBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new Error("gaps.json could not be loaded or parsed - refusing to treat as empty: " + (err as Error).message);
  }
}
function parseGapBytes(raw: Buffer): SubstrateGap[] {
  try {
    const parsed = JSON.parse(raw.toString("utf-8")) as SubstrateGap[];
    if (!Array.isArray(parsed)) throw new Error("gaps.json did not parse to an array - refusing to treat as empty");
    return parsed;
  } catch (err) {
    throw new Error("gaps.json could not be loaded or parsed - refusing to treat as empty: " + (err as Error).message);
  }
}

// THE READ-PATH SNAPSHOT (2026-10-16). Every lock-free read used to readFile + JSON.parse the WHOLE store per call
// (measured on the holder: 21.6 MB / 8,718 rows = ~140 ms each, a ~100 MB transient tree each, at >= 0.4 reads/s from
// the drain observer alone plus every forwarded spoke read). The holder's event loop stalled 15-18 s at a time and the
// spokes' 15 s forwarded reads timed out, failing their gates closed. Reads now share ONE parse per version of the file.
//
// The key is the file's IDENTITY (path + ino + size + mtimeMs + ctimeMs + this process's write generation), re-stat'd on every read: saveGaps (and any other
// process's writer) replaces the file by rename, which changes the inode, so a written store is always re-parsed on
// the next read. No TTL: an unchanged file is the same store. A file that changes WHILE it is being read (the stat
// before and after disagree) is returned but not kept. Writers are unchanged: withGapLock -> loadGaps -> modify ->
// saveGaps still reads the file fresh, so no write is ever computed over a cached copy.
// THE IDENTITY ALONE CANNOT SEE A SAME-SIZE IN-PLACE OVERWRITE INSIDE ONE TIMESTAMP TICK (2026-10-22). Without
// multigrain timestamps, mtime and ctime are coarse (one jiffy: 4 ms at HZ=250, 10 ms at HZ=100; a second on some
// filesystems), and another process's in-place overwrite keeps the inode, so the same size in the same tick left every
// key field equal and the stale parse was served for the rest of that version. A hit is therefore confirmed on the
// bytes: every read re-reads the file and compares a hash of ALL of it (not a head/tail sample: a same-size change
// to one row in the middle is the case) with the kept snapshot's, and re-parses only on a mismatch. The read + hash
// is a few ms on the holder's store against the parse and its tree, so the snapshot keeps its benefit, and there is
// no recency window or clock assumption to tune. A burst of reads on one identity shares one read + hash.
// Readers get COPIES of the rows they are handed (structuredClone of the selected page only), so no caller can
// mutate the shared snapshot.
type GapReadSnapshot = { key: string; digest: number | bigint; rows: SubstrateGap[]; byId: Map<string, SubstrateGap[]>; coverage: ReturnType<typeof falsifierCoverage> | null };
let __gapReadSnapshot: GapReadSnapshot | null = null;
let __gapReadParses = 0;
let __gapWriteGeneration = 0; // bumped by every saveGaps in this process: in-process writes change the key whatever the fs timestamp granularity
async function gapFileIdentity(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    return `${path}|${st.ino}|${st.size}|${st.mtimeMs}|${st.ctimeMs}|gen${__gapWriteGeneration}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}
// Concurrent misses on the SAME version share ONE parse: a write invalidates the snapshot, and the reads it triggers
// (the drain observer's nudges for that write, forwarded spoke reads) arrive together; without this each ran its own
// 140 ms / 100 MB parse at once. Cleared when the parse settles; a rejected parse is never kept.
const __gapReadInflight = new Map<string, Promise<GapReadSnapshot>>();
async function loadGapsForRead(): Promise<GapReadSnapshot> {
  const path = GAPS_PATH();
  const before = await gapFileIdentity(path);
  if (before === null) { __gapReadSnapshot = null; return { key: "", digest: 0, rows: [], byId: new Map(), coverage: null }; }
  const pending = __gapReadInflight.get(before);
  if (pending) return pending;
  const parse = parseGapsForRead(path, before);
  __gapReadInflight.set(before, parse);
  try {
    return await parse;
  } finally {
    if (__gapReadInflight.get(before) === parse) __gapReadInflight.delete(before);
  }
}
async function parseGapsForRead(path: string, before: string): Promise<GapReadSnapshot> {
  const raw = await readGapBytes(path);
  if (raw === null) { __gapReadSnapshot = null; return { key: "", digest: 0, rows: [], byId: new Map(), coverage: null }; }
  const digest = Bun.hash(raw);
  const kept = __gapReadSnapshot;
  if (kept && kept.key === before && kept.digest === digest) return kept;
  const rows = parseGapBytes(raw);
  __gapReadParses++;
  const byId = new Map<string, SubstrateGap[]>();
  for (const g of rows) {
    if (!g || typeof g.id !== "string") continue;
    const list = byId.get(g.id);
    if (list) list.push(g); else byId.set(g.id, [g]);
  }
  const snap: GapReadSnapshot = { key: before, digest, rows, byId, coverage: null };
  const after = await gapFileIdentity(path);
  if (after === before) __gapReadSnapshot = snap;
  return snap;
}
/** Tests only: how many times the read path parsed the store, and a reset. */
export function __gapReadParsesForTests(): number { return __gapReadParses; }
export function __resetGapReadSnapshotForTests(): void { __gapReadSnapshot = null; __gapReadParses = 0; __gapReadInflight.clear(); }

// In-process serialization of the gap store's read-modify-write. Concurrent
// writers previously (a) shared a single gaps.json.tmp — one writer's rename
// unlinked the tmp out from under another, surfacing as ENOENT — and (b)
// interleaved load→modify→save, silently dropping gaps written between a
// racer's load and its save. withGapLock chains the critical section so writes
// apply strictly one at a time; the per-write UNIQUE tmp name below is
// belt-and-suspenders so no two writers ever touch the same tmp path.
let __gapWriteChain: Promise<unknown> = Promise.resolve();
let __gapTmpCounter = 0;
function withGapLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = __gapWriteChain.then(fn, fn);
  // Keep the chain alive regardless of this write's outcome.
  __gapWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

async function saveGaps(gaps: SubstrateGap[]): Promise<void> {
  const dir = join(workspaceRoot(), "gaps");
  // recursive:true should be idempotent, but bun throws EEXIST on an
  // already-existing dir under concurrent gap writes — which 500s the gap
  // recording path and severs the substrate's detect→record→fix loop. Ignore
  // EEXIST; a genuine write failure still surfaces at writeFile below.
  await mkdir(dir, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== "EEXIST") throw err;
  });
  // UNIQUE per-write tmp (pid + monotonic counter): never shared, so a
  // concurrent rename cannot unlink this writer's tmp (the observed ENOENT).
  const tmp = GAPS_PATH() + `.${process.pid}.${__gapTmpCounter++}.tmp`;
  await writeFile(tmp, JSON.stringify(gaps, null, 2), "utf-8");
  await rename(tmp, GAPS_PATH());
  __gapWriteGeneration++;
  __gapReadSnapshot = null; // the rename already changes the inode; the generation covers same-second, same-size in-process writes
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP-WRITE EVENTS (2026-10-20). gaps.json keeps only each row's latest state, /gaps/ is not in git, and a
// substrateGap_write is a direct resolve, not a traced execution, so who wrote which field when could not be
// established from the store; the [gap-audit] journal line covers only writes carrying the operator marker.
// Every resolveSubstrateGapWrite call now appends ONE event beside the store (gaps/gap-write-events.jsonl), in
// the same call, whether the write was saved, refused or threw, read back through the gapWriteEvent shape.
//
// NAMES ONLY. An event carries field names, statuses, the refusal's rule, the principal KIND, the first 6
// characters of the identity-issued key id when the route's label names one, the route's remote, and whether
// the marker was present. Never a field value, the summary, a refusal's detail (it can quote the summary), or
// anything derived from a presented key (the route stamps none; see routes/caller-identity.ts).
// `route` names the door that stamped the write: "impulses" (/v2/impulses/resolve), "resolvers-execute" (the
// vessel-proxy /resolvers/execute), or "in-process" when no route stamped it (counted as the system's own).
//
// fields_changed: for a write SAVED here (even one whose call threw after the save), the top-level and
// classification_metadata keys whose value differs between the stored row before the write and the row saved
// (what landed: a close without the marker keeps the stored summary, so summary is not listed). For a refused
// write, one that threw before saving, and one FORWARDED to the gap-store holder (store: "forwarded"), only the
// attempt exists: the keys the incoming write sends whose value differs from the stored row. `outcome` says which.
// principal_kind "jwt" is never produced today: the write door accepts an ApiKey only.
//
// PER NODE. A forwarding node records the call it handled (the original principal); the holder records the
// forwarded call it handled: the original caller's key when the call came through the forwarder's route
// (forwardToGapStore, per call), the forwarding node's key for a write the forwarder made itself. The read shape is held with the store: on a forwarding
// node it is forwarded to the holder, unless the pointer says local:true (this node's own file).
//
// A failed append is logged with the gap id and never fails or changes the write. THE APPEND IS SYNCHRONOUS, so
// the event layer adds no await to the write: the write resolves at the same turn as without it, and work the write
// schedules after its save (the birth evaluation) cannot run before the caller sees the result. An awaited async
// append let a fast birth judge stamp its verdict before the write returned (gap-falsify-v2-birth: read "present"
// where the write leaves "pending"). Never withGapLock: the event is written after the write's critical section.
// While a retention rewrite runs, appends are held in memory and written into the new file just before its rename,
// in one synchronous step, so none is lost or reordered.
//
// TWO KNOWN DEBTS (recorded, not fixed):
//   (a) HELD IS NOT DURABLE. While a rewrite runs, a write that has returned has its event in memory only: a
//       gapWriteEvent read in that window misses it, and a crash in that window loses it. The window is one rewrite
//       (read, trim, write of a file at the cap), which happens once per half-cap of events.
//   (b) ONE PROCESS. The holding covers this process only. An append by ANOTHER process during a rewrite lands in
//       the old inode and is lost at the rename. Searched (dv src, super-repo scripts and units at origin/dev, the
//       other vessels' src): no other process appends gap-write-events.jsonl; dv's resolveSubstrateGapWrite is its
//       only writer, one dv unit per node. Other writers of the STORE exist and leave no event:
//       scripts/substrate/typecheck-scenario-gen.ts (typecheck-scenario-gen.timer, every 45 min) writes GAPS_PATH,
//       default /workspace/gaps/gaps.json, with a plain writeFile that bypasses saveGaps (it reaches the live store
//       only if its environment points GAPS_PATH there); and inside dv, the landing-lease op, stampBirthVerdict and
//       the reclassify / birth re-evaluation ticks call saveGaps without passing through resolveSubstrateGapWrite.
//       The gap-store merge (GAP-STORE MERGE, below) is one more: it records counts per chunk in
//       gaps/gap-store-merges.jsonl and its losers in gaps/_previous.jsonl, not one event per row.
//
// RETENTION: past the tuning row gap_write_events.max_bytes (activity-api tuning-params; absent means
// GAP_WRITE_EVENTS_MAX_BYTES_DEFAULT) the file is rewritten to its newest half. The row is read only when the
// file is over the cap, at most once per GAP_WRITE_EVENTS_CAP_READ_MS, and never from a scratch store.
export type GapWritePrincipalKind = "node-self" | "key" | "jwt" | "unauthenticated" | "in-process";
/** The door that stamped a write (routes/impulses.ts stampRouteCaller): the resolve route, the vessel-proxy route, or
 *  none (a write that did not come through a route, which counts as the system's own). */
export type GapWriteRoute = "impulses" | "resolvers-execute" | "in-process";
/** The pointer field a route stamps with its own name, beside _route_caller, and overwrites the same way. */
export const ROUTE_NAME_FIELD = "_route";
export type GapWriteEvent = {
  gap_id: string | null;
  fields_changed: string[];
  /** The stored status before the write; "absent" for no row, "?" when the write was refused before the store was read. */
  status_from: string;
  status_to: string;
  /** "written", "refused:<rule>", or "threw". */
  outcome: string;
  principal_kind: GapWritePrincipalKind;
  key_id: string | null;
  route_caller_remote: string | null;
  route: GapWriteRoute;
  operator_marker: boolean;
  store: "local" | "forwarded";
  ts: string;
};
export const GAP_WRITE_EVENTS_MAX_BYTES_ROW = "gap_write_events.max_bytes";
export const GAP_WRITE_EVENTS_MAX_BYTES_DEFAULT = 64 * 1024 * 1024;
const GAP_WRITE_EVENTS_CAP_READ_MS = 10 * 60_000;
const GAP_WRITE_EVENTS_PATH = () => join(workspaceRoot(), "gaps", "gap-write-events.jsonl");
let __gapEventTmpCounter = 0;
let gapWriteEventsMaxBytes = GAP_WRITE_EVENTS_MAX_BYTES_DEFAULT;
let gapWriteEventsCapReadAt = Number.NEGATIVE_INFINITY;
/** Non-null while a retention rewrite runs: the event lines appended meanwhile, written into the new file. */
let gapWriteEventsHeld: string[] | null = null;
let __gapEventCompaction: Promise<void> = Promise.resolve();
/** Tests only: awaited inside a retention rewrite once appends are held (a rejection takes the failure path). */
let __gapEventRewriteHook: ((path: string) => Promise<void>) | null = null;
export function __setGapWriteEventsRewriteHookForTests(fn: ((path: string) => Promise<void>) | null): void { __gapEventRewriteHook = fn; }
let gapWriteEventsEnabled = true;
/** Tests only: the retention cap in bytes (null restores the default), and the event layer on or off (the control). */
export function __setGapWriteEventsMaxBytesForTests(n: number | null): void { gapWriteEventsMaxBytes = n ?? GAP_WRITE_EVENTS_MAX_BYTES_DEFAULT; gapWriteEventsCapReadAt = n === null ? Number.NEGATIVE_INFINITY : Date.now(); }
export function __setGapWriteEventsEnabledForTests(on: boolean): void { gapWriteEventsEnabled = on; }
/** Tests only: settle a running retention rewrite. */
export async function __settleGapWriteEventsForTests(): Promise<void> { await __gapEventCompaction; }

/** The principal of a write, from the route's _route_caller stamp (routes/caller-identity.ts callerAuthLabel), and
 *  the door that stamped it (ROUTE_NAME_FIELD; "in-process" when no route did). */
export function gapWritePrincipal(pointer: unknown): { kind: GapWritePrincipalKind; key_id: string | null; remote: string | null; route: GapWriteRoute } {
  const rc = (pointer as { _route_caller?: unknown } | null | undefined)?._route_caller as { auth?: unknown; remote?: unknown } | undefined;
  if (!rc || typeof rc !== "object") return { kind: "in-process", key_id: null, remote: null, route: "in-process" };
  const rn = (pointer as Record<string, unknown>)[ROUTE_NAME_FIELD];
  const route: GapWriteRoute = rn === "impulses" || rn === "resolvers-execute" ? rn : "in-process";
  const remote = typeof rc.remote === "string" ? rc.remote : null;
  const auth = typeof rc.auth === "string" ? rc.auth : "unauthenticated";
  if (auth === "authenticated:node-self") return { kind: "node-self", key_id: null, remote, route };
  // The write door accepts an ApiKey only (lib/caller-credential.ts), so every other authenticated label is a key.
  if (auth === "authenticated" || auth.startsWith("authenticated:")) {
    const m = /^authenticated:key_id:(.+)$/.exec(auth);
    return { kind: "key", key_id: m ? m[1]!.slice(0, 6) : null, remote, route };
  }
  return { kind: "unauthenticated", key_id: null, remote, route };
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || stableStringify(a) === stableStringify(b);
const recordOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** The names of the top-level and classification_metadata keys whose value differs between two rows. */
export function gapFieldsChanged(before: unknown, after: unknown): string[] {
  const b = recordOf(before), a = recordOf(after);
  const out: string[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (k !== "classification_metadata" && !sameValue(b[k], a[k])) out.push(k);
  }
  const bm = recordOf(b["classification_metadata"]), am = recordOf(a["classification_metadata"]);
  for (const k of new Set([...Object.keys(bm), ...Object.keys(am)])) {
    if (!sameValue(bm[k], am[k])) out.push(`classification_metadata.${k}`);
  }
  return out.sort();
}
/** The names of the keys an incoming write SENDS whose value differs from the stored row (null: no row). */
export function gapFieldsAttempted(stored: unknown, incoming: unknown): string[] {
  const s = recordOf(stored), inc = recordOf(incoming);
  const out: string[] = [];
  for (const k of Object.keys(inc)) {
    if (k !== "classification_metadata" && inc[k] !== undefined && !sameValue(s[k], inc[k])) out.push(k);
  }
  const sm = recordOf(s["classification_metadata"]), im = recordOf(inc["classification_metadata"]);
  for (const k of Object.keys(im)) {
    if (im[k] !== undefined && !sameValue(sm[k], im[k])) out.push(`classification_metadata.${k}`);
  }
  return out.sort();
}

/** Append one event, synchronously (see GAP-WRITE EVENTS), then compact past the cap (not awaited). Never throws. */
function appendGapWriteEvent(ev: GapWriteEvent): void {
  if (!gapWriteEventsEnabled) return;
  try {
    const line = JSON.stringify(ev) + "\n";
    if (gapWriteEventsHeld) { gapWriteEventsHeld.push(line); return; }
    try { mkdirSync(join(workspaceRoot(), "gaps"), { recursive: true }); } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    appendFileSync(GAP_WRITE_EVENTS_PATH(), line, "utf-8");
  } catch (err) {
    console.error(`[gap-write-event] event NOT recorded for gap=${ev.gap_id ?? "(no id)"} outcome=${ev.outcome} (the write itself is unaffected): ${String(err).slice(0, 200)}`);
    return;
  }
  __gapEventCompaction = compactGapWriteEventsIfOver().catch((err) => {
    console.error(`[gap-write-event] retention compaction failed after gap=${ev.gap_id ?? "(no id)"} (events kept, file over cap): ${String(err).slice(0, 200)}`);
  });
}

async function compactGapWriteEventsIfOver(): Promise<void> {
  if (gapWriteEventsHeld) return;
  const path = GAP_WRITE_EVENTS_PATH();
  const st = await stat(path).catch(() => null);
  if (!st || st.size <= gapWriteEventsMaxBytes || gapWriteEventsHeld) return;
  if (!isScratchGapStoreRoot(workspaceRoot()) && Date.now() - gapWriteEventsCapReadAt > GAP_WRITE_EVENTS_CAP_READ_MS) {
    gapWriteEventsCapReadAt = Date.now();
    const { readTuningNumber } = await import("../judge/gap-policy.js");
    const tuned = await readTuningNumber(GAP_WRITE_EVENTS_MAX_BYTES_ROW);
    gapWriteEventsMaxBytes = tuned !== null && tuned > 0 ? tuned : GAP_WRITE_EVENTS_MAX_BYTES_DEFAULT;
    if (st.size <= gapWriteEventsMaxBytes || gapWriteEventsHeld) return;
  }
  const held: string[] = [];
  gapWriteEventsHeld = held; // from here every append is held until the rename (or the failure flush) below
  const tmp = `${path}.${process.pid}.${__gapEventTmpCounter++}.tmp`;
  try {
    if (__gapEventRewriteHook) await __gapEventRewriteHook(path);
    const lines = (await readFile(path, "utf-8")).split("\n").filter((l) => l.length > 0);
    const keepBytes = Math.floor(gapWriteEventsMaxBytes / 2);
    let i = lines.length, bytes = 0;
    while (i > 0 && bytes + Buffer.byteLength(lines[i - 1]!) + 1 <= keepBytes) { i--; bytes += Buffer.byteLength(lines[i]!) + 1; }
    await writeFile(tmp, lines.slice(i).map((l) => l + "\n").join(""), "utf-8");
    // One synchronous step from here: the held lines go into the new file, then it replaces the old one.
    if (held.length > 0) appendFileSync(tmp, held.join(""), "utf-8");
    renameSync(tmp, path);
    gapWriteEventsHeld = null;
    console.log(`[gap-write-event] retention: ${st.size} bytes over the cap (${gapWriteEventsMaxBytes}); kept the newest ${lines.length - i} of ${lines.length} events (+${held.length} appended during the rewrite)`);
  } catch (err) {
    // The old file is still in place: the held lines go there, in order.
    gapWriteEventsHeld = null;
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    if (held.length > 0) appendFileSync(path, held.join(""), "utf-8");
    throw err;
  } finally {
    gapWriteEventsHeld = null;
  }
}

/**
 * gapWriteEvent: the gap store's write events, oldest first, read at the holder (local:true reads this node's own
 * file). Pointer filters: gap_id (exact), since (an ISO time: events at or after it), limit (the newest N that
 * match; default 100, at most 1000).
 */
export async function resolveGapWriteEvent(pointer: { gap_id?: unknown; since?: unknown; limit?: unknown; local?: unknown } | Record<string, unknown>): Promise<ResolverResult> {
  const p = pointer as { gap_id?: unknown; since?: unknown; limit?: unknown; local?: unknown };
  if (!gapStoreIsLocal() && p.local !== true) {
    const fwd = await forwardToGapStore({ ...(pointer as Record<string, unknown>), type: "gapWriteEvent" });
    if (fwd) return fwd;
  }
  const gapId = typeof p.gap_id === "string" && p.gap_id.length > 0 ? p.gap_id : null;
  const sinceMs = typeof p.since === "string" ? Date.parse(p.since) : Number.NaN;
  if (typeof p.since === "string" && !Number.isFinite(sinceMs)) {
    return { shape: "structuredError", body: { resolver: "gapWriteEvent", failure_mode: "validation_rejected", field: "since", detail: `since must be an ISO time, got ${JSON.stringify(p.since).slice(0, 80)}` } };
  }
  const limitRaw = typeof p.limit === "number" ? p.limit : Number(p.limit ?? 100);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 100;
  let raw = "";
  try { raw = await readFile(GAP_WRITE_EVENTS_PATH(), "utf-8"); } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  const matched: GapWriteEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev: GapWriteEvent;
    try { ev = JSON.parse(line) as GapWriteEvent; } catch { continue; } // a torn or foreign line is skipped
    if (gapId !== null && ev.gap_id !== gapId) continue;
    if (Number.isFinite(sinceMs) && !(Date.parse(ev.ts) >= sinceMs)) continue;
    matched.push(ev);
  }
  return { shape: "gapWriteEvent", body: { events: matched.slice(-limit), matched: matched.length, gap_id: gapId, since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null, limit } };
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDING LEASE (2026-10-08): ONE landing lease per gap, held at the gap-store HOLDER.
//
// Measured 2026-10-07: two nodes composed and landed the same gap 75 s apart (node1 214f9fbd, compose2
// c1a1ed7f), the second replacing the first. Every coordination primitive was node-local: the compose
// slot directory, composeInFlight, gap-to-feature's maps, the maintenance-lease file. A node with
// GAP_STORE_ENDPOINT set forwards its gap reads and writes to the holder, so every node that shares a
// holder shares ONE store, and an op serialized at that holder is a lease for all of them.
//
// THE OP. substrateGapLease_write {action, gap_id, holder, attempt?, ttl_ms?}. On the holder it runs
// inside withGapLock (the same serialization every gap write takes) against a fresh read of the row:
//   acquire — grant when the row has no landing_lease, or it expired, or its holder is the caller;
//   renew   — grant only when the caller holds it and it has not expired (a lapsed claim is not renewed);
//   release — clear it only when the caller holds it (otherwise a no-op).
// A grant persists classification_metadata.landing_lease = {holder, attempt, acquired_at, until} on the
// row through saveGaps; updated_at is NOT touched (supply order reads recency). substrateGap_write can
// neither set nor clear it: the write path pins the stored value (see the save in resolveSubstrateGapWrite).
// A row the holder does not hold is refused (no_row): there is nothing to persist the lease on.
//
// ABSTAIN ON UNKNOWN. A non-holder forwards the op; a failed forward or an answer that is not a lease
// verdict returns {granted:false, unknown:true}. Never "no lease seen ⇒ go".
//
// EXPIRY. A crashed holder blocks other nodes for at most the TTL (default 2 h). Live holders renew at
// stage boundaries (compose exit with a cutover pending; cutover entry).
// ─────────────────────────────────────────────────────────────────────────────
// The pure rule is exported so a fixture store can serve the op with the holder's exact rule. It stays in
// this (scope-excluded) file: it decides who may land, so the lane must not be able to edit it.
export const LANDING_LEASE_TTL_MS_DEFAULT = 2 * 3600_000;
const LANDING_LEASE_TTL_MS_MAX = 12 * 3600_000;
export type LandingLease = { holder: string; attempt: string; acquired_at: string; until: string };
export type LandingLeaseAction = "acquire" | "renew" | "release";
export type SubstrateGapLeasePointer = { type?: string; action: LandingLeaseAction; gap_id: string; holder: string; attempt?: string; ttl_ms?: number };
export type LandingLeaseVerdict = {
  action: LandingLeaseAction;
  gap_id: string;
  granted: boolean;
  /** release only: whether a lease held by the caller was cleared. */
  released?: boolean;
  holder?: string;
  until?: string;
  held_by?: string;
  unknown?: boolean;
  reason?: string;
};

/** THE LAST RELEASE (user ruling 2026-10-14, "Build it before capacity"): who released the gap's lease, and when. Kept
 *  store-wide on the row so another node's picker can hold the gap for its compose cooldown (gap-to-feature
 *  crossNodeLeaseSkip): a released lease used to vanish, and the other node re-picked the same gap 1-8 s later. */
export type LandingRelease = { holder: string; attempt: string; at: string };
export function landingReleaseOf(meta: unknown): LandingRelease | null {
  const r = (meta as { landing_last_release?: unknown } | null | undefined)?.landing_last_release as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || typeof r["holder"] !== "string" || typeof r["at"] !== "string") return null;
  return { holder: r["holder"], attempt: String(r["attempt"] ?? ""), at: r["at"] };
}
export function landingLeaseOf(meta: unknown): LandingLease | null {
  const l = (meta as { landing_lease?: unknown } | null | undefined)?.landing_lease as Record<string, unknown> | undefined;
  if (!l || typeof l !== "object" || typeof l["holder"] !== "string" || typeof l["until"] !== "string") return null;
  return { holder: l["holder"], attempt: String(l["attempt"] ?? ""), acquired_at: String(l["acquired_at"] ?? ""), until: l["until"] };
}
const leaseLive = (l: LandingLease, now: number): boolean => { const t = Date.parse(l.until); return Number.isFinite(t) && t > now; };

/**
 * THE decision, pure: the stored lease (or null), the request, the clock -> the verdict and the lease to
 * store (undefined = leave as is, null = clear). Exported so a fixture store can serve the op with the
 * holder's exact rule.
 */
export function decideLandingLease(current: LandingLease | null, req: SubstrateGapLeasePointer, now: number): { verdict: LandingLeaseVerdict; next: LandingLease | null | undefined } {
  const base = { action: req.action, gap_id: req.gap_id };
  if (req.action === "release") {
    if (current && current.holder === req.holder) return { verdict: { ...base, granted: true, released: true, holder: req.holder }, next: null };
    return { verdict: { ...base, granted: true, released: false, ...(current ? { held_by: current.holder } : {}), reason: current ? "not_holder" : "no_lease" }, next: undefined };
  }
  const ttlRaw = Number(req.ttl_ms ?? LANDING_LEASE_TTL_MS_DEFAULT);
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, LANDING_LEASE_TTL_MS_MAX) : LANDING_LEASE_TTL_MS_DEFAULT;
  // RE-ENTRANT ON HOLDER + ATTEMPT for an acquire: a node may re-take its own lease only for the SAME attempt, so a
  // restarted process (a new attempt id) cannot silently re-acquire its predecessor's live lease and draft the gap
  // again; that lease lapses at its TTL like a crashed holder's. Renew and release stay holder-keyed: the cutover
  // renews under its own attempt id.
  const sameHolder = !!current && current.holder === req.holder;
  const mine = req.action === "acquire"
    ? sameHolder && (!req.attempt || !current!.attempt || current!.attempt === String(req.attempt))
    : sameHolder;
  const live = !!current && leaseLive(current, now);
  const ok = req.action === "renew" ? mine && live : !current || !live || mine;
  if (!ok) {
    const reason = req.action === "renew" ? (!current ? "no_lease" : !mine ? (live ? "held_by_other" : "lapsed_held_by_other") : "lapsed") : sameHolder ? "held_by_prior_attempt" : "held_by_other";
    return { verdict: { ...base, granted: false, ...(current ? { held_by: current.holder, until: current.until } : {}), reason }, next: undefined };
  }
  const until = new Date(now + ttl).toISOString();
  const next: LandingLease = { holder: req.holder, attempt: String(req.attempt ?? (mine ? current!.attempt : "")), acquired_at: mine && live ? current!.acquired_at : new Date(now).toISOString(), until };
  return { verdict: { ...base, granted: true, holder: req.holder, until }, next };
}

/** A lease verdict as the holder sends it; anything else is not one. */
export function isLandingLeaseVerdict(body: unknown): body is LandingLeaseVerdict {
  const b = body as Record<string, unknown> | null;
  return !!b && typeof b === "object" && typeof b["granted"] === "boolean" && typeof b["gap_id"] === "string";
}

/**
 * Landing-lease refusals since process start, by kind. Served on development-vessel /health
 * (landing_lease) and on every refusing compose / cutover body. A separate process (gap-compose.service)
 * counts its own refusals, which /health does not see.
 */
const landingLeaseRefusals = { compose_held: 0, compose_unknown: 0, cutover_not_held: 0, cutover_unknown: 0 };
export type LandingLeaseRefusalKind = keyof typeof landingLeaseRefusals;
export function countLandingLeaseRefusal(kind: LandingLeaseRefusalKind): void { landingLeaseRefusals[kind]++; }
export function landingLeaseRefusalCounts(): Record<LandingLeaseRefusalKind, number> { return { ...landingLeaseRefusals }; }

// ─────────────────────────────────────────────────────────────────────────────
// A DETECTOR ROW NOTHING CAN ARM IS WRITTEN, AND MARKED BESIDE ITS LABEL (2026-10-19, class row
// detector-files-unarmed-rows; qa ruling (a), revised by qa the same day: written, never refused; ruling R1 (B): the
// falsifier label stays "none").
// Measured on one node: 1,614 of 1,879 open substrate_detected gaps are unarmed, and 1,039 of the open unarmed
// detector rows carry no falsifier, no edit site and no file in their summary. Admission cannot take an unarmed gap,
// and gap-check-supply (the system's own arming path) can localize one only from a site or a file its summary names,
// so those rows are born dead: detected, never actionable. goal_deficiency_recognition never files one, because it
// arms every row it writes with the check it measured (goal-deficiency.ts goalReachCheck). That is the write-time
// contract for a detector: carry the check you measured (evidence_resolve), or the site (edit_site), or name the file.
// A NEW row from a detector source (exactly `substrate_detected`, or `<name>_detector` / `<name>_scan`) with none of
// them is WRITTEN (never refused: constraint A, detection must not stop) with its falsifier label as stamped, "none"
// (constraint A), and the verdict BESIDE it: falsifier_unresolvable_reason prefixed DETECTOR_ROW_UNARMABLE_REASON.
// Every reader keys on that PREFIX, never on the label: admission (gap-admission admitActionableGaps) and
// gap-check-supply (checkSupplyDisposition) exclude it; gap-eligibility already reads every "none" row unarmed; the
// birth sweep takes only class2 rows and response-contract unresolvables. The mark is KEPT on the row's later
// re-emissions while it is still unarmable (the stamp is recomputed on every write and drops the reason with a "none"
// label); a write that brings a check, a site or a file lifts it. Rows stored before this rule are not touched.
// NOT MARKED: a row a route other than compose acts on with no check and no site (gap-eligibility routedOffCompose:
// the non-compose categories and orphan producers, a goal-walk capability gap), nor one carrying a structured tsc
// error (it names its file, and tsc is its check), since for those "nothing can arm it" is not true. Every other row is classified as before: a predicate of any class, a human or
// operator row, goal_deficiency_recognition. A new unarmable row is COUNTED per source, served on /health
// (unarmable_detector_rows) and logged, because most detectors fire and forget: the count is the demand signal for
// which detector must learn to localize what it finds.
// A NEW such row that carries its own reading is armed from it instead (2026-10-21, the rule below).
// ─────────────────────────────────────────────────────────────────────────────
const unarmableDetectorRows: Record<string, number> = {};
/** New unarmable detector rows written since process start, by source (served on development-vessel /health). */
export function unarmableDetectorRowCounts(): Record<string, number> { return { ...unarmableDetectorRows }; }
/** Prefix of the falsifier_unresolvable_reason of a detector row nothing can arm, beside its "none" label (see the
 *  rule above). Readers key on this prefix, never on the falsifier label. */
export const DETECTOR_ROW_UNARMABLE_REASON = "detector_row_unarmable: ";
/** THE DETECTOR SOURCES, defined once: a row's source is a detector's when it is one of `exact` (the shared
 *  `substrate_detected`), or a snake_case `<name>_<suffix>` with a suffix in `suffixes` (a detector's own
 *  `<name>_detector` / `<name>_scan`). The mark above and the write-time contract below apply to these sources only.
 *  Every other source (human_reported, operator, goal_deficiency_recognition, a vessel or satisfier name) is a writer,
 *  not a detector, and is written as before. */
export const DETECTOR_SOURCES: { readonly exact: readonly string[]; readonly suffixes: readonly string[] } = { exact: ["substrate_detected"], suffixes: ["detector", "scan"] };
const DETECTOR_SOURCE_RE = new RegExp(`^[a-z0-9]+(?:_[a-z0-9]+)*_(?:${DETECTOR_SOURCES.suffixes.join("|")})$`);
/** A detector source (DETECTOR_SOURCES). */
export function isDetectorSource(source: unknown): boolean {
  const s = typeof source === "string" ? source.trim() : "";
  return DETECTOR_SOURCES.exact.includes(s) || DETECTOR_SOURCE_RE.test(s);
}
// A file path a summary names: a token with a directory and an extension, or a bare file name with a code extension.
const SUMMARY_FILE_RE = /(?:^|[\s`'"(\[])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,5}\b|(?:^|[\s`'"(\[])[\w-]+(?:\.[\w-]+)*\.(?:ts|tsx|js|mjs|cjs|sh|py|json|md|yml|yaml|toml|service)\b/;
/** Why a NEW gap row from a detector source cannot be armed by anything, or null when it can (see the rule above). */
export function unarmableDetectorRow(gap: Record<string, unknown>, falsifier: string): string | null {
  if (!isDetectorSource(gap["source"]) || String(gap["status"] ?? "open") !== "open" || falsifier !== "none") return null;
  const meta = (gap["classification_metadata"] ?? {}) as Record<string, unknown>;
  const has = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  if (["edit_site", "file_path", "change_site", "suspected_real_location"].some((f) => has(meta[f])) || has(gap["file_path"])) return null;
  // a structured tsc error names its file (gap-admission structuredTscErrorOf: tsc is that row's check)
  if (has(((meta["tsc_error"] ?? {}) as Record<string, unknown>)["file"])) return null;
  if (SUMMARY_FILE_RE.test(String(gap["summary"] ?? ""))) return null;
  return `a ${String(gap["source"])} row with no falsifier, no edit_site and no file named in its summary can never be armed (admission needs a falsifier, gap-check-supply a site or a named file); carry the check the detector measured as classification_metadata.evidence_resolve (as goal_deficiency_recognition does: goal-deficiency.ts goalReachCheck), or the edit_site, or name the file`;
}

// ─────────────────────────────────────────────────────────────────────────────
// A NEW DETECTOR ROW NOTHING CAN ARM IS ARMED FROM ITS OWN READING (2026-10-21, gap row
// a-detector-filed-gap-must-carry-the-check-the-detector-measured-otherwise-it-is-born-unadmittable).
// Measured on one node: 76% of open gaps are unarmed, 1,614 of 1,879 open substrate_detected rows among them, and
// admission takes none of them. goal_deficiency_recognition never files one: it arms each row with the check it
// measured (goalReachCheck). That is now the write-time contract for every detector source, at this seam, instead of a
// fix per detector. For a NEW open row from a detector source (DETECTOR_SOURCES):
//   (a) it carries a predicate (any class: a class2 evidence_resolve over a shape and a field the instrument returns,
//       as goalReachCheck builds, or a literal), or a site or file gap-check-supply localizes from, or another route
//       acts on it (routedOffCompose): written exactly as before.
//   (b) else it carries the detector's own READING at classification_metadata.detector_reading
//       { shape, input?, field, value } (the instrument it read, the inputs it read it with, the field, the number it
//       saw): the reading becomes its class2 check (detectorReadingCheck: a count > 0 is a zero_field, a health field
//       read at 0 a nonzero_field, the judge's polarity), validated by classifyFalsifier like any other arming, and the
//       row is written disposition needs_information, so it is armed later and never admitted on an unconfirmed check.
//   (c) else it is written and marked as the rule above says, and the rule it would name (DETECTOR_ROW_REFUSAL) is
//       what the re-arm proposal reports. The contract fails open: a throw writes the row as before (marked).
// The reading is never derived here from other fields: a predicate guessed at write time was tried and reverted
// (be26a6b), and a class2 check is resolved at birth, so its instrument and inputs must be the detector's own.
// detectorRearmProposal (below) is the read-only view of the rows already stored.
// ─────────────────────────────────────────────────────────────────────────────
/** Where a detector puts the reading it measured on a row's classification_metadata (see the rule above). */
export const DETECTOR_READING_FIELD = "detector_reading";
/** Why a detector row nothing can arm names no check: no reading, or a reading that cannot arm. */
export const DETECTOR_ROW_REFUSAL = {
  no_reading: "detector_row_unarmable_no_reading",
  reading_unusable: "detector_row_unarmable_reading_unusable",
} as const;
export type DetectorRowRefusal = (typeof DETECTOR_ROW_REFUSAL)[keyof typeof DETECTOR_ROW_REFUSAL];
/** The class2 check a detector's reading names, or the rule and reason it names none. */
export type DetectorReadingVerdict = { evidence_resolve: Record<string, unknown> } | { rule: DetectorRowRefusal; reason: string };

/** The class2 check (evidence_resolve) `meta.detector_reading` names, validated by classifyFalsifier, or why there is none. */
export function detectorReadingCheck(meta: Record<string, unknown> | null | undefined, vocabulary?: ShapeVocabulary | null): DetectorReadingVerdict {
  const raw = (meta ?? {})[DETECTOR_READING_FIELD];
  if (raw === undefined || raw === null) return { rule: DETECTOR_ROW_REFUSAL.no_reading, reason: `no ${DETECTOR_READING_FIELD}` };
  const unusable = (reason: string): DetectorReadingVerdict => ({ rule: DETECTOR_ROW_REFUSAL.reading_unusable, reason: `${DETECTOR_READING_FIELD} ${reason}` });
  if (typeof raw !== "object" || Array.isArray(raw)) return unusable("is not an object {shape, input?, field, value}");
  const r = raw as Record<string, unknown>;
  const shape = usablePredicateString(r["shape"]);
  const field = usablePredicateString(r["field"]);
  if (!shape || !field) return unusable("names no shape or no field");
  const input = r["input"];
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) return unusable("input is not an object");
  const value = r["value"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return unusable(`value ${JSON.stringify(value)?.slice(0, 40)} is not a finite count >= 0`);
  const er: Record<string, unknown> = { shape, ...(input !== undefined ? { input } : {}), [value > 0 ? "zero_field" : "nonzero_field"]: field };
  const c = classifyFalsifier({ evidence_resolve: er }, vocabulary);
  if (c.falsifier !== "class2") return unusable(`does not arm: ${c.unresolvable_reason ?? (c.unadvertised_shape ? `shape "${c.unadvertised_shape}" is not advertised` : `classified ${c.falsifier}`)}`);
  return { evidence_resolve: er };
}

/** What the write-time contract does with a NEW row (see the rule above): null writes it as before; otherwise the
 *  check its reading names (b), or the rule it names none under (c), with the unarmable reason. */
export function detectorBirthContract(gap: Record<string, unknown>, vocabulary?: ShapeVocabulary | null): (DetectorReadingVerdict & { unarmable: string }) | null {
  if (!isDetectorSource(gap["source"]) || String(gap["status"] ?? "open") !== "open") return null;
  const meta = (gap["classification_metadata"] ?? {}) as Record<string, unknown>;
  if (classifyFalsifier(meta, vocabulary).falsifier !== "none") return null;
  const why = unarmableDetectorRow(gap, "none");
  if (!why || routedOffCompose(gap)) return null;
  return { ...detectorReadingCheck(meta, vocabulary), unarmable: why };
}

/** One unarmed detector row's re-arm verdict in the proposal. */
export type DetectorRearmVerdict = "armable_from_reading" | "armable_from_row_fields" | "localizable" | "routed_elsewhere" | "not_armable";
/**
 * THE ONE-TIME RE-ARM SWEEP, AS A PROPOSAL (read-only: it writes nothing, it returns a body). For the open, unarmed
 * (falsifier "none" or unstamped) detector rows among `rows`, whether each can be armed from fields already on it, and
 * how, or why not: its own detector_reading (detectorReadingCheck, as the write seam takes it); else the instrument it
 * names (meta.detector, or its source) has a declared response contract and the row carries a number under a field
 * that contract lists (a proposal only: the inputs the detector read it with are not on the row, so input_confirmed is
 * false); else a site or file gap-check-supply localizes from ("localizable", as today); else another route acts on it;
 * else not armable, with the reason. Nothing is armed by hand: a proposal is for the system to act on.
 */
export function detectorRearmProposal(rows: ReadonlyArray<Record<string, unknown>>, vocabulary?: ShapeVocabulary | null): Record<string, unknown> {
  const vocab = vocabulary !== undefined ? vocabulary : cachedFleetVocabulary();
  const counts: Record<DetectorRearmVerdict, number> = { armable_from_reading: 0, armable_from_row_fields: 0, localizable: 0, routed_elsewhere: 0, not_armable: 0 };
  const out: Array<Record<string, unknown>> = [];
  let openDetector = 0;
  for (const g of rows) {
    if (!g || typeof g !== "object" || !isDetectorSource(g["source"]) || String(g["status"] ?? "open") !== "open") continue;
    openDetector++;
    const meta = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
    const label = meta["falsifier"];
    if (label !== undefined && label !== null && label !== "none") continue;
    const er = meta["evidence_resolve"] as { shape?: unknown } | null | undefined;
    if (usablePredicateString(meta["hardcoded_url"]) || usablePredicateString(meta["expected_literal"]) || (er && typeof er === "object" && usablePredicateString(er.shape))) continue;
    const detector = typeof meta["detector"] === "string" ? meta["detector"] : null;
    const row: Record<string, unknown> = { id: g["id"], source: g["source"], ...(detector ? { detector } : {}) };
    const fromReading = detectorReadingCheck(meta, vocab);
    let verdict: DetectorRearmVerdict;
    if ("evidence_resolve" in fromReading) { verdict = "armable_from_reading"; row["evidence_resolve"] = fromReading.evidence_resolve; }
    else {
      const derived = rowFieldsCheck(g, meta, vocab);
      if (derived) { verdict = "armable_from_row_fields"; row["evidence_resolve"] = derived; row["input_confirmed"] = false; }
      else {
        const why = unarmableDetectorRow(g, "none");
        if (!why) { verdict = "localizable"; row["reason"] = "carries an edit_site or a file gap-check-supply localizes from"; }
        else if (routedOffCompose(g)) { verdict = "routed_elsewhere"; row["reason"] = "a route other than compose acts on it (gap-eligibility routedOffCompose)"; }
        else { verdict = "not_armable"; row["reason"] = `${fromReading.rule}: ${fromReading.reason}; ${detector || String(g["source"])} names no instrument with a declared response contract a field on the row is listed in`; }
      }
    }
    row["verdict"] = verdict;
    counts[verdict]++;
    out.push(row);
  }
  return { kind: "detector_rearm_proposal", writes: 0, generated_at: new Date().toISOString(), open_detector_rows: openDetector, unarmed_detector_rows: out.length, counts, rows: out };
}
/** A class2 check from the row's own fields (the proposal's second bucket), or null. */
function rowFieldsCheck(g: Record<string, unknown>, meta: Record<string, unknown>, vocab: ShapeVocabulary | null): Record<string, unknown> | null {
  for (const shape of [meta["detector"], g["source"]]) {
    if (typeof shape !== "string") continue;
    const contract = RESPONSE_CONTRACTS[shape];
    if (!contract) continue;
    for (const field of contract.fields) {
      const v = meta[field];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
      const need = contract.needs_input?.[field];
      const input = need && nonEmptyInput(meta[need]) ? { [need]: meta[need] } : undefined;
      const er: Record<string, unknown> = { shape, ...(input ? { input } : {}), [v > 0 ? "zero_field" : "nonzero_field"]: field };
      if (classifyFalsifier({ evidence_resolve: er }, vocab).falsifier === "class2") return er;
    }
  }
  return null;
}

export async function resolveSubstrateGapLease(pointer: SubstrateGapLeasePointer | Record<string, unknown>): Promise<ResolverResult> {
  const p = pointer as SubstrateGapLeasePointer;
  const action = p.action;
  const gapId = typeof p.gap_id === "string" ? p.gap_id.trim() : "";
  const holder = typeof p.holder === "string" ? p.holder.trim() : "";
  if ((action !== "acquire" && action !== "renew" && action !== "release") || !gapId || !holder) {
    return { shape: "structuredError", body: { resolver: "substrateGapLease_write", failure_mode: "validation_rejected", detail: "substrateGapLease_write needs action acquire|renew|release, a gap_id and a holder" } } as ResolverResult;
  }
  const req: SubstrateGapLeasePointer = { type: "substrateGapLease_write", action, gap_id: gapId, holder, ...(p.attempt !== undefined ? { attempt: String(p.attempt) } : {}), ...(p.ttl_ms !== undefined ? { ttl_ms: Number(p.ttl_ms) } : {}) };
  if (process.env["GAP_STORE_ENDPOINT"]) {
    const fwd = await forwardToGapStore(req as unknown as Record<string, unknown>);
    if (fwd && fwd.shape === "substrateGapLease" && isLandingLeaseVerdict(fwd.body)) return fwd;
    const reason = `gap-store holder gave no lease verdict: ${JSON.stringify(fwd?.body ?? null).slice(0, 200)}`;
    return { shape: "substrateGapLease", body: { action, gap_id: gapId, granted: false, unknown: true, reason } satisfies LandingLeaseVerdict } as ResolverResult;
  }
  try {
    const verdict = await withGapLock(async (): Promise<LandingLeaseVerdict> => {
      const gaps = await loadGaps();
      const g = gaps.find((r) => r && r.id === gapId);
      if (!g) return { action, gap_id: gapId, granted: action === "release", ...(action === "release" ? { released: false } : {}), reason: "no_row" };
      const meta = (g.classification_metadata ?? {}) as Record<string, unknown>;
      const d = decideLandingLease(landingLeaseOf(meta), req, Date.now());
      if (d.next !== undefined) {
        const m = { ...meta };
        const prior = landingLeaseOf(meta);
        if (d.next === null) {
          delete m["landing_lease"];
          if (prior) m["landing_last_release"] = { holder: prior.holder, attempt: prior.attempt, at: new Date().toISOString() } satisfies LandingRelease;
        } else m["landing_lease"] = d.next;
        g.classification_metadata = m as SubstrateGap["classification_metadata"];
        await saveGaps(gaps);
      }
      return d.verdict;
    });
    if (verdict.action !== "release" || verdict.released) console.log(`[landing-lease] ${action} gap=${gapId} holder=${holder} granted=${verdict.granted}${verdict.held_by ? ` held_by=${verdict.held_by}` : ""}${verdict.reason ? ` reason=${verdict.reason}` : ""}`);
    return { shape: "substrateGapLease", body: verdict } as ResolverResult;
  } catch (err) {
    return { shape: "substrateGapLease", body: { action, gap_id: gapId, granted: false, unknown: true, reason: `gap store unreadable: ${(err as Error).message.slice(0, 200)}` } satisfies LandingLeaseVerdict } as ResolverResult;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FALSIFIER ACCOUNTING (2026-09-01)
//
// THE MEASUREMENT that forced this. 487 open gaps; 5 (1.0%) carried any
// measurable closure predicate. `sweepPendingLandVerifications` closes a gap only
// on a MEASURED verdict, so a gap with no predicate yields 'pending' and the sweep
// correctly abstains — FOREVER. The 30-day TTL becomes its only exit. 34
// consecutive sweep ticks that day were byte-identical:
//   checked=18 closed=0 {absent:0, present:6, pending:11, unknown:1}
// The sweep is not broken; abstaining on unmeasurable evidence is the whole point
// (§12.6). What was missing is that "can this gap ever close?" was not a fact the
// store held — an operator had to grep for it.
//
// WHY THE WRITE PATH AND NOT THE DETECTORS. Category is not the writer:
// `systematic_failure` alone holds 108 open gaps written by at least four distinct
// call sites. A per-detector fix reaches a trickle. Every gap in the store, from
// every writer, passes through resolveSubstrateGapWrite exactly once.
//
// WHAT THIS DOES AND DOES NOT DO. It is ACCOUNTING, not invention. It classifies
// the predicate the writer supplied and stamps the verdict beside it. It never
// derives, guesses, or synthesises a predicate from the summary — that was tried
// (be26a6b) and REVERTED as net-negative: of 15 summary-derived literals only ~4
// named the actual defect; the rest quoted the FIX (inverted polarity) or named
// anchors the summary said were RETAINED. Worse, the cutover mirrors the fix
// BEFORE the stamp, so a derived literal read 'present' by construction and
// manufactured re-lands. And it NEVER REJECTS a gap for lacking a falsifier: 99%
// have none, and refusing them would halt detection fleet-wide.
//
// WHY "unresolvable" IS ITS OWN CLASS, distinct from "none". A Class-2 predicate
// naming a shape the fleet does not advertise is INERT — it resolves to nothing,
// yields 'unknown', and leaves the gap exactly as unclosable as no predicate at
// all, while LOOKING measurable. That is worse than "none", because it reads as
// covered. Not hypothetical: the substrate authored
// `evidence_resolve: { shape: "failurePatternReport" }` and landed it twice
// (05458f4, 6b6068e). The advertised name is `trace_failure_pattern_report`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four verdicts, in the order the rule tries them.
 *
 *   class1        — a usable `hardcoded_url`: a literal that must go ABSENT.
 *   class2        — a usable `evidence_resolve.shape` / `verify_shape` naming an
 *                   ADVERTISED shape: a re-measurement the sweep can actually run.
 *   unresolvable  — the same, but naming a shape the fleet does not advertise.
 *   none          — no predicate at all. The 99% case, and not an error.
 */
export type FalsifierClass = "class1" | "class2" | "unresolvable" | "none";

export interface FalsifierClassification {
  falsifier: FalsifierClass;
  /** The check's mode when it is not the default resolve (only "producer_contract" today). */
  predicate_mode?: string;
  /** The offending literal, present only on "unresolvable" — an escalation needs the NAME. */
  unadvertised_shape?: string;
  /** Which position carried the predicate: "hardcoded_url" | "evidence_resolve.shape" | "verify_shape" | "evidence_resolve.type". */
  predicate_position?: string;
  /**
   * The shape the predicate names, surfaced so the caller can take a BASELINE of it before
   * anything acts. Returned rather than re-derived at the call site because the precedence
   * (evidence_resolve.shape, then verify_shape, then the sample body's type) is subtle and a
   * second copy would drift from this one — which is how a predicate ends up measured at one
   * address and classified at another.
   */
  predicate_shape?: string;
  /**
   * Why an "unresolvable" verdict was reached when it is NOT an unadvertised shape — a literal
   * predicate with no edit site, a site missing or unreadable on the evaluator's tree, a literal
   * already in its fixed state there, or a non-unique compose anchor. Stored on the row as
   * `falsifier_unresolvable_reason`. An escalation that cannot say WHY a predicate
   * is inert cannot be acted on, and "unresolvable" alone would read as a bad shape name.
   */
  unresolvable_reason?: string;
  /** ISO timestamp of the classification, so an audit can tell a fresh stamp from a carried-forward one. */
  classified_at?: string;
}

/** A predicate string is only usable if it is a non-empty, non-placeholder string. */
function usablePredicateString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  if (/\{\{[^}]*\}\}/.test(t)) return null; // an unbound template slot measures nothing
  return t;
}

/**
 * Cached fleet vocabulary. `loadFleetShapeVocabulary` does a full readdir +
 * readFile sweep of every vessel's config.ts; running that on every gap write —
 * and gaps are written by a dozen detectors on every tick — would put a
 * filesystem scan on the hot path of the substrate's own detection loop. The
 * vocabulary changes only when a vessel's config.ts changes, i.e. at a deploy, so
 * minutes of staleness is immaterial. Staleness direction is also safe: a
 * NEWLY-advertised shape read as unadvertised only mis-labels the gap for a few
 * minutes and never blocks the write.
 */
let __vocabCache: { at: number; vocab: ShapeVocabulary } | null = null;
const VOCAB_TTL_MS = 5 * 60_000;
// Tests pin the vocabulary: the scan reads fixed fleet roots, so a test run inside a container
// sees the live fleet (a fixture shape reads "unresolvable") while the same test on a host
// sees too little to judge (fail open, "class2"). { v: null } pins "cannot judge".
let __vocabOverride: { v: ShapeVocabulary | null } | null = null;
export function __setFleetVocabularyForTests(v: { v: ShapeVocabulary | null } | null): void { __vocabOverride = v; }
function cachedFleetVocabulary(): ShapeVocabulary | null {
  if (__vocabOverride) return __vocabOverride.v;
  const now = Date.now();
  if (__vocabCache && now - __vocabCache.at < VOCAB_TTL_MS) return __vocabCache.vocab;
  try {
    const vocab = loadFleetShapeVocabulary();
    __vocabCache = { at: now, vocab };
    return vocab;
  } catch {
    // FAIL OPEN (constraint D). An unreadable filesystem is not evidence about any
    // shape name. Callers treat a null vocabulary as "cannot judge" → "class2".
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE CONTRACTS: WHAT AN INSTRUMENT ANSWERS (2026-10-19). A class-2 check names one field of its shape's answer
// (zero_field / nonzero_field / defect_field) and the judge (gap-check-judge.ts) reads exactly that key, answering
// unknown when the body has no such key. Measured on one node over 24 h: 78 of 95 birth evaluations were unknown, and
// most could never have been anything else: git_log armed with zero_field "count" (its body is a commandResult: no
// count), test_report (not served by this vessel's resolve route, the only one the judge asks), test_suite pointed at
// a shell script or at a source file that is not a test, or at a field it never emits.
//
// WHY HERE, AND NOT BESIDE EACH RESOLVER. This file is on the evaluator's guarded path (outside the lane's autonomy
// scope), and a guarded file must not import a module the lane can edit (test/resolvers/evaluator-grant-scan.test.ts):
// a lane landing in git-log.ts could otherwise change what the seam admits. So the lists of lane-editable resolvers
// (git_log, goal_reach_verdict, reach_rate_scan) live here; test_suite's lives in test-suite.ts, itself an evaluator
// file. Drift is caught by test/resolvers/check-response-contract.test.ts, which runs those resolvers and fails on any
// body key a list omits; goal_reach_verdict's list is a Record over keyof GoalReachVerdict (a type-only import, erased
// at runtime), so the interface and the list cannot differ without a compile error. A list is the UNION of every key
// any return path can carry: too wide only misses a bad arming, too narrow would condemn a good one. A shape with no
// list is not judged (no claim either way). resolver_schema serves them as response_fields.
//
// THE VERDICT IS THE EXISTING CLASSIFICATION, NOT A NEW FIELD. A check that can never be measured is the same thing
// as a predicate naming an unadvertised shape: supplied, and inert. So classifyFalsifier labels it "unresolvable",
// with falsifier_position naming the fault and falsifier_unresolvable_reason the why (prefixed RESPONSE_CONTRACT_REASON),
// instead of class2. An unresolvable row is never birth-evaluated (birth runs only for class2), is not admissible
// where class2 is required, and is a check-supply candidate, so the system re-arms it. The rows born class2 before
// this existed are re-classified by the birth sweep (reevaluateBirthVerdicts), the same way.
// ─────────────────────────────────────────────────────────────────────────────
export interface ResponseContract {
  /** Every key the resolver's body can carry, some only on some answers. */
  fields: readonly string[];
  /** A field that is only ever a number when the named pointer input is given and non-empty. */
  needs_input?: Readonly<Record<string, string>>;
  /** Further, shape-specific reasons an arming can never measure (null when none). */
  inputProblem?: (input: Record<string, unknown>) => { field: string; reason: string } | null;
}
const GOAL_REACH_VERDICT_KEYS: Record<keyof GoalReachVerdict, true> = {
  measured: true, goal_hash: true, why: true, runs: true, unreached_since_last_reach: true, last_reached_at: true,
  last_reach_judge: true, reached_lenient: true, lenient_reaches: true, newest_run_at: true,
};
const RESPONSE_CONTRACTS: Record<string, ResponseContract> = {
  test_suite: {
    fields: TEST_SUITE_RESPONSE_FIELDS,
    // requested_not_passing counts the named tests that did not pass; with no only_tests it is null on every run.
    needs_input: { requested_not_passing: "only_tests" },
    inputProblem: (input) => { const why = testSuiteFileProblem(input["test_file"]); return why ? { field: "test_file", reason: why } : null; },
  },
  // git-log.ts: the commandResult body (`refused` and `error` only on a refusal, `repo` only when one was given).
  git_log: { fields: ["exitCode", "stdout", "stderr", "cwd", "repo", "refused", "error"] },
  // goal-deficiency.ts GoalReachVerdict: every field but measured / goal_hash / why only on a measured answer.
  goal_reach_verdict: { fields: Object.keys(GOAL_REACH_VERDICT_KEYS), needs_input: { unreached_since_last_reach: "goal_hash" } },
  // self-fact-reconcile.ts: the selfFactReconcileReport body, its only return.
  self_fact_reconcile: { fields: [
    "detector", "ran_at", "facts_checked", "divergence_count", "divergences", "findings", "findings_count", "finding_hashes", "gaps_emitted",
    "gaps_closed", "canary_planted", "canary_found", "profile", "node", "trust_completion", "rows_checked", "blind_rows", "unobserved_rows",
    "unregistered_rows", "observed", "gaps_filed", "self_gap_filed", "read_errors", "claim",
    // The §14 rows' per-item judgements and their must-fail controls' own (repair_autonomy, lane_revert_within_1h).
    "judgements", "must_fail_controls",
    // Each §14 row's 7-day trend over its persisted aggregates (self-fact-reconcile.ts aggregateTrend).
    "trends",
  ] },
  // discovery-vessel-registry-observer.ts: the discoveryRegistryState body (error/http_status/roundtrip_ms only on some
  // answers); missing_count and missing_vessels only on a successful read with vessel_ids given (the local-registration
  // check the unregistered-vessel and joint detectors arm with).
  discovery_vessel_registry_observer: {
    fields: [
      "endpoint", "reachable", "error", "http_status", "roundtrip_ms", "total_vessels", "healthy_count", "stale_count",
      "stale_threshold_ms", "per_vessel", "generated_at", "missing_count", "missing_vessels",
    ],
    needs_input: { missing_count: "vessel_ids", missing_vessels: "vessel_ids" },
  },
  // reach-rate-scan.ts: the union of both reachRateReport bodies, the scoped re-read (activity_id) and the scan.
  reach_rate_scan: { fields: [
    "activity_id", "window_hours", "min_reach_rate", "contract_reach_rate", "count", "reached_count", "graded_count", "ungraded_count",
    "success_rate", "reach_rate", "measured", "generated_at", "fetch_error", "reach_below_floor",
    "families_evaluated", "families_skipped_insufficient_grading", "finding_count", "findings", "fleet_reached_count", "fleet_graded_count",
    "fleet_reach_rate", "min_graded_volume", "dry_run", "completed_at",
  ] },
};
/** The shapes with a declared response contract. */
export const RESPONSE_CONTRACT_SHAPES = Object.keys(RESPONSE_CONTRACTS);
/** The declared response fields of `shape`, or null when none are declared. */
export function responseFields(shape: string): readonly string[] | null {
  return RESPONSE_CONTRACTS[shape]?.fields ?? null;
}
const nonEmptyInput = (v: unknown): boolean => (Array.isArray(v) ? v.some((x) => typeof x === "string" ? x.trim() !== "" : x != null) : typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null);

/** Prefix of a falsifier_unresolvable_reason set by a response contract: the re-classification the birth sweep owns. */
export const RESPONSE_CONTRACT_REASON = "response_contract: ";
/** Why an arming can never be measured: where the fault sits (a falsifier_position), the shape, and the reason. */
export type ArmingProblem = { position: string; shape: string; reason: string };

/**
 * Why an evidence_resolve arming of a shape with a declared response contract can never be measured by the judge, or
 * null when nothing here says so: a named field the body never carries, a field that needs an input the arming omits,
 * or a shape-specific input problem. A shape with no contract, and the producer_contract mode (it reads discovery,
 * not a body), are not judged here.
 */
export function checkArmingProblem(evidenceResolve: unknown): ArmingProblem | null {
  if (!evidenceResolve || typeof evidenceResolve !== "object" || Array.isArray(evidenceResolve)) return null;
  const er = evidenceResolve as Record<string, unknown>;
  const shape = typeof er["shape"] === "string" ? er["shape"].trim() : "";
  if (!shape || er["mode"] === "producer_contract") return null;
  const contract = RESPONSE_CONTRACTS[shape];
  if (!contract) return null;
  const input = (er["input"] && typeof er["input"] === "object" ? er["input"] : {}) as Record<string, unknown>;
  for (const k of ["zero_field", "nonzero_field", "defect_field"]) {
    const f = typeof er[k] === "string" ? (er[k] as string).trim() : "";
    if (!f) continue;
    if (!contract.fields.includes(f)) return { position: `evidence_resolve.${k}`, shape, reason: `${k} "${f}" is not a field ${shape} returns (it returns: ${contract.fields.join(", ")})` };
    const need = contract.needs_input?.[f];
    if (need && !nonEmptyInput(input[need])) return { position: `evidence_resolve.${k}`, shape, reason: `${k} "${f}" is only measured when input.${need} is given; this arming has none` };
  }
  const extra = contract.inputProblem?.(input);
  return extra ? { position: `evidence_resolve.input.${extra.field}`, shape, reason: extra.reason } : null;
}


/** Write a classification onto a row's metadata: the write seam's stamp, and the birth sweep's re-classification. */
function stampFalsifierClassification(merged: Record<string, unknown>, c: FalsifierClassification): void {
  merged["falsifier"] = c.falsifier;
  if (c.predicate_position) merged["falsifier_position"] = c.predicate_position;
  else delete merged["falsifier_position"];
  if (c.predicate_mode) merged["falsifier_mode"] = c.predicate_mode;
  else delete merged["falsifier_mode"];
  if (c.unadvertised_shape) merged["falsifier_unadvertised_shape"] = c.unadvertised_shape;
  else delete merged["falsifier_unadvertised_shape"];  // clear a stale accusation carried from the old row
  // WHY it is unresolvable travels with the label: the classifier returned it and the row dropped it, so a census
  // of unresolvable rows could not tell an inert predicate from a mis-addressed read.
  if (c.unresolvable_reason) merged["falsifier_unresolvable_reason"] = c.unresolvable_reason;
  else delete merged["falsifier_unresolvable_reason"];
  merged["falsifier_classified_at"] = c.classified_at;
}

/**
 * THE CLASSIFICATION RULE, stated once and in precedence order:
 *
 *   1. a usable `hardcoded_url` string                        → "class1"
 *   2. else a usable shape name at `evidence_resolve.shape`
 *      or `verify_shape`, checked against the vocabulary      → "class2" | "unresolvable"
 *   3. else                                                   → "none"
 *
 * `hardcoded_url` wins over a Class-2 predicate because that is the sweep's own
 * precedence: verifyGapCondition tests the literal first and never reaches the
 * async evidence branch when one is present. The stamp must describe what the
 * sweep will actually do, not what the metadata merely contains.
 *
 * An `evidence_resolve` object present but carrying no usable `shape` classifies
 * "none", not "unresolvable": "unresolvable" means a name was supplied and does
 * not resolve, whereas no name at all is the same nothing as no predicate. Saying
 * "unresolvable" there would blame the writer for a name it never wrote.
 *
 * FAIL OPEN below the vocabulary threshold (constraint D, shared with the compose
 * gate via `vocabularyIsJudgeable`): if the scan did not demonstrably work
 * (configs_read < 5 or < 50 names — the host-side layout, an isolated worktree, a
 * container with a different mount), a Class-2 predicate is stamped "class2".
 * An unreadable filesystem must never be allowed to invent a defect.
 */
export function classifyFalsifier(
  meta: Record<string, unknown> | undefined | null,
  vocabulary?: ShapeVocabulary | null,
): FalsifierClassification {
  const m = (meta ?? {}) as Record<string, unknown>;
  const at = new Date().toISOString();

  // CLASS-1 NEEDS AN EDIT SITE, OR THE SWEEP CANNOT USE IT (2026-09-01, pre-push review).
  //
  // verifyGapCondition gates the whole Class-1 branch on BOTH being present —
  // gap-to-feature.ts:1563 and its async twin at :1650 read `if (editSite && hardcodedUrl)`.
  // A literal with no file to read it in is never measured, so stamping it `class1` would
  // reproduce, inside the accounting itself, the exact "looks measurable, is inert" defect
  // this classification exists to expose. Zero live instances today (1 of 490 open gaps
  // carries a hardcoded_url and it has an edit_site) — but a census that can lie is worse
  // than no census, because the lie is what gets acted on.
  //
  // `unresolvable` is the honest label: a predicate WAS supplied and cannot be resolved,
  // which is the same failure the unadvertised-shape case names.
  // THE ARMING GUARD READS THE EVALUATOR'S TREE (lib/evaluator-tree.ts). It read WORKSPACE_ROOT, which in the
  // container is the super-repo clone and never holds <vessel>/src/..., so every hardcoded_url gap with an edit site
  // was born unresolvable under the false reason "without edit_site", and a read error passed silently. The site is
  // chosen by the evaluator's own precedence (file_path, then edit_site, :line stripped) and read where it reads it;
  // a missing or unreadable site is its own reason, never "0 occurrences".
  const siteRead = (literal: string, editSite: string): { reason: string } | { count: number } => {
    const r = countLiteralOnEvaluatorTree(editSite, literal);
    if (r.ok) return { count: r.count };
    return {
      reason: r.kind === "missing"
        ? `edit_site_missing: ${editSite} does not exist at ${r.path} (the evaluator's tree, MITOSIS_RUNTIME_DIR) — verifyGapCondition answers 'unknown'`
        : `edit_site_unreadable: ${editSite} cannot be read at ${r.path} (${r.error}) — verifyGapCondition cannot measure it`,
    };
  };
  // hardcoded_url FIRST, as the evaluator does (verifyGapCondition enters Class 1b only when no hardcoded_url is set):
  // a row carrying both was labelled by the expected_literal polarity and measured by the hardcoded_url one.
  const hardcodedUrl = usablePredicateString(m["hardcoded_url"]);
  if (hardcodedUrl) {
    const editSite = evaluatorEditSite(m);
    if (!editSite) {
      return {
        falsifier: "unresolvable",
        predicate_position: "hardcoded_url",
        unresolvable_reason: "hardcoded_url without edit_site/file_path — verifyGapCondition never enters the Class-1 branch",
        classified_at: at,
      };
    }
    const r = siteRead(hardcodedUrl, editSite);
    if ("reason" in r) return { falsifier: "unresolvable", predicate_position: "hardcoded_url", unresolvable_reason: r.reason, classified_at: at };
    if (r.count === 0) {
      // A landing's durability sentinel (the line its commit removed) is absent by construction; the evaluator reads
      // it present/pending, never as a resolution predicate. Say so, so a census can tell it from an inert literal.
      const sentinel = m["predicate_source"] === "removed_line_of_landing_commit";
      return {
        falsifier: "unresolvable",
        predicate_position: "hardcoded_url",
        unresolvable_reason: sentinel
          ? `literal_absent (durability sentinel): the removed line is absent from ${editSite} on the evaluator's tree — the landing persists; nothing to arm`
          : `literal_absent: hardcoded_url occurs 0 times in ${editSite} on the evaluator's tree — the gap would read fixed before any change`,
        classified_at: at,
      };
    }
    return { falsifier: "class1", predicate_position: "hardcoded_url", classified_at: at };
  }
  const expectedLiteral = usablePredicateString(m["expected_literal"]);
  if (expectedLiteral) {
    const editSite = evaluatorEditSite(m);
    if (!editSite) {
      return { falsifier: "unresolvable", predicate_position: "expected_literal", unresolvable_reason: "expected_literal without edit_site/file_path — verifyGapCondition never enters the Class-1b branch", classified_at: at };
    }
    const r = siteRead(expectedLiteral, editSite);
    // A site that does not exist yet is the one case kept as class1: the fix may create the file, and the evaluator
    // measures it once it exists ('unknown' until then). Unreadable is not that: it can never be measured.
    if ("reason" in r && r.reason.startsWith("edit_site_unreadable")) {
      return { falsifier: "unresolvable", predicate_position: "expected_literal", unresolvable_reason: r.reason, classified_at: at };
    }
    if ("count" in r && r.count > 0) {
      return {
        falsifier: "unresolvable",
        predicate_position: "expected_literal",
        unresolvable_reason: `literal_already_present: expected_literal occurs ${r.count} time(s) in ${editSite} on the evaluator's tree — the gap would read fixed before any change`,
        classified_at: at,
      };
    }
    return { falsifier: "class1", predicate_position: "expected_literal", classified_at: at };
  }

  const evidenceResolve = m["evidence_resolve"];
// If the last compose attempt failed with a non-unique fs_edit anchor,
// refuse re-arming to prevent repeated compose_execution_failure retries.
if (evidenceResolve && typeof evidenceResolve === "object" && !Array.isArray(evidenceResolve)) {
  const evErr = (evidenceResolve as { error?: unknown })?.error;
  if (typeof evErr === "string" && evErr.includes("no_unique_anchor")) {
    return {
      falsifier: "unresolvable",
      unresolvable_reason: "compose_execution_failure:no_unique_anchor — planned fs_edit anchor is non-unique; suppressing retries",
    };
  }
}
  // A CHECK WHOSE TEST FILE IS THE GAP'S OWN EDIT SITE ARMS NOTHING (gap-eligibility editSiteIsOwnCheck): the only edit
  // that greens it is editing the check, so it is labelled unresolvable with the named reason, here at every write of
  // the row (an armed row is un-armed on its next write; gap-check-supply's tick writes the ones nothing else does).
  const ownCheck = editSiteIsOwnCheck({ classification_metadata: m });
  if (ownCheck) {
    return {
      falsifier: "unresolvable",
      predicate_position: "edit_site",
      unresolvable_reason: `${EDIT_SITE_IS_OWN_CHECK}: the edit site ${ownCheck.site} is the test file its check runs (${ownCheck.check}), so only editing the check can green it (self-certification)`,
      classified_at: at,
    };
  }
  const evidenceObj =
    evidenceResolve && typeof evidenceResolve === "object" && !Array.isArray(evidenceResolve)
      ? (evidenceResolve as Record<string, unknown>)
      : null;
  const fromEvidence = evidenceObj ? usablePredicateString(evidenceObj["shape"]) : null;
  const fromVerifyShape = usablePredicateString(m["verify_shape"]);
  // SAMPLE-BODY FALLBACK — MIRROR THE SWEEP, DO NOT UNDERCOUNT IT (2026-09-01, review).
  //
  // verifyGapConditionAsync (gap-to-feature.ts:1699-1712) does NOT require
  // `evidence_resolve.shape`: when the object carries a sample body instead, it derives the
  // shape from `verify_shape`, and failing that from the gap id. Classifying such a gap
  // `none` says "this can never close" about a gap the sweep can in fact measure.
  //
  // This is the live shape of the data, not a hypothetical: the single open evidence_resolve
  // predicate in the store is sample-body form ({type:"reachHistory", week:"2026-08-17"}),
  // and the documented `.shape` form has zero live instances. It classified correctly only
  // because it happens to also carry verify_shape.
  const fromSampleBodyType = evidenceObj && !fromEvidence ? usablePredicateString(evidenceObj["type"]) : null;
  const shapeName = fromEvidence ?? fromVerifyShape ?? fromSampleBodyType;
  const position = fromEvidence
    ? "evidence_resolve.shape"
    : fromVerifyShape
      ? "verify_shape"
      : fromSampleBodyType
        ? "evidence_resolve.type"
        : undefined;

  if (!shapeName || !position) {
    return { falsifier: "none", classified_at: at };
  }

  // PRODUCER CONTRACT (user ruling 2026-10-13, "Yes, one additive branch"): this check is DEFINED for a shape no producer
  // serves yet (present until an advertised producer returns a body satisfying the shape's contract; the judge's
  // producer_contract mode), so "unadvertised" is its starting state, not a defect. An identifier shape that is not a
  // write or action is class2 under it; a write or action shape is unresolvable (the judge never resolves one). Every
  // other input takes the path below unchanged.
  if (evidenceObj && evidenceObj["mode"] === "producer_contract" && position === "evidence_resolve.shape") {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(shapeName)) {
      return { falsifier: "unresolvable", predicate_position: position, unresolvable_reason: `producer_contract: ${shapeName} is not a shape identifier`, classified_at: at };
    }
    if (isWritePointerType(shapeName)) {
      return { falsifier: "unresolvable", predicate_position: position, unresolvable_reason: `producer_contract: ${shapeName} is a write/action shape, never resolved by a check`, classified_at: at };
    }
    return { falsifier: "class2", predicate_position: position, predicate_shape: shapeName, predicate_mode: "producer_contract", classified_at: at };
  }

  const vocab = vocabulary === undefined ? cachedFleetVocabulary() : vocabulary;
  // A check its shape's response contract says can never be measured is inert however the shape is advertised (RESPONSE
  // CONTRACTS). Read from this vessel's own code, so it needs no fleet vocabulary.
  const bad = position === "evidence_resolve.shape" ? checkArmingProblem(evidenceObj) : null;
  if (bad) return { falsifier: "unresolvable", predicate_position: bad.position, predicate_shape: shapeName, unresolvable_reason: RESPONSE_CONTRACT_REASON + bad.reason, classified_at: at };
  if (!vocabularyIsJudgeable(vocab)) {
    // Cannot see → cannot accuse. Credit the predicate.
    return { falsifier: "class2", predicate_position: position, predicate_shape: shapeName, classified_at: at };
  }
  if (vocab!.shapes.has(shapeName)) {
    return { falsifier: "class2", predicate_position: position, predicate_shape: shapeName, classified_at: at };
  }
  return {
    falsifier: "unresolvable",
    unadvertised_shape: shapeName,
    predicate_position: position,
    classified_at: at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BIRTH EVALUATION (gap_falsify v2; REALIGNMENT §2.3 "the falsifier fails on the current tree";
// contained-self-development 8.5). classifyFalsifier LABELS a class-2 check and never RUNS it, so a check
// that already passes on the unfixed tree (an inverted predicate, or one aimed at the wrong thing) was
// admitted and then closed its gap as verified on the first landing: the check never saw the defect, so
// its 'absent' after the landing proves nothing. The seam now runs the check ONCE when a write adds or
// changes a class-2 predicate, through the one judge (gap-to-feature evaluateGapCheck), and stamps the
// verdict BESIDE the predicate:
//   predicate_birth_verdict  pending | present | absent | unknown
//   predicate_birth_at       when the verdict was taken
//   predicate_birth_key      which predicate it describes (a stable serialisation of the check)
// Only 'present' is a check that has seen the defect. Every other verdict is predicate_suspect: not
// admissible to autonomous work and not closable by its own 'absent'. Rows written before this existed
// carry no stamp and keep their old treatment until their next write, which evaluates them once.
// The evaluation runs after the write is saved and never blocks it; evaluations run one at a time.
// Birth fields on an incoming write are never trusted: the seam owns them. The one trusted channel is
// the in-process `opts.birthVerdict` (not reachable over HTTP), used by a proposer that has just run the
// same judge on the same predicate. It is honoured only when it is a verdict MINTED by
// takeBirthVerdictWithReport (see MINTED BIRTH VERDICTS, below), for this gap id and this check.
//
// WHICH TREE (qa C3'). A verdict is about a tree, so the tree is stamped with it:
//   predicate_birth_sha           HEAD of the repo the check runs in, read when the evaluation STARTS
//   predicate_birth_detected_sha  the sha the writer detected the defect against (in-process `opts.detectedSha`
//                                 only, like the verdict; never taken from an incoming write)
//   predicate_birth_queued_sha    HEAD of the same repo when the evaluation was SCHEDULED (the write, or the
//                                 sweep's re-take): the base when the writer gave no detection sha
//   predicate_birth_tree_moved    true when an 'absent' was turned into 'unknown' because the tree moved
//   predicate_birth_tree_reason   why the tree did or did not count as moved (always stamped with an absent)
// An 'absent' is compared against the base (the detected sha when given, else the queued sha). If the base is
// not the evaluated tree AND the check's dependent files changed between them (`git diff --quiet <base>
// <eval> -- <test file(s)> <edit site path>` exits non-zero), the defect may have been fixed in between, so
// the absent cannot say "inverted at birth": it is stamped 'unknown' with predicate_birth_tree_moved, which
// is not suspect (it accuses nothing). HEAD moving without touching those files keeps the 'absent'. A diff
// that cannot run (an unreadable sha, a missing object) counts as moved: fail toward not-suspect, with the
// reason recorded. With NO sha readable at all (no clone of that repo here) nothing can have been seen to
// move, and the absent stands. The repo is the test_suite check's own vessel clone; for any other shape it is
// the edit site's vessel clone (the tree the defect is claimed to live in; the shape itself is served by a
// running vessel, so this is the nearest tree, not a proof of the served build).
//
// RE-EVALUATION is the pending-land sweep's (reevaluateBirthVerdicts, below): an 'unknown' or a 'pending'
// whose evaluation died is re-taken there, BIRTH_REEVAL_PER_TICK per tick, oldest first. A write of the same
// check carries its verdict forward unchanged (there is no second, write-triggered retry path).
// ─────────────────────────────────────────────────────────────────────────────
export type BirthVerdict = "pending" | "present" | "absent" | "unknown";
/** The one judge. `opts.onReport` observes the check's own report (what ran, what failed) without changing the verdict. */
export type BirthJudge = (gap: Record<string, unknown>, opts?: { onReport?: (report: Record<string, unknown>) => void }) => Promise<string>;
const BIRTH_FIELDS = ["predicate_birth_verdict", "predicate_birth_at", "predicate_birth_key", "predicate_birth_sha", "predicate_birth_detected_sha", "predicate_birth_queued_sha", "predicate_birth_tree_moved", "predicate_birth_tree_reason"] as const;
/** A 'pending' older than this means its evaluation died with the process: the sweep re-takes it, and gap_birth_verdicts counts it. */
export const BIRTH_PENDING_STALE_MS = 3600_000;
/**
 * Birth verdicts the pending-land sweep re-takes per tick. A named constant, not a policy read: the sweep reads
 * no policy record on this path (PENDING_VERIFY_SWEEP_LIMIT beside it is a constant too). Each re-take may run a
 * test_suite (minutes), one at a time on the birth chain, so the bound is small.
 */
export const BIRTH_REEVAL_PER_TICK = 2;

const shaOf = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{7,40}$/.test(v.trim()) ? v.trim() : null);
/** A tree-moved unknown (see WHICH TREE): stamped at evaluation, read by suspicion, re-take and the standing row. */
export function birthTreeMoved(meta: Record<string, unknown> | null | undefined): boolean {
  return ((meta ?? {}) as Record<string, unknown>)["predicate_birth_tree_moved"] === true;
}
/** The clone a class-2 check runs in, and the files in it the check depends on (see WHICH TREE). */
export function birthCheckRepo(meta: Record<string, unknown>): { dir: string; files: string[] } | null {
  const er = (meta["evidence_resolve"] ?? null) as { shape?: unknown; input?: unknown } | null;
  const input = (er && typeof er.input === "object" && er.input ? er.input : {}) as Record<string, unknown>;
  const vessel = (er?.shape === "test_suite" ? String(input["vessel"] ?? "") : (/^repos\/([^/:]+)\//.exec(String(meta["edit_site"] ?? ""))?.[1] ?? "")).replace(/^repos\//, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(vessel) || vessel.includes("..")) return null;
  const files = new Set<string>();
  const add = (f: string): void => { const c = f.trim().replace(/^\/+/, "").replace(/:\d+.*$/, ""); if (c && !c.includes("..")) files.add(c); };
  if (er?.shape === "test_suite" && typeof input["test_file"] === "string") add(input["test_file"]);
  const inRepo = (p: unknown): string | null => (typeof p === "string" && p.startsWith(`repos/${vessel}/`) ? p.slice(`repos/${vessel}/`.length) : null);
  const site = inRepo(meta["edit_site"]);
  if (site) add(site);
  if (Array.isArray(meta["check_inputs"])) for (const p of meta["check_inputs"]) { const f = inRepo(p); if (f) add(f); }
  // A super-repo check (a shell check, test-suite.ts A SHELL CHECK) runs on the super-repo clone's tree.
  if (er?.shape === "test_suite" && vessel === "super-repo") return { dir: testSuiteCheckRoot(vessel), files: [...files] };
  return { dir: join(process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels", vessel), files: [...files] };
}
/** HEAD of the repo a class-2 check runs in (see WHICH TREE), or null when it cannot be read. */
function readBirthTreeSha(meta: Record<string, unknown>): string | null {
  const repo = birthCheckRepo(meta);
  if (!repo) return null;
  try {
    const p = Bun.spawnSync(["git", "-C", repo.dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? shaOf(new TextDecoder().decode(p.stdout)) : null;
  } catch { return null; }
}
/**
 * Did the tree an 'absent' was read on move away from its base in a way that matters to the check (WHICH TREE)?
 * Moved = the check's dependent files differ between the two shas, or they could not be compared.
 */
function birthTreeChange(meta: Record<string, unknown>, base: string | null, baseLabel: string, evalSha: string | null): { moved: boolean; reason: string } {
  if (!base && !evalSha) return { moved: false, reason: "no tree readable (no detected, queued or evaluated sha): nothing seen to move" };
  if (!base || !evalSha) return { moved: true, reason: `cannot compare trees: ${base ? "evaluated" : baseLabel} sha unreadable` };
  if (base.startsWith(evalSha) || evalSha.startsWith(base)) return { moved: false, reason: `evaluated on the ${baseLabel} tree ${evalSha.slice(0, 12)}` };
  const repo = birthCheckRepo(meta);
  if (!repo) return { moved: true, reason: "cannot compare trees: no repo for this check" };
  try {
    const p = Bun.spawnSync(["git", "-C", repo.dir, "diff", "--quiet", base, evalSha, "--", ...repo.files], { stdout: "pipe", stderr: "pipe" });
    const span = `${baseLabel} ${base.slice(0, 12)}..${evalSha.slice(0, 12)}`;
    if (p.exitCode === 0) return { moved: false, reason: `HEAD moved ${span} but ${repo.files.join(", ") || "the tree"} did not change` };
    if (p.exitCode === 1) return { moved: true, reason: `${repo.files.join(", ") || "the tree"} changed ${span}` };
    return { moved: true, reason: `diff failed ${span} (exit ${p.exitCode}: ${new TextDecoder().decode(p.stderr).trim().slice(0, 160)})` };
  } catch (err) {
    return { moved: true, reason: `diff failed: ${String(err).slice(0, 160)}` };
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** The identity of a gap's class-2 check: which predicate a birth verdict describes. */
export function class2PredicateKey(meta: Record<string, unknown> | null | undefined): string {
  const m = (meta ?? {}) as Record<string, unknown>;
  return stableStringify({ evidence_resolve: m["evidence_resolve"] ?? null, verify_shape: m["verify_shape"] ?? null });
}

/**
 * Why a gap's class-2 check cannot be trusted, or null when it can (or the gap predates birth stamps).
 * Read by admission (not admissible) and by closure (its 'absent' closes nothing).
 */
export function predicateSuspect(meta: Record<string, unknown> | null | undefined): string | null {
  const m = (meta ?? {}) as Record<string, unknown>;
  const f = m["falsifier"] as unknown;
  const cls = String((f && typeof f === "object" ? (f as { class?: unknown }).class : f) ?? "").toLowerCase();
  if (cls !== "class2") return null;
  const verdict = m["predicate_birth_verdict"];
  if (verdict === undefined || verdict === null || verdict === "") return null; // written before birth stamps
  if (m["predicate_birth_key"] !== class2PredicateKey(m)) return "the birth verdict describes a different check";
  if (verdict === "present") return null;
  // An unknown because the tree moved between detection and evaluation accuses nothing (WHICH TREE).
  if (verdict === "unknown" && birthTreeMoved(m)) return null;
  if (verdict === "absent") return "its check already passes on the unfixed tree (inverted or aimed at the wrong thing)";
  if (verdict === "pending") return "its check has not been evaluated yet";
  return "its check could not be evaluated at birth (unresolvable or timed out)";
}

/**
 * THE PARENT'S CHECK, FOR A CHILD WHOSE SCOPE STILL COVERS IT (narrowed and recommit children).
 * Measured 10-02: every `-narrowed` and `recommit-` child written 12:00-13:45Z was born falsifier=none
 * (the narrowed emitter strips evidence_resolve, the recommit emitter never copied it), so a child of a
 * verifiable parent could never close landed_verified, and ~10 such rows a day were dead on arrival.
 *
 * Returns the fields to give the child, or {} when there is nothing honest to inherit:
 *   - the parent's check must be class-2 and trusted (predicateSuspect null): a check that never read
 *     'present' is not propagated, and a falsifier-less parent's children stay none;
 *   - only a `test_suite` check: feature-compose holds a gap's own test_suite check to the CHECK CONTRACT
 *     (checkContractBreach + ownParentRun): RED on the child's own base tree, GREEN on its draft, with no
 *     fewer assertions, and no-effect-vs-parent refuses a draft that leaves the failures unchanged. That is
 *     what stops a child closing on its parent's test without doing the work. A shape check has no such
 *     at-commit contract, so it is not inherited here;
 *   - the child's edit site is the parent's, and the check's vessel is that site's vessel.
 * The birth verdict is NOT copied: the seam judges the child's check afresh on today's tree, so a check the
 * parent's own landing already satisfied is born 'absent' (predicate_suspect: not admissible, not closable).
 * A child closes only on a landing stamped for its OWN id, never on its parent's.
 */
export function inheritableParentCheck(parentMeta: Record<string, unknown> | null | undefined, childEditSite: unknown): Record<string, unknown> {
  const m = (parentMeta ?? {}) as Record<string, unknown>;
  const f = m["falsifier"] as unknown;
  const cls = String((f && typeof f === "object" ? (f as { class?: unknown }).class : f) ?? "").toLowerCase();
  if (cls !== "class2" || m["predicate_birth_verdict"] !== "present" || predicateSuspect(m) !== null) return {};
  const er = m["evidence_resolve"] as { shape?: unknown; input?: unknown; zero_field?: unknown } | null | undefined;
  if (!er || typeof er !== "object" || er.shape !== "test_suite" || er.zero_field !== "requested_not_passing") return {};
  const input = (er.input && typeof er.input === "object" ? er.input : {}) as Record<string, unknown>;
  const onlyTests = Array.isArray(input["only_tests"]) ? (input["only_tests"] as unknown[]).filter((t) => typeof t === "string" && t.trim() !== "") : [];
  if (onlyTests.length === 0 || typeof input["test_file"] !== "string") return {};
  const site = (v: unknown): string => String(v ?? "").trim().replace(/:\d+.*$/, "");
  const parentSite = site(m["edit_site"]);
  if (!parentSite || site(childEditSite) !== parentSite) return {};
  const siteVessel = /^repos\/([^/]+)\//.exec(parentSite)?.[1] ?? "";
  if (!siteVessel || String(input["vessel"] ?? "").replace(/^repos\//, "") !== siteVessel) return {};
  return { evidence_resolve: JSON.parse(JSON.stringify(er)) as Record<string, unknown>, predicate_source: "gap_falsify:inherit" };
}

let __birthJudgeOverride: BirthJudge | null = null;
/** Tests only: replace the default judge (gap-to-feature evaluateGapCheck). null restores it. */
export function __setBirthJudgeForTests(j: BirthJudge | null): void { __birthJudgeOverride = j; }
let __birthChain: Promise<unknown> = Promise.resolve();
const __birthInflight = new Set<Promise<unknown>>();
/** Tests only: wait for every scheduled birth evaluation (and its stamp) to finish. */
export async function __settleBirthEvaluationsForTests(): Promise<void> {
  while (__birthInflight.size > 0) await Promise.allSettled([...__birthInflight]);
}

async function defaultBirthJudge(gap: Record<string, unknown>, opts?: { onReport?: (report: Record<string, unknown>) => void }): Promise<string> {
  const { evaluateGapCheck } = await import("../judge/gap-check-judge.js");
  return evaluateGapCheck(gap, opts?.onReport ? { onReport: opts.onReport } : {});
}

async function stampBirthVerdict(id: string, key: string, verdict: BirthVerdict, evalSha: string | null, tree: { moved: boolean; reason: string } | null): Promise<boolean> {
  return withGapLock(async () => {
    const gaps = await loadGaps();
    const row = gaps.find((g) => g.id === id);
    const meta = (row?.classification_metadata ?? null) as Record<string, unknown> | null;
    // The predicate changed (or the row went) while the check ran: this verdict describes nothing.
    if (!row || !meta || meta["predicate_birth_key"] !== key) return false;
    meta["predicate_birth_verdict"] = verdict;
    meta["predicate_birth_at"] = new Date().toISOString();
    if (evalSha) meta["predicate_birth_sha"] = evalSha; else delete meta["predicate_birth_sha"];
    if (tree?.moved) meta["predicate_birth_tree_moved"] = true; else delete meta["predicate_birth_tree_moved"];
    if (tree) meta["predicate_birth_tree_reason"] = tree.reason; else delete meta["predicate_birth_tree_reason"];
    await saveGaps(gaps);
    return true;
  });
}

/**
 * THE BIRTH EVALUATOR: one class-2 check, one verdict, through the one judge. The seam's scheduled evaluation
 * runs this, and so does self_fact_reconcile's gap_birth_verdicts row as its must-fail control (a planted
 * check known to pass on the current tree must come back 'absent'), so the evaluator the seam relies on is
 * measured every tick, not validated once.
 */
export async function takeBirthVerdict(id: string, meta: Record<string, unknown>, judge?: BirthJudge): Promise<"present" | "absent" | "unknown"> {
  try {
    const v = await (judge ?? __birthJudgeOverride ?? defaultBirthJudge)({ id, classification_metadata: meta });
    return v === "present" || v === "absent" ? v : "unknown";
  } catch (err) {
    console.warn(`[gap-birth] ${id}: check threw (${String(err).slice(0, 160)}) — unknown`);
    return "unknown";
  }
}

/**
 * takeBirthVerdict through the same judge, also returning the check's own report (null when the judge gave none),
 * for a caller that must know WHY a check read present, e.g. that its named tests failed on an assertion rather
 * than on a load error (gap-check-supply).
 */
export async function takeBirthVerdictWithReport(id: string, meta: Record<string, unknown>): Promise<{ verdict: "present" | "absent" | "unknown"; report: Record<string, unknown> | null; stamp: MintedBirthVerdict }> {
  let report: Record<string, unknown> | null = null;
  const base = __birthJudgeOverride ?? defaultBirthJudge;
  // The judge sees a snapshot, and the stamp is bound to that snapshot: mutating `meta` while the check runs
  // cannot move the stamp onto a check that was not judged.
  const judged = JSON.parse(JSON.stringify(meta ?? {})) as Record<string, unknown>;
  const verdict = await takeBirthVerdict(id, judged, (g) => base(g, { onReport: (r) => { report = r; } }));
  return { verdict, report, stamp: mintBirthVerdict(id, judged, verdict) };
}

// ─────────────────────────────────────────────────────────────────────────────
// MINTED BIRTH VERDICTS (PLAN4 finding 2). The trusted channel (`opts.birthVerdict`) used to be honoured for
// ANY object whose predicate_key matched, so a caller could hand the seam `{ predicate_key, verdict: "present" }`
// for a check it never ran, and the row was born trusted: admissible, and closable by its own 'absent'. The
// callers that pass it (gap-to-feature decomposeGap, gap-check-supply's arm step) are lane-editable, so the
// seam now honours only a verdict this module minted:
//   - minted ONLY by takeBirthVerdictWithReport, which runs the seam's own judge (the default judge, or the
//     test override) and takes no caller-supplied judge (takeBirthVerdict, which does, mints nothing);
//   - frozen, so an 'absent' cannot be flipped to 'present' after minting;
//   - recorded in a module-private WeakSet, so a structurally identical literal, a spread copy or a
//     JSON round-trip of a minted verdict is not one (identity, not shape, is the credential; the set is not
//     exported, so no caller can add to it);
//   - bound to the gap id it was judged for and to the check it judged (evidence_resolve + verify_shape, with a
//     blank verify_shape read as none, because writers blank it deliberately and the judge reads "" as no shape).
// Why this and not a token or HMAC: everything here is one process, so a secret would be readable by the same
// code that could forge with it; object identity in a private set is the smallest credential an import of
// this module cannot manufacture. What it does NOT close (in-process test seams, same class, listed so they
// are not mistaken for covered): __setBirthJudgeForTests and the write's `opts.birthJudge` both let a caller
// choose the judge, and so the verdict.
// ─────────────────────────────────────────────────────────────────────────────
declare const MINTED_BIRTH_VERDICT_BRAND: unique symbol;
/** A birth verdict minted by takeBirthVerdictWithReport; the only form `opts.birthVerdict` honours. */
export type MintedBirthVerdict = {
  readonly gap_id: string;
  readonly predicate_key: string;
  readonly check: string;
  readonly verdict: "present" | "absent" | "unknown";
  readonly [MINTED_BIRTH_VERDICT_BRAND]: true;
};
const MINTED_BIRTH_VERDICTS = new WeakSet<object>();
/** The check a birth verdict is bound to: class2PredicateKey's fields, a blank verify_shape read as none. */
function birthCheckBinding(meta: Record<string, unknown> | null | undefined): string {
  const m = (meta ?? {}) as Record<string, unknown>;
  const vs = m["verify_shape"];
  return stableStringify({ evidence_resolve: m["evidence_resolve"] ?? null, verify_shape: typeof vs === "string" && vs.trim() === "" ? null : vs ?? null });
}
function mintBirthVerdict(id: string, meta: Record<string, unknown>, verdict: "present" | "absent" | "unknown"): MintedBirthVerdict {
  const stamp = Object.freeze({ gap_id: id, predicate_key: class2PredicateKey(meta), check: birthCheckBinding(meta), verdict }) as unknown as MintedBirthVerdict;
  MINTED_BIRTH_VERDICTS.add(stamp);
  return stamp;
}
/** The trusted verdict for this write, or null: minted here, for this gap id, for this exact check. */
function mintedVerdictFor(trusted: unknown, gapId: string, merged: Record<string, unknown>): "present" | "absent" | "unknown" | null {
  if (!trusted || typeof trusted !== "object" || !MINTED_BIRTH_VERDICTS.has(trusted)) return null;
  const t = trusted as MintedBirthVerdict;
  return t.gap_id === gapId && t.check === birthCheckBinding(merged) ? t.verdict : null;
}

function scheduleBirthEvaluation(job: { id: string; key: string; meta: Record<string, unknown> }, judge: BirthJudge): void {
  const run = __birthChain.then(async () => {
    // The tree is read when the evaluation STARTS: the verdict below is about this commit.
    const evalSha = readBirthTreeSha(job.meta);
    let verdict: BirthVerdict = await takeBirthVerdict(job.id, job.meta, judge);
    // The base: the detected sha when the writer gave one, else the tree when this evaluation was queued.
    const detectedSha = shaOf(job.meta["predicate_birth_detected_sha"]);
    const queuedSha = shaOf(job.meta["predicate_birth_queued_sha"]);
    const tree = verdict === "absent" ? birthTreeChange(job.meta, detectedSha ?? queuedSha, detectedSha ? "detected" : "queued", evalSha) : null;
    const moved = !!tree?.moved;
    if (moved) verdict = "unknown";
    try {
      const stamped = await stampBirthVerdict(job.id, job.key, verdict, evalSha, tree);
      const shape = String(((job.meta["evidence_resolve"] ?? {}) as { shape?: unknown }).shape ?? job.meta["verify_shape"] ?? "?");
      console.log(`[gap-birth] ${job.id}: class2 check ${shape} reads ${verdict} on ${evalSha ? evalSha.slice(0, 12) : "an unread tree"}` +
        (detectedSha ? ` (detected on ${detectedSha.slice(0, 12)})` : " (detection sha unknown)") +
        (verdict === "present" ? "" : moved ? ` — absent, but the tree moved (${tree!.reason}): unknown, not suspect`
          // An unmeasured check accuses nothing, so it is not labelled a suspect; it is still held (predicateSuspect:
          // not admissible, closes nothing) until the sweep re-takes it and it reads present.
          : verdict === "unknown" ? " — unknown: the check could not be measured at birth; held (not admissible, closes nothing) until a re-take reads present"
          : " — predicate_suspect: not admissible, and its absent closes nothing" + (tree ? ` [${tree.reason}]` : "")) +
        (stamped ? "" : " (not stamped: the predicate changed while it ran)"));
    } catch (err) {
      console.warn(`[gap-birth] ${job.id}: stamp failed (${String(err).slice(0, 160)})`);
    }
  });
  __birthChain = run.catch(() => undefined);
  __birthInflight.add(run);
  void run.finally(() => __birthInflight.delete(run));
}

/**
 * Decide the birth fields of a written row (mutates `merged`). Returns the evaluation to schedule, if any.
 * `prior` is the stored row's metadata before this write; incoming birth fields are discarded.
 */
function applyBirthStamp(
  gapId: string,
  status: string,
  falsifier: FalsifierClass,
  merged: Record<string, unknown>,
  prior: Record<string, unknown>,
  trusted: MintedBirthVerdict | undefined,
  nowIso: string,
  detectedSha?: string,
): { id: string; key: string; meta: Record<string, unknown> } | null {
  for (const f of BIRTH_FIELDS) delete merged[f];
  if (falsifier !== "class2") return null;
  const key = class2PredicateKey(merged);
  const carryPrior = (): void => { for (const f of BIRTH_FIELDS) if (prior[f] !== undefined) merged[f] = prior[f]; };
  const priorSameCheck = prior["predicate_birth_key"] === key && typeof prior["predicate_birth_verdict"] === "string";
  if (status !== "open") { if (priorSameCheck) carryPrior(); return null; }
  const detected = shaOf(detectedSha);
  // Only a verdict MINTED by takeBirthVerdictWithReport for this gap and this check (MINTED BIRTH VERDICTS);
  // anything else, a literal with the right key included, is ignored and the seam judges the check itself.
  const trustedVerdict = mintedVerdictFor(trusted, gapId, merged);
  if (trustedVerdict) {
    merged["predicate_birth_key"] = key;
    merged["predicate_birth_verdict"] = trustedVerdict;
    merged["predicate_birth_at"] = nowIso;
    const evalSha = readBirthTreeSha(merged);
    if (evalSha) merged["predicate_birth_sha"] = evalSha;
    if (detected) merged["predicate_birth_detected_sha"] = detected;
    return null;
  }
  // NOT A BIRTH: the stored row already carried this very check before birth stamps existed. What it read when
  // it was born is unknown, and reading it now cannot tell "inverted at birth" from "fixed since", so it keeps
  // its legacy (unstamped) treatment rather than being marked suspect by a re-emission.
  if (prior["predicate_birth_key"] === undefined && Object.keys(prior).length > 0 && class2PredicateKey(prior) === key) return null;
  // The same check carries its verdict forward: re-taking an unknown or a dead pending is the sweep's
  // (reevaluateBirthVerdicts). The one exception is a tree-moved unknown re-emitted with a NEW detection sha:
  // only a writer can supply that, so only a write can resolve it.
  if (priorSameCheck && !(detected && birthTreeMoved(prior) && prior["predicate_birth_verdict"] === "unknown" && shaOf(prior["predicate_birth_detected_sha"]) !== detected)) {
    carryPrior();
    return null;
  }
  merged["predicate_birth_key"] = key;
  merged["predicate_birth_verdict"] = "pending";
  merged["predicate_birth_at"] = nowIso;
  if (detected) merged["predicate_birth_detected_sha"] = detected;
  // The tree at SCHEDULE time: the base an absent is compared against when no detection sha was given.
  const queued = readBirthTreeSha(merged);
  if (queued) merged["predicate_birth_queued_sha"] = queued;
  return { id: gapId, key, meta: JSON.parse(JSON.stringify(merged)) as Record<string, unknown> };
}

/**
 * RE-CLASSIFICATION BY THE RESPONSE CONTRACTS (see RESPONSE CONTRACTS), run by the birth sweep before its picks and
 * outside its per-tick limit (it runs no check). Two directions, in one lock pass:
 *   - an open class2 row born 'unknown' (tree not moved) whose check its contract says can never be measured is
 *     re-classified "unresolvable" exactly as a write would classify it now, so it is no longer re-taken for nothing
 *     and becomes a check-supply candidate;
 *   - an open row "unresolvable" by a response contract that the current contracts no longer condemn (a new instrument
 *     can now run it) is re-classified as a write would, and when that is class2 it is stamped an unknown birth of
 *     this check, so the picks below re-take it in this same call.
 * Every other classification is left as the write stamped it. Mutates the sweep's rows to match what it saved.
 */
async function reclassifyByResponseContract(gaps: Array<Record<string, unknown>>): Promise<void> {
  const metaOf = (g: Record<string, unknown>): Record<string, unknown> => (g["classification_metadata"] ?? {}) as Record<string, unknown>;
  const byContract = (m: Record<string, unknown>): boolean => m["falsifier"] === "unresolvable" && String(m["falsifier_unresolvable_reason"] ?? "").startsWith(RESPONSE_CONTRACT_REASON);
  const wanted = (g: Record<string, unknown>): FalsifierClassification | null => {
    const m = metaOf(g);
    if (String(g["status"] ?? "open") !== "open") return null;
    if (m["falsifier"] === "class2") {
      if (m["predicate_birth_verdict"] !== "unknown" || birthTreeMoved(m) || m["predicate_birth_key"] !== class2PredicateKey(m)) return null;
      const c = classifyFalsifier(m);
      return c.falsifier === "unresolvable" && String(c.unresolvable_reason ?? "").startsWith(RESPONSE_CONTRACT_REASON) ? c : null;
    }
    if (!byContract(m) || checkArmingProblem(m["evidence_resolve"])) return null;
    return classifyFalsifier(m);
  };
  const ids = gaps.filter((g) => wanted(g) !== null).map((g) => String(g["id"] ?? ""));
  if (ids.length === 0) return;
  const done = await withGapLock(async () => {
    const rows = await loadGaps();
    const changed: Array<{ id: string; meta: Record<string, unknown>; c: FalsifierClassification }> = [];
    for (const id of ids) {
      const row = rows.find((r) => r.id === id);
      const c = row ? wanted(row as unknown as Record<string, unknown>) : null; // re-decided on the row as stored now
      if (!row || !c) continue;
      const meta = (row.classification_metadata ?? {}) as Record<string, unknown>;
      stampFalsifierClassification(meta, c);
      if (c.falsifier === "class2") {
        meta["predicate_birth_key"] = class2PredicateKey(meta);
        meta["predicate_birth_verdict"] = "unknown";
        meta["predicate_birth_at"] = new Date().toISOString();
        for (const f of ["predicate_birth_tree_moved", "predicate_birth_tree_reason"]) delete meta[f];
      }
      row.classification_metadata = meta as SubstrateGap["classification_metadata"];
      changed.push({ id, meta: JSON.parse(JSON.stringify(meta)) as Record<string, unknown>, c });
    }
    if (changed.length > 0) await saveGaps(rows);
    return changed;
  });
  for (const d of done) {
    const g = gaps.find((x) => String(x["id"] ?? "") === d.id);
    if (g) g["classification_metadata"] = d.meta;
    console.log(d.c.falsifier === "unresolvable"
      ? `[gap-birth] ${d.id}: class2 check ${d.c.predicate_shape ?? "?"} re-classified unresolvable by the sweep at ${d.c.predicate_position ?? "?"} (${String(d.c.unresolvable_reason).slice(0, 240)}); not re-taken`
      : `[gap-birth] ${d.id}: response-contract unresolvable lifted by the sweep (falsifier=${d.c.falsifier}); ${d.c.falsifier === "class2" ? "its birth is re-taken" : "not a class-2 check"}`);
  }
}

/**
 * SCHEDULED RE-EVALUATION (qa R1), run from the pending-land sweep's tick over the open gaps it already read.
 * Re-takes, oldest predicate_birth_at first and at most `limit` per call: an 'unknown' (an outage or timeout
 * at birth), or a 'pending' older than BIRTH_PENDING_STALE_MS (its evaluation died with the process). A
 * tree-moved unknown is skipped: HEAD only moves further from its detection sha, so re-taking it cannot
 * resolve it. Each pick is re-stamped 'pending' now (so the next tick does not pick it again, and a pending
 * past the hour still means "died"), then evaluated on the same birth chain as a write's, through the same
 * takeBirthVerdict. Only where the store is HELD: the stamp writes the local store.
 */
export async function reevaluateBirthVerdicts(gaps: Array<Record<string, unknown>>, limit = BIRTH_REEVAL_PER_TICK, judge?: BirthJudge): Promise<string[]> {
  if (process.env["GAP_STORE_ENDPOINT"] || limit <= 0) return [];
  const nowMs = Date.now();
  const at = (m: Record<string, unknown>): number => { const t = Date.parse(String(m["predicate_birth_at"] ?? "")); return Number.isFinite(t) ? t : 0; };
  await reclassifyByResponseContract(gaps);
  const due = (g: Record<string, unknown>): boolean => {
    const m = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
    if (String(g["status"] ?? "open") !== "open" || m["predicate_birth_key"] !== class2PredicateKey(m)) return false;
    const f = m["falsifier"] as unknown;
    if (String((f && typeof f === "object" ? (f as { class?: unknown }).class : f) ?? "").toLowerCase() !== "class2") return false;
    const v = m["predicate_birth_verdict"];
    return (v === "unknown" && !birthTreeMoved(m)) || (v === "pending" && nowMs - at(m) > BIRTH_PENDING_STALE_MS);
  };
  const picks = gaps.filter(due)
    .sort((a, b) => at((a["classification_metadata"] ?? {}) as Record<string, unknown>) - at((b["classification_metadata"] ?? {}) as Record<string, unknown>))
    .slice(0, limit);
  const taken: string[] = [];
  for (const g of picks) {
    const id = String(g["id"] ?? "");
    const job = await withGapLock(async () => {
      const rows = await loadGaps();
      const row = rows.find((r) => r.id === id);
      const meta = (row?.classification_metadata ?? null) as Record<string, unknown> | null;
      if (!row || !meta || !due(row as unknown as Record<string, unknown>)) return null; // changed since the sweep read it
      meta["predicate_birth_verdict"] = "pending";
      meta["predicate_birth_at"] = new Date().toISOString();
      const queued = readBirthTreeSha(meta); // re-queued now: this is the tree a re-take is compared against
      if (queued) meta["predicate_birth_queued_sha"] = queued; else delete meta["predicate_birth_queued_sha"];
      await saveGaps(rows);
      return { id, key: String(meta["predicate_birth_key"]), meta: JSON.parse(JSON.stringify(meta)) as Record<string, unknown> };
    });
    if (!job) continue;
    console.log(`[gap-birth] ${id}: birth verdict re-taken by the sweep (${String(((g["classification_metadata"] ?? {}) as Record<string, unknown>)["predicate_birth_verdict"])})`);
    scheduleBirthEvaluation(job, judge ?? __birthJudgeOverride ?? defaultBirthJudge);
    taken.push(id);
  }
  return taken;
}

/**
 * The store-wide coverage census — the aggregate the operator used to compute by
 * hand. Returned on every read so `falsifier='none'` is answerable FROM THE STORE.
 * Counted over OPEN gaps only: a closed gap's closability is settled history.
 *
 * `unstamped` counts open rows written before this accounting existed (or by a
 * path whose stamp threw). It is not the same as "none" and must not be folded
 * into it — conflating "we looked and found nothing" with "we never looked" is
 * the exact ambiguity this whole mechanism exists to remove.
 */
export function falsifierCoverage(gaps: SubstrateGap[]): Record<string, number> {
  const counts: Record<string, number> = { class1: 0, class2: 0, unresolvable: 0, none: 0, unstamped: 0 };
  for (const g of gaps) {
    if ((g.status ?? "open") !== "open") continue;
    const f = ((g.classification_metadata ?? {}) as Record<string, unknown>)["falsifier"];
    if (typeof f === "string" && f in counts) counts[f]!++;
    else counts["unstamped"]!++;
  }
  return counts;
}

export async function resolveSubstrateGap(
  pointer: SubstrateGapReadPointer,
): Promise<ResolverResult> {
  { const fwd = await forwardToGapStore(pointer as unknown as Record<string, unknown>); if (fwd) return fwd; }
  const snap = await loadGapsForRead();
  const gaps = snap.rows;
  const limit = pointer.limit ?? 50;

  let results = gaps;

  if (pointer.id) {
    results = snap.byId.get(pointer.id) ?? [];
  }
  if (pointer.category) {
    results = results.filter((g) => g.category === pointer.category);
  }
  if (pointer.source) {
    results = results.filter((g) => g.source === pointer.source);
  }
  if (pointer.status) {
    results = results.filter((g) => g.status === pointer.status);
  }
  if (pointer.status === "open" && !pointer.id && pointer.include_held !== true) {
    results = results.filter((g) => (g.classification_metadata as { operator_hold?: unknown } | undefined)?.operator_hold !== true);
  }
  if (pointer.exclude_categories && pointer.exclude_categories.length) {
    const excluded = new Set(pointer.exclude_categories);
    results = results.filter((g) => !excluded.has(String(g.category)));
  }

  // A copy: with no filter, `results` IS the shared snapshot's array, and sort() works in place.
  results = [...results]
    .sort((a, b) => (b.updated_at || b.created_at || b.detected_at || "").localeCompare(a.updated_at || a.created_at || a.detected_at || ""))
    .slice(0, limit);

  if (snap.coverage === null) snap.coverage = falsifierCoverage(gaps);
  return {
    shape: "substrateGap",
    body: {
      gaps: structuredClone(results),
      total: results.length,
      // ADDITIVE. Existing consumers read `gaps`/`total` only. This is the census
      // over the WHOLE open store (not the filtered/limited page) so that
      // "how many open gaps can never close?" is answerable from any read instead
      // of by hand-grepping the store file.
      falsifier_coverage: structuredClone(snap.coverage),
      ...(pointer.include_calibration ? { expectation_calibration: readExpectationCalibration(), learning_credit: readLearningCredit(gaps) } : {}),
    },
  };
}

/**
 * Build a gap from a FLAT pointer, so this resolver works with whatever an activity threads in
 * rather than only with one hand-written envelope.
 *
 * An activity carries its data as pointer fields; different producers name the prose differently
 * (`summary`, `detail`, `description`, `text`, `message`, `title`). The previous normalization
 * accepted `summary` only, so every other threading failed with `missing_required_field` — which
 * is what four separate minted arms hit on 2026-08-05.
 *
 * Returns null when there is nothing gap-like to build from — an EMPTY pointer must still be
 * refused. A write resolver inventing content it was never given is the failure this vessel
 * exists to avoid; refusing an empty write is correct behavior, not the bug.
 */
function coerceFlatGapPointer(p: Record<string, unknown>): Record<string, unknown> | null {
  if (p["gap"] !== undefined && p["gap"] !== null) return null;   // already enveloped
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return undefined;
  };
  // Prose first: without a real description there is no gap worth writing.
  const summary = str("summary", "detail", "description", "text", "message", "body", "title");
  if (!summary) return null;
  const id = str("id", "gap_id", "slug") ?? `gap-${Date.now().toString(36)}`;
  return {
    id,
    category: str("category", "gap_category") ?? "other",
    // Name the threading that produced this, so a row written from a flat pointer is
    // distinguishable in the store from one an operator or a template enveloped properly.
    source: str("source") ?? "walk_flat_pointer",
    status: str("status") ?? "open",
    detected_at: str("detected_at", "first_detected_at") ?? new Date().toISOString(),
    summary,
    ...(typeof p["classification_metadata"] === "object" && p["classification_metadata"] !== null && !Array.isArray(p["classification_metadata"])
      ? { classification_metadata: p["classification_metadata"] as Record<string, unknown> }
      : {}),
    ...(str("route") ? { route: str("route") } : {}),
    ...(typeof p["classification_metadata"] === "object" && p["classification_metadata"] !== null && !Array.isArray(p["classification_metadata"])
      ? { classification_metadata: p["classification_metadata"] as Record<string, unknown> }
      : {}),
  };
}

/**
 * UNRENDERED TEMPLATES (2026-10-03). Any {{...}} that reached the writer. Live rows held id "{{goal.id}}",
 * summary "{{goal.summary}}" and the like, all written as CLOSES, which the open-only description gate never
 * looked at; and narrower matching (identifier paths only) let {{goal[0]}}, {{goal?.id}},
 * {{ goal.id | upper }}, {{ goal. id }} and {{#each x}} through. So every {{...}} counts, whatever is inside,
 * except: a token wrapped in backticks (a QUOTATION: a gap describing an interpolation bug names it that way),
 * and JSX double braces (an object literal `{{ key: ... }}`, or braces directly after "=" as in
 * `opts={{...rest}}`). An unterminated "{{" is not a token. ${...} is not a placeholder here.
 */
const TEMPLATE_TOKEN = /\{\{([\s\S]*?)\}\}/g;
const JSX_OBJECT_LITERAL = /^\s*[A-Za-z_$][\w$]*\s*:/;
const TEMPLATE_REFERENCE = /[A-Za-z_$][\w$]*(\??\.|\[)/;
export function unrenderedBindingToken(s: string): string | null {
  for (const m of s.matchAll(TEMPLATE_TOKEN)) {
    const i = m.index ?? 0;
    const end = i + m[0].length;
    if (s[i - 1] === "`" && s[end] === "`") continue;
    // JSX exemptions cover literal object contents only: content holding a dotted path or an index reference
    // (goal.operator, goal?.id, items[0]) is a template reference whatever precedes it (qa: the "=" skip let
    // closed_by={{goal.operator}} through, the object-literal skip let {{ status: goal.status }} through).
    if ((s[i - 1] === "=" || JSX_OBJECT_LITERAL.test(m[1] ?? "")) && !TEMPLATE_REFERENCE.test(m[1] ?? "")) continue;
    return m[0];
  }
  return null;
}
/**
 * The first field of an incoming gap holding an unrendered binding token, or null. id, category,
 * source, summary, and every string under classification_metadata (objects and arrays, bounded).
 * A value byte-identical to the STORED row's value at the same field is exempt, except the id:
 * read-modify-write callers re-send stored summaries and metadata, and a row written before this
 * gate must stay writable rather than wedge every later close of it.
 */
function unrenderedBindingField(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
): { field: string; token: string } | null {
  for (const k of ["id", "category", "source", "summary"]) {
    const v = incoming[k];
    if (typeof v !== "string") continue;
    const t = unrenderedBindingToken(v);
    if (!t) continue;
    if (k !== "id" && stored && stored[k] === v) continue;
    return { field: `gap.${k}`, token: t };
  }
  const storedMeta = stored?.["classification_metadata"];
  let budget = 5000;
  const walk = (v: unknown, s: unknown, path: string, depth: number): { field: string; token: string } | null => {
    if (--budget < 0 || depth > 12) return null;
    if (typeof v === "string") {
      const t = unrenderedBindingToken(v);
      return t && s !== v ? { field: path, token: t } : null;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const hit = walk(v[i], Array.isArray(s) ? s[i] : undefined, `${path}.${i}`, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (v !== null && typeof v === "object") {
      const so = s !== null && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const hit = walk(child, so[k], `${path}.${k}`, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(incoming["classification_metadata"], storedMeta, "gap.classification_metadata", 0);
}

/**
 * OPERATOR MARKER (2026-10-03). The pointer-level `operator` field, when it is an operator id
 * ("operator:<id>"), else null. No such marker existed before: operator hand-closes carried ad hoc
 * metadata (resolution, closure_reason, fix_commits) indistinguishable from a walk's. It is never stored,
 * so it cannot be carried forward by a writer that re-sends a stored row. It makes an operator write
 * EXPLICIT; it does not authenticate one (the admin-scope check in pool-impulse.ts operatorCredential is
 * route-level and would lock out cockpit-key operator writes, so it is not used here).
 */
const OPERATOR_MARKER = /^operator:[A-Za-z0-9._@-]+$/;
export function operatorMarkerOf(pointer: unknown): string | null {
  const v = (pointer as { operator?: unknown } | null | undefined)?.operator;
  return typeof v === "string" && OPERATOR_MARKER.test(v.trim()) ? v.trim() : null;
}
/** The keys a close leaves in classification_metadata as its verdict; an open row carries none of them. */
export const CLOSURE_EVIDENCE_KEYS = ["closed_reason", "rejected_reason", "closed_by", "close_basis", "landed_sha", "landed_commit", "falsifier_exercise", "close_note"] as const;
/** The verdict a close or reject stands on. A write that keeps a row closed (or rejected) does not change these without the operator marker. */
export const CLOSURE_VERDICT_KEYS = ["closed_reason", "rejected_reason", "closed_by", "close_basis", "landed_sha", "landed_commit", "falsifier_exercise"] as const;
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
/**
 * CLOSE NEEDS EVIDENCE (2026-10-03). What a write moving an existing row INTO closed or rejected must carry:
 * closed_reason or rejected_reason (metadata or top level) and one piece of evidence: an exercised falsifier_exercise
 * (an object with a boolean `passed`), a land signal (landed_sha / landed_commit), a named closer
 * (closed_by / close_basis, metadata or top level), or the operator marker. Read from the INCOMING
 * write only, before the store carries the old row's keys forward. Returns the evidence kind, or why not.
 */
export function closeEvidenceOf(
  incoming: Record<string, unknown>,
  operator: string | null,
): { ok: true; reason: string; evidence: string } | { ok: false; missing: string } {
  const meta = (incoming["classification_metadata"] ?? {}) as Record<string, unknown>;
  const reason = [meta["closed_reason"], incoming["closed_reason"], meta["rejected_reason"], incoming["rejected_reason"]].find(nonEmptyString);
  if (!reason) return { ok: false, missing: "closed_reason or rejected_reason (a non-empty string in classification_metadata or on the gap)" };
  const ex = meta["falsifier_exercise"];
  if (ex !== null && typeof ex === "object" && !Array.isArray(ex) && typeof (ex as { passed?: unknown }).passed === "boolean") return { ok: true, reason, evidence: "falsifier_exercise" };
  if (nonEmptyString(meta["landed_sha"]) || nonEmptyString(meta["landed_commit"])) return { ok: true, reason, evidence: "land_signal" };
  for (const k of ["closed_by", "close_basis"]) {
    if (nonEmptyString(meta[k]) || nonEmptyString(incoming[k])) return { ok: true, reason, evidence: k };
  }
  if (operator) return { ok: true, reason, evidence: "operator_marker" };
  return { ok: false, missing: "closure evidence: classification_metadata.falsifier_exercise {passed: boolean}, landed_sha / landed_commit, closed_by / close_basis naming the closer, or the pointer-level operator marker \"operator:<id>\"" };
}

/** PLACEHOLDER GATE (see unrenderedBindingField): a refusal naming the field, or null. */
function placeholderGate(incoming: Record<string, unknown>, id: string, status: string, stored: SubstrateGap | undefined): ResolverResult | null {
  const hit = unrenderedBindingField(incoming, stored as unknown as Record<string, unknown> | undefined);
  if (!hit) return null;
  console.warn(`[substrate-gap] REFUSED write to ${id}: unrendered binding ${hit.token} in ${hit.field} (status ${status})`);
  return {
    shape: "structuredError",
    body: {
      resolver: "substrateGap_write",
      failure_mode: "validation_rejected",
      rule: "no_unrendered_placeholders",
      field: hit.field,
      detail: `gap ${id}: unrendered binding ${hit.token} in ${hit.field} — bind every slot before writing (a gap that quotes a token names it in backticks, e.g. \`{{goal.id}}\`)`,
    },
  } as ResolverResult;
}

/**
 * The gates that depend on the STORED row a write lands on. Shared by the store holder (inside the lock)
 * and by a forwarding node (against the row read from the holder, before forwarding).
 *
 * operator_hold (2026-10-03, widened from "refuse a close"): on a row whose STORED operator_hold is true, a
 * write without the operator marker may not change the status (a reject moved held gaps as freely as a
 * close used to), may not release the hold (an incoming operator_hold key other than true would win the
 * carry-forward), and keeps the stored summary, category and edit_site (holdKeepsText, applied by the
 * caller). falsifier_exercise.passed in the INCOMING payload does not bypass the hold: it is the writer's
 * own claim, and the live row "{{goal.id}}" carried a forged one. Lane closers already skip held gaps.
 *
 * CLOSE NEEDS EVIDENCE (see closeEvidenceOf): a TRANSITION into closed or rejected (a reject takes a gap out
 * of every open-gap supply just as a close does). A write that keeps the status is not gated here; its
 * verdict keys are kept by the caller. Read from the incoming write, before any carry-forward.
 */
function existingRowGates(
  pointer: unknown,
  incoming: Record<string, unknown>,
  id: string,
  to: string,
  existing: SubstrateGap,
): { refused: ResolverResult } | { holdKeepsText: boolean } {
  const marker = operatorMarkerOf(pointer);
  const from = String(existing.status ?? "open");
  let holdKeepsText = false;
  const existingMeta = (existing.classification_metadata ?? {}) as Record<string, unknown>;
  const incomingMeta = (incoming["classification_metadata"] ?? {}) as Record<string, unknown>;
  if (existingMeta["operator_hold"] === true && !marker) {
    const refuse = (detail: string) => ({
      refused: { shape: "structuredError", body: { resolver: "substrateGap_write", failure_mode: "validation_rejected", rule: "operator_hold", detail } } as ResolverResult,
    });
    if (to !== from) {
      console.warn(`[substrate-gap] REFUSED ${from} -> ${to} on held gap ${id}: no operator marker`);
      return refuse(`gap ${id}: operator_hold is set — a status change (${from} -> ${to}) needs the operator marker (pointer-level operator: "operator:<id>"); classification_metadata.falsifier_exercise.passed in the payload does not bypass the hold`);
    }
    if ("operator_hold" in incomingMeta && incomingMeta["operator_hold"] !== true) {
      console.warn(`[substrate-gap] REFUSED hold release on ${id}: no operator marker`);
      return refuse(`gap ${id}: operator_hold is set — releasing it needs the operator marker (pointer-level operator: "operator:<id>")`);
    }
    holdKeepsText = true;
  }
  if ((to === "closed" || to === "rejected") && from !== to) {
    const ev = closeEvidenceOf(incoming, marker);
    if (!ev.ok) {
      console.warn(`[substrate-gap] REFUSED ${to} of ${id}: no ${ev.missing.split(" (")[0]!.split(":")[0]}`);
      return {
        refused: {
          shape: "structuredError",
          body: {
            resolver: "substrateGap_write",
            failure_mode: "validation_rejected",
            rule: "close_needs_evidence",
            detail: `gap ${id}: a ${to} write needs closed_reason (or rejected_reason) plus evidence; missing ${ev.missing}. The row stays ${from}.`,
          },
        } as ResolverResult,
      };
    }
    console.log(`[substrate-gap] ${to} of ${id}: reason=${ev.reason} evidence=${ev.evidence}`);
  }
  return { holdKeepsText };
}

/**
 * GATES BEFORE FORWARDING (2026-10-03). A node with GAP_STORE_ENDPOINT set forwards the write to the store
 * holder. It used to forward before every gate; a holder on the same build re-applies them, a holder on an
 * older build applied none. So the forwarding node reads the stored row by id from the holder and runs the
 * row-dependent gates itself; it forwards only a write that passes. An unreadable holder fails closed (the
 * forward would fail as well). The class-match fallback (a fresh timestamped id landing on an open row of
 * its class) is the holder's alone: here only the exact id is checked.
 */
/** Mask any `ApiKey <token>` / `Bearer <token>` in text that is about to be logged (a remote body may echo a credential). */
export function redactAuthTokens(text: string): string {
  return text.replace(/\b(ApiKey|Bearer)(\s+)[^\s"'\\,}\]]+/gi, "$1$2[redacted]");
}
async function gateThenForward(pointer: Record<string, unknown>, incoming: Record<string, unknown>, audit: GapWriteAudit): Promise<ResolverResult> {
  const id = String(incoming["id"]);
  const status = String(incoming["status"] ?? "open");
  const queueable = gapWriteIsQueueable();
  // THE WRITE ID (GAP-WRITE QUEUE): minted here, on the first attempt of a write that may be queued, and sent with every
  // forward of it, so the holder applies it once however often it is sent (a timeout after the holder applied it, a
  // replay). A replayed write already carries its own.
  if (queueable && (typeof pointer["write_id"] !== "string" || !GAP_WRITE_ID_RE.test(pointer["write_id"] as string))) pointer["write_id"] = randomUUID();
  const writeId = typeof pointer["write_id"] === "string" ? (pointer["write_id"] as string) : "";
  // FIFO: while earlier writes of this node wait in the queue, a new one waits behind them, so a later write of a gap
  // never reaches the holder before an earlier one.
  if (queueable && queuedFiles(gapForwardQueueDir()).length > 0) return queueGapWrite(id, writeId, pointer, "earlier writes are queued");
  const read = await forwardToGapStore({ type: "substrateGap", id, limit: 5 });
  const rows = (read?.body as { gaps?: unknown } | undefined)?.gaps;
  if (!read || read.shape !== "substrateGap" || !Array.isArray(rows)) {
    const transient = (read?.body as { failure_mode?: unknown } | undefined)?.failure_mode === "gap_store_unreachable";
    if (transient && queueable) return queueGapWrite(id, writeId, pointer, "the holder could not be read");
    // The holder's own answer (timeout vs refusal vs HTTP status) goes in the log, so a node's journal can say WHY it is unreadable.
    // It is a REMOTE body, so any credential it echoes (an auth refusal quoting the header) is masked before it is logged.
    console.warn(`[substrate-gap] NOT forwarded ${id}: the gap-store holder could not be read, so the write gates cannot be applied (holder said: ${redactAuthTokens(JSON.stringify(read?.body ?? null)).slice(0, 200)})`);
    return {
      shape: "structuredError",
      body: {
        resolver: "substrateGap_write",
        failure_mode: "gap_store_unavailable",
        // With the queue off (a scratch store in tests), the answer is exactly what it was before the queue.
        ...(gapForwardQueueEnabled() ? { ...(transient ? { transient: true } : {}), queued: false, ...(queueable ? {} : { queue_refused: gapWriteReplaying() ? "replaying" : "principal_not_this_node" }) } : {}),
        detail: `gap ${id}: not forwarded — the gap-store holder could not be read (${JSON.stringify(read?.body ?? null).slice(0, 200)}), so the write gates cannot be applied`,
      },
    } as ResolverResult;
  }
  const stored = (rows as SubstrateGap[]).find((g) => g && g.id === id);
  audit.from = stored ? String(stored.status ?? "open") : "absent";
  audit.stored = stored ?? null;
  const ph = placeholderGate(incoming, id, status, stored);
  if (ph) return ph;
  if (stored) {
    const rg = existingRowGates(pointer, incoming, id, status, stored);
    if ("refused" in rg) return rg.refused;
  }
  const sent = (await forwardToGapStore(pointer))!;
  if (queueable && (sent.body as { failure_mode?: unknown } | undefined)?.failure_mode === "gap_store_unreachable") return queueGapWrite(id, writeId, pointer, "the holder did not take the write");
  return sent;
}

/**
 * OPERATOR-MARKER AUDIT (2026-10-03). The marker grants latitude (release a hold, correct a closed verdict,
 * close a held gap) and authenticates nothing, so every write carrying it leaves one [gap-audit] line: gap
 * id, transition (stored status -> written status; "absent" for no row, "?" when the write was refused
 * before the store was read), marker, outcome, and the caller identity the HTTP route stamped as
 * _route_caller (the identity that validated the request, or "unauthenticated", never anything derived
 * from the presented key; and the remote address). A write
 * that did not come through the route is caller=in-process.
 *
 * Every call, marked or not, also appends one gap-write event (see GAP-WRITE EVENTS). `stored` is the row the
 * write was gated against (null: no row), `id` and `changed` are set only when the write is saved here.
 */
type GapWriteAudit = { from?: string; stored?: SubstrateGap | null; id?: string; changed?: string[] };
export async function resolveSubstrateGapWrite(
  pointer: SubstrateGapWritePointer | Record<string, unknown>,
  // Additive, test-facing: inject a vocabulary rather than depending on the host's
  // filesystem layout. No production caller passes it (the cached fleet scan is used).
  opts?: {
    vocabulary?: ShapeVocabulary | null,
    anchorNotFoundHandler?: (error: Error) => void,
    /** In-process only: a verdict minted by takeBirthVerdictWithReport for this gap's exact class-2 check (see MINTED BIRTH VERDICTS). Anything else is ignored. */
    birthVerdict?: MintedBirthVerdict,
    /** Tests only: the judge for this write's birth evaluation. */
    birthJudge?: BirthJudge,
    /** In-process only: the commit the writer detected the defect against (see WHICH TREE). */
    detectedSha?: string,
  },
): Promise<ResolverResult> {
  const marker = operatorMarkerOf(pointer);
  const audit: GapWriteAudit = {};
  let r: ResolverResult | undefined;
  try {
    r = await applyWriteOnce(pointer, audit, () => resolveSubstrateGapWriteInner(pointer, opts, audit));
    return r;
  } finally {
    if (marker) {
      const p = pointer as Record<string, unknown>;
      const g = (p["gap"] && typeof p["gap"] === "object" ? p["gap"] : p) as Record<string, unknown>;
      const rc = p["_route_caller"] as { auth?: unknown; remote?: unknown } | undefined;
      const caller = rc && typeof rc === "object"
        ? `${typeof rc.auth === "string" ? rc.auth : "unauthenticated"} remote=${typeof rc.remote === "string" ? rc.remote : "unknown"}`
        : "in-process remote=-";
      const b = (r?.body ?? {}) as Record<string, unknown>;
      const outcome = !r ? "threw" : r.shape === "structuredError" ? `structuredError:${String(b["rule"] ?? b["failure_mode"] ?? b["error"] ?? "error")}` : r.shape;
      console.log(`[gap-audit] operator-marked write gap=${String(g["id"] ?? "(no id)")} transition=${audit.from ?? "?"}->${String(g["status"] ?? "open")} marker=${marker} caller=${caller} outcome=${outcome}`);
    }
    // ONE GAP-WRITE EVENT PER CALL (see GAP-WRITE EVENTS). Built inside its own catch: nothing here may throw
    // out of this finally or replace the write's result.
    let gapIdForLog = "(no id)";
    try {
      const p = pointer as Record<string, unknown>;
      const env = p["gap"];
      const g = (env && typeof env === "object" && !Array.isArray(env) ? env : {}) as Record<string, unknown>;
      const incomingId = typeof g["id"] === "string" && g["id"].length > 0 ? g["id"] : null;
      gapIdForLog = audit.id ?? incomingId ?? "(no id)";
      const b = (r?.body ?? {}) as Record<string, unknown>;
      const outcome = !r ? "threw" : r.shape === "structuredError" ? `refused:${String(b["rule"] ?? b["failure_mode"] ?? b["error"] ?? "error")}` : "written";
      const principal = gapWritePrincipal(pointer);
      appendGapWriteEvent({
        gap_id: audit.id ?? incomingId,
        fields_changed: audit.changed ?? gapFieldsAttempted(audit.stored ?? null, g),
        status_from: audit.from ?? "?",
        status_to: String(g["status"] ?? "open"),
        outcome,
        principal_kind: principal.kind,
        key_id: principal.key_id,
        route_caller_remote: principal.remote,
        route: principal.route,
        operator_marker: marker !== null,
        store: gapStoreIsLocal() ? "local" : "forwarded",
        ts: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[gap-write-event] event NOT recorded for gap=${gapIdForLog} (the write itself is unaffected): ${String(err).slice(0, 200)}`);
    }
  }
}

async function resolveSubstrateGapWriteInner(
  pointer: SubstrateGapWritePointer | Record<string, unknown>,
  // Additive, test-facing: inject a vocabulary rather than depending on the host's
  // filesystem layout. No production caller passes it (the cached fleet scan is used).
  opts?: {
    vocabulary?: ShapeVocabulary | null,
    anchorNotFoundHandler?: (error: Error) => void,
    /** In-process only: a verdict minted by takeBirthVerdictWithReport for this gap's exact class-2 check (see MINTED BIRTH VERDICTS). Anything else is ignored. */
    birthVerdict?: MintedBirthVerdict,
    /** Tests only: the judge for this write's birth evaluation. */
    birthJudge?: BirthJudge,
    /** In-process only: the commit the writer detected the defect against (see WHICH TREE). */
    detectedSha?: string,
  },
  audit: GapWriteAudit = {},
): Promise<ResolverResult> {
  // METADATA TYPE GATE (2026-10-03). classification_metadata is a record the store merges key by key.
  // A walk wrote the unrendered STRING "{{goal.classification_metadata}}" here; it was cast to a record
  // and the carry-forward loop stored one key per character on an operator gap. Present-and-not-an-object
  // (string, number, boolean, array) is refused, on the enveloped and the flat pointer alike. Absent or
  // null is "no metadata" and passes.
  {
    const p = pointer as Record<string, unknown>;
    const env = p["gap"];
    const holder = env !== undefined && env !== null && typeof env === "object" ? (env as Record<string, unknown>) : p;
    const cm = holder["classification_metadata"];
    if (cm !== undefined && cm !== null && (typeof cm !== "object" || Array.isArray(cm))) {
      return {
        shape: "structuredError",
        body: {
          resolver: "substrateGap_write",
          failure_mode: "validation_rejected",
          rule: "classification_metadata_must_be_object",
          field: "gap.classification_metadata",
          detail: `gap ${String(holder["id"] ?? "(no id)")}: classification_metadata must be an object of named fields, got ${Array.isArray(cm) ? "an array" : `a ${typeof cm}`}`,
        },
      };
    }
  }
  // DIRECTED IS AN OPERATOR'S FIELD (lib/operator-direct.ts): honoured and stamped (directed_by) only under the
  // route's grant or an in-process propagation of an honoured direction; otherwise stripped from this write and logged.
  gateGapDirected(pointer as Record<string, unknown>);
  const flat = coerceFlatGapPointer(pointer as Record<string, unknown>);
  if (flat) (pointer as Record<string, unknown>)["gap"] = flat;
  if ((pointer as Record<string, unknown>)["gap"] === undefined || (pointer as Record<string, unknown>)["gap"] === null) {
    return {
      shape: "structuredError",
      body: {
        error: "missing_required_field",
        field: "gap",
        // Say the STRUCTURE, not just the field name. This message is fed back verbatim into
        // goal-host's pointer-arg synthesis as the correction hint, so a message that only names
        // the missing key sends the retry back to the same flat shape it just failed with.
        message:
          'resolveSubstrateGapWrite needs the gap fields. Preferred: {type:"substrateGap_write", gap:{id, category, source, status, detected_at, summary}}. A flat pointer carrying a summary/detail/description/title is also accepted. Resolve pointer:{type:"resolver_schema", shape:"substrateGap_write"} for the full contract.',
      },
    };
  }
  const now = new Date().toISOString();
  const incoming = (pointer as SubstrateGapWritePointer).gap;
  // A trace id in scope for a close, when the caller provides one — either an
  // explicit closed_by_trace field or a trace-ish key on classification_metadata.
  // Optional: absent when no trace closed the gap. Backward-compatible.
  const closedMeta = (incoming.classification_metadata ?? {}) as Record<string, unknown>;
  const closedByTrace: string | undefined =
    (typeof incoming.closed_by_trace === "string" ? incoming.closed_by_trace : undefined) ??
    (typeof closedMeta["closed_by_trace"] === "string" ? (closedMeta["closed_by_trace"] as string) : undefined) ??
    (typeof closedMeta["closing_trace_id"] === "string" ? (closedMeta["closing_trace_id"] as string) : undefined) ??
    (typeof closedMeta["trace_id"] === "string" ? (closedMeta["trace_id"] as string) : undefined);

  // Identity gate. Everything downstream — exact-id match, class dedup, the
  // consumption gate — keys off `id`, so a gap without one has no identity to
  // dedup or close against and previously reached gapClassKey and 500'd. Say so
  // as a validation rejection: this detail is fed back verbatim into goal-host's
  // pointer-arg synthesis, and "missing id" is a correctable instruction while
  // an opaque 500 sends the retry back with the same body.
  if (typeof incoming.id !== "string" || incoming.id.trim().length === 0) {
    return {
      shape: "structuredError",
      body: {
        resolver: "substrateGap_write",
        failure_mode: "validation_rejected",
        error: "missing_required_field",
        field: "gap.id",
        detail:
          'gap.id is required and must be a non-empty string — it is the dedup and close key. ' +
          'Note the field is `id`, not `gap_id`: a row written with the wrong key has no identity here.',
      },
    };
  }

  // CHECK-INPUT GATE (2026-10-03). A test_suite check's only_tests become bun's -t pattern in a shell
  // command. test_suite itself now passes them as data and refuses an unrunnable name, but a row armed
  // here is re-run on every tick and carried forward into re-emissions, so a name with a control character
  // (a newline splits the pattern) or an absurd length is refused at ARM time, by the same rule
  // (onlyTestsProblem), instead of failing at every later run. Regex metacharacters are fine: test_suite
  // escapes them, never strips them. OPEN writes only, like the description gate below: a close or reject
  // re-sends the stored metadata, and a row already holding such a name must stay closable.
  if ((incoming.status ?? "open") === "open") {
    const er = ((incoming.classification_metadata ?? {}) as Record<string, unknown>)["evidence_resolve"] as { shape?: unknown; input?: unknown } | null | undefined;
    if (er && typeof er === "object" && er.shape === "test_suite" && er.input && typeof er.input === "object") {
      const bad = onlyTestsProblem((er.input as Record<string, unknown>)["only_tests"]);
      if (bad) {
        return {
          shape: "structuredError",
          body: {
            resolver: "substrateGap_write",
            failure_mode: "validation_rejected",
            field: `classification_metadata.evidence_resolve.input.${bad.field}`,
            detail: `gap ${incoming.id}: ${bad.detail}`,
          },
        };
      }
    }
  }

  // Description gate: an OPEN gap must describe itself — empty summaries and
  // uninterpolated {{placeholders}} are noise the drafter cannot act on.
  // Closes/rejections of existing junk rows pass through untouched.
  if ((incoming.status ?? "open") === "open") {
    const summaryText = typeof incoming.summary === "string" ? incoming.summary.trim() : "";
    // This early check covers id/category of OPEN writes only. The every-status gate inside the lock
    // (unrenderedBindingField) covers id, category, source, summary and metadata; a summary that quotes a
    // token names it in backticks.
    const gateFields = `${incoming.id} ${incoming.category}`;
    if (summaryText.length === 0 || gateFields.includes("{{")) {
      return {
        shape: "structuredError",
        body: {
          resolver: "substrateGap_write",
          failure_mode: "validation_rejected",
          detail: summaryText.length === 0
            ? `gap ${incoming.id}: empty summary — an open gap must describe itself so the drafter can act on it`
            : `gap ${incoming.id}: uninterpolated {{placeholder}} in id/category — bind slots before writing`,
        },
      };
    }
  }

  // A node that does not hold the store gates, then forwards (see gateThenForward). Placed after the
  // stateless gates above (metadata type, id, check-input, description) so those run here as well.
  if (process.env["GAP_STORE_ENDPOINT"]) return gateThenForward(pointer as Record<string, unknown>, incoming as unknown as Record<string, unknown>, audit);

  // TIMESTAMP PLACEHOLDER SCRUB. The gate above rejects uninterpolated {{slots}} in id/category
  // only — deliberately, since a legitimate summary may QUOTE a placeholder when describing an
  // interpolation bug. But that left every other field unguarded, and a template slot reached the
  // store verbatim: gap `ladder-rung-9-probe` persisted `created_at: "{{goal.created_at}}"`
  // (observed 2026-08-05). A timestamp that is template syntax is not a lenient value, it is an
  // unusable one — it silently breaks the gap-triple metrics, which sort and difference on these
  // fields, and a string that never parses reads as "no data" rather than as a bug.
  //
  // Scrub rather than reject: the binding failed for one field, not for the gap, and dropping an
  // otherwise-good gap would lose real signal. Falling back to the server clock is the same thing
  // an absent field already does, so an unbound slot now behaves exactly like the field not being
  // sent — which is the honest reading of "nothing was bound here".
  const unbound = (v: unknown): boolean => typeof v === "string" && /\{\{[^}]*\}\}/.test(v);
  const cleanTs = (v: unknown, fallback: string): string => (typeof v === "string" && v.length > 0 && !unbound(v) && !v.includes('{{') ? v : fallback);

  const gap: SubstrateGap = {
    ...incoming,
    status: incoming.status ?? "open",
    detected_at: cleanTs(incoming.detected_at, now),
    created_at: cleanTs(incoming.created_at, now),
    updated_at: now,
    ...(unbound(incoming.first_detected_at) ? { first_detected_at: undefined } : {}),
    ...(unbound(incoming.closed_at) ? { closed_at: undefined } : {}),
  };

  // Serialize the ENTIRE read-modify-write: load, dedup/gate decisions, lineage
  // stamping and save all run inside one critical section (see withGapLock), so
  // concurrent writers can neither share a tmp nor drop each other's gaps.
  // Load the vocabulary OUTSIDE the lock. `loadFleetShapeVocabulary` is a readdir +
  // readFile sweep of every vessel's config.ts; holding the gap-store lock across a
  // filesystem scan would serialise every gap writer in the fleet behind it.
  // (Cached with a TTL, so this is usually free — see cachedFleetVocabulary.)
  const vocabForClassify: ShapeVocabulary | null =
    opts?.vocabulary !== undefined ? opts.vocabulary : cachedFleetVocabulary();

  const demandGoalAppends: GoalReachDemandEntry[] = (() => {
    const raw = (pointer as { demand_goals_append?: unknown }).demand_goals_append;
    return Array.isArray(raw) ? raw.filter(isGoalReachEntry) : [];
  })();
  const outcome = await withGapLock(async (): Promise<
    | { early: ResolverResult }
    | { action: "created" | "updated"; summaryChanged: boolean; reopened: boolean; classKey: string; falsifier: FalsifierClass; unadvertisedShape?: string; unresolvableReason?: string; dedupeReason?: string; birthJob: { id: string; key: string; meta: Record<string, unknown> } | null }
  > => {
  const gaps = await loadGaps();
  // Dedup by gap CLASS (volatile-stripped id), not raw id, so timestamped
  // re-emissions of the same logical gap upsert onto one row instead of
  // accumulating. Exact-id match wins first (preserves explicit-id callers);
  // otherwise fall back to class match against a non-closed row.
  const classKey = gapClassKey(gap.id);
  let existingIdx = gaps.findIndex((g) => g.id === gap.id);
  audit.from = existingIdx >= 0 ? String(gaps[existingIdx]!.status ?? "open") : "absent";
  audit.stored = existingIdx >= 0 ? gaps[existingIdx]! : null;
  // PLACEHOLDER GATE, EVERY STATUS (see placeholderGate). Inside the lock because the exemption compares
  // against the stored row with this exact id.
  {
    const refused = placeholderGate(incoming as unknown as Record<string, unknown>, String(gap.id), String(gap.status), existingIdx >= 0 ? gaps[existingIdx] : undefined);
    if (refused) return { early: refused };
  }
  // CONDITIONAL WRITE (expect_status). A writer that read the row, awaited, and writes it back as
  // open would otherwise REOPEN a gap the sweep or verifier closed in between, and a reopen fires
  // the event-driven compose pickup below. Exact id only, checked inside the lock: no class match.
  const expectStatus = (pointer as { expect_status?: unknown }).expect_status;
  if (typeof expectStatus === "string") {
    const stored = existingIdx >= 0 ? String(gaps[existingIdx]!.status ?? "open") : null;
    if (stored !== expectStatus) {
      return {
        early: {
          // A no-op is not a success (2026-10-03): structuredError, so the route answers success:false.
          // The body keeps action/skip_reason/stored_status; callers branch on skip_reason.
          shape: "structuredError",
          body: {
            resolver: "substrateGap_write", failure_mode: "no_op",
            id: gap.id, action: "skipped", skip_reason: "status_precondition_failed", expected_status: expectStatus, stored_status: stored,
            detail: `gap ${gap.id}: nothing written — expect_status ${expectStatus} but the stored status is ${stored ?? "absent (no row with this id)"}`,
          },
        },
      };
    }
  }
  // Consumption gate (loop-economy): do not raise the growth rate when the
  // consumption side has no headroom (same inequality as the spectral-gap
  // governor). A NEW detector-sourced OPEN filing whose gap CLASS already
  // holds >= GAP_CLASS_OPEN_CAP open rows is refused honestly instead of
  // accumulating rows or churning updated_at. Exact-id updates, closes,
  // operator-filed gaps, and goal-host capability-gap escalations (kind
  // capability_gap — the walk's topology-expansion path) always pass.
  if (
    existingIdx < 0 &&
    gap.status === "open" &&
    (gap.source === "substrate_detected" || gap.source === "substrate_generative") &&
    (gap.classification_metadata as Record<string, unknown> | undefined)?.["kind"] !== "capability_gap"
  ) {
    const cap = Number(process.env["GAP_CLASS_OPEN_CAP"] ?? "3");
    const openInClass = gaps.filter((g) => hasClassifiableId(g) && g.status === "open" && gapClassKey(g.id) === classKey).length;
    if (openInClass >= cap) {
      console.log(`[gap-consumption-gate] refused open write: class=${classKey} open=${openInClass} cap=${cap} id=${gap.id}`);
      return {
        early: {
          shape: "structuredError",
          body: {
            resolver: "substrateGap_write",
            failure_mode: "consumption_gated",
            detail: `gap ${gap.id}: class "${classKey}" already has ${openInClass} open rows (cap ${cap}) — consumption-gated: class backlog un-drained`,
          },
        },
      };
    }
  }
  if (existingIdx < 0) {
    // hasClassifiableId FIRST: a row missing `status` passes `!== "closed"`, so
    // without this guard the id check never runs. That exact ordering is what
    // made one malformed row unwritable-store poison.
    existingIdx = gaps.findIndex((g) => hasClassifiableId(g) &&
      // A decomposition gap whose summary only repeats its parent is not a novel finding.
      // Reject it at write time to avoid storing redundant information.
      !(g.summary === incoming.summary && g.category === incoming.category && g.source === incoming.source) && g.status !== "closed" && gapClassKey(g.id) === classKey);
        if (existingIdx >= 0) {
          const existingGap = gaps[existingIdx];
          if (existingGap && existingGap.summary === incoming.summary && existingGap.category === incoming.category && existingGap.source === incoming.source) {
            return {
              early: {
                shape: 'structuredError',
                body: {
                  error: 'decomposition_gap_rejection',
                  message: 'A decomposition gap cannot repeat its parent.',
                },
              },
            };
          }
        }
  }
  // SAME DISPATCH, SAME GAP (see sameOriginDuplicateIdx): a new open row from a dispatch that already filed a
  // near-identical open gap lands on that row, and the result names it.
  const origin = writeOriginOf(pointer as Record<string, unknown>);
  let dedupeReason: string | undefined;
  if (existingIdx < 0 && gap.status === "open" && origin && typeof gap.summary === "string") {
    const dup = sameOriginDuplicateIdx(gaps, origin, gap.summary, Date.parse(now));
    if (dup >= 0) {
      dedupeReason = "deduplicated: same goal, near-identical summary";
      console.log(`[gap-audit] origin-deduplicated write gap=${gap.id} onto=${gaps[dup]!.id} origin=${origin} reason="${dedupeReason}"`);
      existingIdx = dup;
    }
  }

  // Close-if-open semantics: a close/reject write whose class has no existing row
  // is an honest no-op, not a create — lifecycle closers (e.g. goal-host closing
  // its auto_draft_decision rows on dispatch completion) would otherwise mint
  // closed rows for classes that were never opened, bloating the store.
  // REMOVED 2026-09-05 (operator): an unconditional env-gated early return that
  // swallowed EVERY gap write. Introduced by b705e54 as `!== undefined` — dormant,
  // since the var is unset in production — and inverted to `!` by 94b1efd
  // (autonomous, 21:15Z), at which point it fired on every call and
  // resolveSubstrateGapWrite became a silent no-op: HTTP 200, success:true,
  // action:"skipped", nothing written, for creates AND updates alike.
  //
  // Measured: gap creation ran 10-83 rows/hour for the preceding 21 hours (510
  // rows on 2026-09-05), stopped dead at 21:05:53, and produced ZERO rows over
  // the next two hours. Two controls run after the 23:03:25 vessel restart — one
  // new id, one already-existing id — both returned "skipped" and wrote nothing.
  //
  // Deleted rather than reverted to `!== undefined`. The semantic gate refused
  // the narrow revert twice on correct reasoning (2/2 adversarial refuters: "a
  // VIOLATING-LINE-ONLY fix ... the fundamental env-gating mechanism persists"),
  // and law 1 makes the whole block wrong regardless of polarity: behaviour must
  // not be gated behind a variable that traces and the walk cannot observe. The
  // variable keeps its ONE legitimate consumer at the `skipComposeTrigger` read
  // below, which is scoped to suppressing the gap-compose systemctl trigger in
  // tests. This block had hijacked that name for an unrelated total-write gate.
  //
  // Not touching the `false &&` predicate below: it was disabled by 915ce8a
  // (also autonomous, also unverified), so "minus `false &&`" is not known to be
  // the original, and changing it would be a second behavioural change.

  // If we're not supposed to trigger for *this* gap class, skip the whole op.
  // CLOSE-IF-OPEN, FOR EVERY WRITER (2026-10-01). A status change with no exact-id row and no open
  // row of its class is a no-op. This was gated on SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER === "1", a
  // test variable deciding production semantics, so in production such a write fell through to an
  // INSERT: a non-holder forwarding closes from a stale copy minted 90 closed rows that never existed.
  if (existingIdx >= 0) { audit.from = String(gaps[existingIdx]!.status ?? "open"); audit.stored = gaps[existingIdx]!; }
  if (existingIdx < 0 && gap.status !== "open") {
    return {
      early: {
        // A no-op is not a success (2026-10-03): see the expect_status branch above.
        shape: "structuredError",
        body: {
          resolver: "substrateGap_write", failure_mode: "no_op",
          id: gap.id, action: "skipped", skip_reason: "close_without_open_row", gap_class: classKey,
          detail: `gap ${gap.id}: nothing written — a ${String(gap.status)} write needs a stored row with this id or an open row of its class (${classKey}), and there is none`,
        },
      },
    };
  }

  let action: "created" | "updated";
      let summaryChanged = false;
      let reopened = false;
  // The stored row's metadata BEFORE this write: the birth stamp compares against it, never against
  // the incoming or merged copy (either can carry forward or forge a verdict).
  let priorMetaForBirth: Record<string, unknown> = {};
  // The stored row's status before this write, for the arm-time region gate ("absent" for a new row).
  let priorStatusForArm = "absent";
  if (existingIdx >= 0) {
    const existing = gaps[existingIdx]!;
    priorMetaForBirth = { ...((existing.classification_metadata ?? {}) as Record<string, unknown>) };
    priorStatusForArm = String(existing.status ?? "open");
    // operator_hold and close/reject evidence (see existingRowGates).
    const rowGate = existingRowGates(pointer, incoming as unknown as Record<string, unknown>, String(gap.id), String(gap.status ?? "open"), existing);
    if ("refused" in rowGate) return { early: rowGate.refused };
    const holdKeepsText = rowGate.holdKeepsText;
        summaryChanged = existing.summary !== gap.summary;
        // A closed->open transition is a REOPEN, and it is exactly when the gap wants
        // re-picking. Without this the trigger below fires only on a new gap or a changed
        // summary, so reopening one — after its landing was reverted, or after a human
        // says it is still broken — leaves it sitting open with nothing scheduled to look
        // at it. Observed today: gap-compose.timer is disabled and the picker is purely
        // event-driven, so a reopened gap simply never got picked up again.
        reopened = String(existing.status ?? "open") === "closed" && String(gap.status ?? "open") === "open";
    gap.id = existing.id;
    // BIRTH FIELDS ARE IMMUTABLE (2026-10-03). source, detected_at and first_detected_at say who filed the
    // gap and when; walk writes onto operator gaps dropped or rewrote source and restamped detected_at, and
    // goal-reach-tick attributes reaches by the stored source. The stored value wins whenever it is usable;
    // an absent (or unbound-slot) stored value may be filled. An attempt to change one is logged.
    const operatorMarker = operatorMarkerOf(pointer);
    {
      const usable = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !unbound(v);
      const inc = incoming as unknown as Record<string, unknown>;
      const tried: string[] = [];
      if (usable(existing.source)) {
        if (inc["source"] !== undefined && inc["source"] !== existing.source) tried.push(`source ${existing.source} -> ${String(inc["source"])}`);
        gap.source = existing.source;
      }
      if (usable(existing.detected_at)) {
        if (inc["detected_at"] !== undefined && inc["detected_at"] !== existing.detected_at) tried.push("detected_at");
        gap.detected_at = existing.detected_at;
      }
      if (usable(existing.first_detected_at) && inc["first_detected_at"] !== undefined && inc["first_detected_at"] !== existing.first_detected_at) tried.push("first_detected_at");
      if (tried.length > 0) console.log(`[substrate-gap] ${gap.id}: kept the stored birth fields; this write tried to change ${tried.join(", ")}`);
    }
    // A CLOSE DOES NOT REWRITE WHAT THE GAP SAYS (2026-10-03). The destructive combination observed was a
    // close or reject that also replaced the summary (with an echo of the closing goal) and the category.
    // Without the operator marker such a write keeps the stored summary and category; its own text is
    // kept beside them as classification_metadata.close_note. Open re-emissions still refresh the summary.
    let closeNote: string | undefined;
    if ((String(gap.status ?? "open") === "closed" || String(gap.status ?? "open") === "rejected") && !operatorMarker) {
      const kept: string[] = [];
      if (typeof existing.summary === "string" && existing.summary.trim().length > 0 && typeof gap.summary === "string" && gap.summary.trim().length > 0 && gap.summary !== existing.summary) {
        closeNote = gap.summary;
        gap.summary = existing.summary;
        kept.push("summary");
      }
      if (typeof existing.category === "string" && existing.category.length > 0 && gap.category !== existing.category) {
        if ((incoming as unknown as Record<string, unknown>)["category"] !== undefined) kept.push(`category (${String(gap.category)})`);
        gap.category = existing.category;
      }
      if (kept.length > 0) console.log(`[substrate-gap] ${gap.id}: a ${String(gap.status)} write without the operator marker kept the stored ${kept.join(" and ")}`);
    }
    // A HELD row keeps what it says and where it points (see the hold guard above).
    if (holdKeepsText) {
      if (typeof existing.summary === "string" && existing.summary.length > 0) gap.summary = existing.summary;
      if (typeof existing.category === "string" && existing.category.length > 0) gap.category = existing.category;
    }
    // Preserve the original creation time — but run it through the SAME scrub as an incoming
    // value. Restoring `existing.created_at` blind means a row poisoned before the scrub landed
    // can never heal: every subsequent write faithfully re-preserves the literal
    // "{{goal.created_at}}" it already holds. Observed on gap `ladder-rung-9-probe`, which
    // survived a full rewrite still carrying the placeholder. A self-healing store is the point
    // of scrubbing at the writer rather than at the reader.
    gap.created_at = cleanTs(existing.created_at, gap.created_at ?? now);
    // A COLLAPSING SUMMARY IS AN ECHO, NOT A REWRITE. The guard below this one catches only
    // an ABSENT summary. A closing or edit goal is generated as `Close substrate gap <id>:
    // <summary, truncated>`, and the writer echoes that goal text back as the new summary, so
    // the incoming value is a LEADING FRAGMENT of the text it destroys. Observed three times
    // on 2026-09-05 against operator gaps: 4781 chars -> 11, 4519 -> 62, 3300 -> 123, each a
    // case-insensitive prefix of what it replaced, taking the gap's falsifier and measurements
    // with it. Because this store REPLACES rather than merges, that erases the very evidence
    // by which a false closure could be detected.
    if (
      typeof gap.summary === "string" &&
      typeof existing.summary === "string" &&
      gap.summary.trim().length > 0 &&
      gap.summary.trim().length < existing.summary.trim().length &&
      existing.summary.trim().toLowerCase().startsWith(gap.summary.trim().toLowerCase())
    ) {
      gap.summary = existing.summary;
    }
    if (typeof gap.summary !== "string" || gap.summary.length === 0) gap.summary = existing.summary;
    if (gap.remedy === undefined) gap.remedy = existing.remedy;
    // Prevent a close or re-emit that carries no summary from blanking the stored
    // problem statement. The guard assigns the existing record's summary onto
    // gap.summary when the incoming summary is not a non-empty string (undefined,
    // empty string, or non-string).
    // Companion guard for remedy field: retain existing remedy when incoming write provides no value
    if (gap.remedy === undefined) gap.remedy = existing.remedy;
    if (typeof gap.summary !== "string" || gap.summary.length === 0) gap.summary = existing.summary;
    // PRESERVE the loop's learned failure-tracking across re-emissions. A detector
    // (e.g. surgical-gap-scan) re-emits the same logical gap every cycle with fresh
    // classification_metadata that carries NO failed_attempts; a blind overwrite wiped
    // the counter bumpFailedAttempts had accumulated, so a gap that repeatedly FAILS to
    // land AND is repeatedly RE-DETECTED never deprioritised — it monopolised gap-compose
    // and starved every other gap (0 lands). Carry these fields forward UNLESS the
    // incoming write explicitly sets them (bumpFailedAttempts DOES — its incremented value
    // must win to keep climbing).
    const exMeta = (existing.classification_metadata ?? {}) as Record<string, unknown>;
    const inMeta = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    // Captured BEFORE the carry-forward below copies the old row's keys in: a close reason
    // or attempt count carried from an earlier state is not something this write reports.
    const incomingClosedReason = inMeta["closed_reason"];
    const incomingFailedAttempts = inMeta["failed_attempts"];
    const incomingSetsDemandGoals = "demand_goals" in inMeta;
    // FALSIFIER-ANCHOR IMMUTABILITY: when the EXISTING row carries a measurable
    // falsifier (expected_literal / hardcoded_url) anchored at an edit_site, an
    // incoming write that does NOT itself rewrite those falsifier fields must not
    // re-aim the anchor. Observed 2026-09-09 (gap gate-self-probe-dispatcher-wiring):
    // the edit-intent route stamped its compose target file over the operator's
    // edit_site, redirecting the Class-1b predicate to a file NAMED the expected
    // literal, so the sweep closed the gap "already_resolved" 29 minutes before
    // the change the predicate was written to verify had landed on origin/dev.
    const incomingRewritesFalsifier = "expected_literal" in inMeta || "hardcoded_url" in inMeta;
    const existingHasFalsifierAnchor =
      (typeof exMeta["expected_literal"] === "string" || typeof exMeta["hardcoded_url"] === "string") &&
      typeof exMeta["edit_site"] === "string";
    if (existingHasFalsifierAnchor && !incomingRewritesFalsifier) {
      if ("edit_site" in inMeta) {
        inMeta["edit_site"] = exMeta["edit_site"];
      } else if (!("edit_site" in inMeta)) {
        inMeta["edit_site"] = exMeta["edit_site"];
      }
    }
    for (const k of Object.keys(exMeta)) {
      if (!(k in inMeta)) inMeta[k] = exMeta[k];
    }
    // demand_goals HAS TWO WRITERS (lib/demand-goals.ts). goal-host fileCapabilityGap rewrites the
    // whole array as strings only (its reader drops objects), so a plain key overwrite would erase
    // every goal_reach linkage entry on the next capability-gap re-emission. Carry those forward;
    // the writer's strings stay exactly as sent, so its demand_count and 2-goal floor are unchanged.
    if (incomingSetsDemandGoals) inMeta["demand_goals"] = carryGoalReachEntries(exMeta["demand_goals"], inMeta["demand_goals"]);
    for (const e of demandGoalAppends) inMeta["demand_goals"] = mergeDemandGoal(inMeta["demand_goals"], e);
    if (closeNote !== undefined) inMeta["close_note"] = closeNote.slice(0, 4000);
    if (holdKeepsText) {
      if ("edit_site" in exMeta) inMeta["edit_site"] = exMeta["edit_site"];
      else delete inMeta["edit_site"];
    }
    // AN OPEN ROW CARRIES NO CLOSURE EVIDENCE (2026-10-03). The carry-forward above copies the last close's
    // closed_reason / closed_by / landed_sha / falsifier_exercise into a reopened row, where a walk echoing
    // the row with status "closed" would pass close_needs_evidence on a verdict nobody produced for this
    // close. Cleared on every write whose resulting status is open (a reopen, or an open write echoing a
    // stale closed snapshot). No reader of an open row needs them (audited: isLiteralOnlyStepClose, the
    // step-replace check in gap-to-feature, the pending-land sweep, detector-yield-registry, goal-reach-tick
    // read them on closed rows or not at all); reopen_count records the earlier close.
    // A CLOSED VERDICT IS NOT REWRITTEN (2026-10-03). A write that keeps a row closed (or rejected) keeps the
    // stored verdict keys unless it carries the operator marker: no swapped closed_reason, no re-pointed
    // closed_by, no landed_sha added to a hollow close after the fact. The write itself proceeds.
    if (String(gap.status ?? "open") !== "open" && String(existing.status ?? "open") === String(gap.status) && !operatorMarker) {
      const kept: string[] = [];
      for (const k of CLOSURE_VERDICT_KEYS) {
        const had = k in exMeta;
        if (JSON.stringify(inMeta[k]) === JSON.stringify(exMeta[k])) continue;
        if (had) inMeta[k] = exMeta[k]; else delete inMeta[k];
        kept.push(k);
      }
      if (kept.length > 0) console.log(`[substrate-gap] ${gap.id}: a ${String(gap.status)} row keeps its verdict without the operator marker; ignored ${kept.join(", ")}`);
    }
    if (String(gap.status ?? "open") === "open") {
      const cleared = CLOSURE_EVIDENCE_KEYS.filter((k) => k in inMeta);
      for (const k of cleared) delete inMeta[k];
      if (cleared.length > 0) console.log(`[substrate-gap] ${gap.id}: open row, cleared closure evidence ${cleared.join(", ")}`);
    }
    gap.classification_metadata = inMeta;

    // L7 gap-triple lineage on the existing row (all backward-compatible):
    // first_detected_at anchors durability — never overwritten by a
    // re-emission's detected_at; seed from the oldest known detection.
    gap.first_detected_at = existing.first_detected_at ?? existing.detected_at ?? gap.detected_at;
    // Carry reopen_count forward; a recurrence (closed → re-detected open)
    // increments it so durability (does the fix hold?) is measurable.
    gap.reopen_count = existing.reopen_count ?? 0;
    // reopened_at is the store's own stamp, never the writer's: carried forward, set only on a reopen.
    if (existing.reopened_at) gap.reopened_at = existing.reopened_at; else delete gap.reopened_at;
    if (existing.status === "closed" && gap.status === "open") {
      gap.reopen_count = (existing.reopen_count ?? 0) + 1;
      gap.reopened_at = now;
    }
    // closed_at / closed_by_trace: stamp on the transition INTO closed (the
    // detection->close latency anchor), preserve while it stays closed, clear
    // once it is open again.
    if (gap.status === "closed") {
      gap.closed_at = existing.status === "closed" ? (existing.closed_at ?? now) : now;
      const trace = closedByTrace ?? existing.closed_by_trace;
      if (trace) gap.closed_by_trace = trace;
    } else {
      delete gap.closed_at;
      delete gap.closed_by_trace;
    }

    // EXPECTATION CALIBRATION CREDIT, AT THE HOLDER (value-per-cost-selection 5.5). A rise in
    // failed_attempts is a compose that did not land (bumpFailedAttempts); a transition into
    // closed with closed_reason landed_verified is a verified landing (closeLandedGap and the
    // pending-land sweep). Operator hand-closes carry no such reason and are not counted, per the
    // 2026-08-28 escalation-disposition ruling. Fail-open: accounting must never block a write.
    try {
      const calibCategory = String(gap.category ?? existing.category ?? "unknown");
      if (typeof incomingFailedAttempts === "number" && incomingFailedAttempts > Number(exMeta["failed_attempts"] ?? 0)) {
        creditExpectationCalibration(calibCategory, false);
      }
      if (gap.status === "closed" && existing.status !== "closed" && incomingClosedReason === "landed_verified") {
        creditExpectationCalibration(calibCategory, true);
      }
    } catch (err) {
      console.warn(`[expectation-calibration] credit skipped for ${gap.id}: ${String(err).slice(0, 200)}`);
    }
    gaps[existingIdx] = gap;
    action = "updated";
  } else {
    // Fresh row: this branch only runs for OPEN gaps (a close/reject without an
    // open row short-circuits above), so seed first_detected_at from the
    // detection time and leave close/reopen fields at their absent default.
    gap.first_detected_at = gap.first_detected_at ?? gap.detected_at;
    delete gap.reopened_at; // a new row has never been reopened, whatever the writer sent
    if (origin) gap.classification_metadata = { ...((gap.classification_metadata ?? {}) as Record<string, unknown>), origin_dispatch_id: origin };
    if (demandGoalAppends.length > 0) {
      const meta = { ...((gap.classification_metadata ?? {}) as Record<string, unknown>) };
      for (const e of demandGoalAppends) meta["demand_goals"] = mergeDemandGoal(meta["demand_goals"], e);
      gap.classification_metadata = meta;
    }
    gaps.push(gap);
    action = "created";
  }

  // A NEW DETECTOR ROW NOTHING CAN ARM (see the rule above): BEFORE the stamp, so a check built from its reading is
  // classified and birth-evaluated like any other arming. A row with no usable reading, or a throw (fail-open,
  // constraint A), is written as before and marked below.
  if (action === "created") {
    let contract: ReturnType<typeof detectorBirthContract> = null;
    try { contract = detectorBirthContract(gap as unknown as Record<string, unknown>, vocabForClassify); }
    catch (err) { console.error(`[gap-falsifier] detector contract threw for ${gap.id} (non-fatal, written as before):`, err); }
    if (contract && "evidence_resolve" in contract) {
      gap.classification_metadata = {
        ...((gap.classification_metadata ?? {}) as Record<string, unknown>),
        evidence_resolve: contract.evidence_resolve, evidence_resolve_from: DETECTOR_READING_FIELD, disposition: "needs_information",
      } as SubstrateGap["classification_metadata"];
    }
  }

  // ── FALSIFIER STAMP ──────────────────────────────────────────────────────────
  // AFTER the metadata merge above, deliberately. The carry-forward loop copies an
  // existing row's `evidence_resolve` into a re-emission that lacks one (detectors
  // re-emit with fresh, predicate-free metadata every cycle). Classifying the
  // INCOMING metadata would therefore stamp "none" onto a row that still holds a
  // perfectly usable predicate — the stamp would lie about exactly the population
  // it exists to count. Classifying the MERGED object also naturally overwrites a
  // stale `falsifier` carried forward from the existing row.
  //
  // The whole block is fail-open (constraint A outranks this feature): a throw here
  // leaves the gap unstamped and WRITTEN. A bug in the accounting must never be able
  // to block the substrate's detection loop.
  let falsifier: FalsifierClass = "none";
  let unadvertisedShape: string | undefined;
  let unresolvableReason: string | undefined;
  let birthJob: { id: string; key: string; meta: Record<string, unknown> } | null = null;
  try {
    const merged = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    const c = classifyFalsifier(merged, vocabForClassify);
    falsifier = c.falsifier;
    unadvertisedShape = c.unadvertised_shape;
    unresolvableReason = c.unresolvable_reason;
    // ADD BESIDE, NEVER REWRITE (constraint C). The writer's predicate — whatever it
    // said, however wrong the shape name — survives byte-identical. An "unresolvable"
    // verdict is a label on the data, not a correction of it; silently mutating a
    // caller's metadata is how the field-name mismatches in this store became
    // invisible in the first place.
    stampFalsifierClassification(merged, c);
    // BIRTH EVALUATION: decided here, run after the save (see applyBirthStamp).
    birthJob = applyBirthStamp(gap.id, String(gap.status ?? "open"), c.falsifier, merged, priorMetaForBirth, opts?.birthVerdict, now, opts?.detectedSha);
    gap.classification_metadata = merged;

    // BASELINE STAMPING LIVES ELSEWHERE, DELIBERATELY — DO NOT RE-ADD IT HERE.
    //
    // I briefly stamped a causal baseline onto classification_metadata at this point. It was
    // redundant and it was the wrong shape twice over. Redundant because gap-to-feature
    // already stamps one on every pick (thousands of environmentBaseline impulses exist, plus
    // falsifierBaseline rows for predicate-carrying gaps). Wrong shape because a baseline
    // belongs in its OWN impulse: substrateGap_write REPLACES rather than merges, so writing
    // durable evidence into a live gap risks erasing fields — a hazard this store has already
    // paid for repeatedly, and which causal-adjudication's own header calls out by name.
    //
    // The real missing link was never the baseline. It is the COMPARISON: baselines are
    // recorded faithfully and nothing ever reads them back to ask what changed.
  } catch (err) {
    console.error(`[gap-falsifier] classification threw for ${gap.id} (non-fatal, gap still written):`, err);
  }

  // A DETECTOR ROW NOTHING CAN ARM (see the rule above): a new row, or a row born so that is still unarmable, read from
  // the stamp (a classification that threw stamped nothing, and a row it did not stamp is not marked here). Written,
  // never refused, and the label stays as stamped ("none"): only the reason is set beside it. A NEW row armed from its
  // reading above is class2 here, and is not marked.
  if (action === "created" || String(priorMetaForBirth["falsifier_unresolvable_reason"] ?? "").startsWith(DETECTOR_ROW_UNARMABLE_REASON)) {
    const m = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    let why = typeof m["falsifier"] === "string" ? unarmableDetectorRow(gap as unknown as Record<string, unknown>, String(m["falsifier"])) : null;
    // Fail-open (constraint A): a route read that throws leaves the row unmarked, written as before.
    if (why) {
      try { const { routedOffCompose } = await import("../judge/gap-eligibility.js"); if (routedOffCompose(gap as unknown as Record<string, unknown>)) why = null; }
      catch (err) { why = null; console.error(`[gap-falsifier] route read threw for ${gap.id} (non-fatal, written unmarked):`, err); }
    }
    if (why) {
      unresolvableReason = DETECTOR_ROW_UNARMABLE_REASON + why;
      gap.classification_metadata = { ...m, falsifier_unresolvable_reason: unresolvableReason } as SubstrateGap["classification_metadata"];
      if (action === "created") {
        const src = String(gap.source);
        unarmableDetectorRows[src] = (unarmableDetectorRows[src] ?? 0) + 1;
        console.log(`[gap-falsifier] ${gap.id}: detector_row_unarmable source=${src}, written falsifier=none, marked unarmable (new unarmable rows from this source since start: ${unarmableDetectorRows[src]})`);
      }
    }
  }

  // ARM-TIME REGION GATE: after the stamp (arming is decided there), before the save. Outside the fail-open
  // block above on purpose: a throw here refuses the write, it never lets an unchecked arm through.
  {
    let refused: ResolverResult | null;
    try {
      refused = armRegionGate(String(gap.id), String(gap.status ?? "open"), (gap.classification_metadata ?? {}) as Record<string, unknown>, priorStatusForArm, priorMetaForBirth);
    } catch (err) {
      refused = { shape: "structuredError", body: { resolver: "substrateGap_write", failure_mode: "validation_rejected", error: "region_gate_error", id: gap.id,
        detail: `gap ${gap.id}: the arm-time region check threw (${String(err).slice(0, 200)}); refused rather than arm unchecked` } };
    }
    if (refused) return { early: refused };
  }

  // THE LANDING LEASE IS THE LEASE OP'S ALONE (see LANDING LEASE). A write that echoes a metadata snapshot
  // would otherwise re-plant a released lease or clobber a live one; the stored value is kept as stored.
  {
    const m = gap.classification_metadata as Record<string, unknown> | undefined;
    if ("landing_lease" in priorMetaForBirth) gap.classification_metadata = { ...(m ?? {}), landing_lease: priorMetaForBirth["landing_lease"] } as SubstrateGap["classification_metadata"];
    else if (m && "landing_lease" in m) { const c = { ...m }; delete c["landing_lease"]; gap.classification_metadata = c as SubstrateGap["classification_metadata"]; }
  }
  // The last release is the lease op's too: a write may neither forge nor erase it.
  {
    const m = gap.classification_metadata as Record<string, unknown> | undefined;
    if ("landing_last_release" in priorMetaForBirth) gap.classification_metadata = { ...(m ?? {}), landing_last_release: priorMetaForBirth["landing_last_release"] } as SubstrateGap["classification_metadata"];
    else if (m && "landing_last_release" in m) { const c = { ...m }; delete c["landing_last_release"]; gap.classification_metadata = c as SubstrateGap["classification_metadata"]; }
  }

  // What this save changes on the row (see GAP-WRITE EVENTS): the stored row before (audit.stored, null for a new
  // row; gaps[existingIdx] has already been replaced) against the row saved.
  const changed = gapFieldsChanged(audit.stored ?? null, gap);
  await saveGaps(gaps);
  audit.id = String(gap.id);
  audit.changed = changed;
  return { action, summaryChanged, reopened, classKey, falsifier, unadvertisedShape, unresolvableReason, dedupeReason, birthJob };
  });

  if ("early" in outcome) return outcome.early;
  const { action, summaryChanged, reopened, classKey, falsifier, unadvertisedShape, unresolvableReason, dedupeReason, birthJob } = outcome;
  if (birthJob) scheduleBirthEvaluation(birthJob, opts?.birthJudge ?? __birthJudgeOverride ?? defaultBirthJudge);
  // ONE LINE PER WRITE. A silent classification is worth nothing: this codebase has
  // repeatedly shipped mechanisms whose CONFIRMING case emitted no evidence, and a
  // mechanism that only speaks when it objects is indistinguishable from one that
  // never ran. Naming the unadvertised shape matters most — that literal is what an
  // escalation needs, and the drafter guessed `failurePatternReport` twice for want
  // of exactly this feedback.
  console.log(
    `[gap-falsifier] ${action} ${gap.id}: falsifier=${falsifier}` +
    (unadvertisedShape ? ` unadvertised_shape="${unadvertisedShape}" (predicate is INERT — it will resolve to nothing and the sweep will abstain forever)` : "") +
    (unresolvableReason ? ` reason="${unresolvableReason.slice(0, 200)}"` : ""),
  );
  // A check its response contract condemns is not birth-evaluated: say so where births are read (RESPONSE CONTRACTS).
  if (falsifier === "unresolvable" && (unresolvableReason ?? "").startsWith(RESPONSE_CONTRACT_REASON)) {
    console.log(`[gap-birth] ${gap.id}: class2 check not evaluated: falsifier unresolvable (${unresolvableReason!.slice(0, 240)}); held until it is re-armed`);
  }
  // This whole block has a REAL production side effect: it shells out to `systemctl
  // start gap-compose.service` against whatever systemd this process can reach, and
  // separately fetches this vessel's own HTTP surface to nudge an in-process compose.
  // Neither is mockable from the call site, so any test that writes an open gap
  // through this resolver — without this escape hatch — fires the unit for real.
  // Measured 2026-08-30: this resolver's own test file creates several open gaps per
  // run and is included in every full `bun test` pass, including the one compose's
  // own verify pipeline runs on every candidate fix — so every compose-triggered test
  // run could itself start another gap-compose.service tick, a self-sustaining loop
  // that plausibly explains chronic box saturation independent of any single caller's
  // request volume. SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER is set only by
  // substrate-gap.test.ts, before importing this module; unset (the default) in every
  // real deployment, so production behavior is unchanged.
  const skipComposeTrigger = process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] === "1";
  const nudgeCandidate = !skipComposeTrigger && (action === "created" || (action === "updated" && (summaryChanged || reopened))) && (gap.status ?? "open") === "open";
  // ELIGIBILITY FIRST, on the row this write just stored: the drain observer's predicate (gap-to-feature
  // composeEligibilitySkipReason, the picker's too). An unarmed, site-less or held gap is not compose work, so it
  // must not start the unit, nudge, or spend the throttle below. Skips are counted into the observer's per-window
  // summary, never logged per event. A predicate that throws refuses the nudge (fail closed, as the capacity check).
  let nudgeEligible = false;
  if (nudgeCandidate) {
    try {
      const { composeEligibilitySkipReason } = await import("../judge/gap-eligibility.js");
      const skip = composeEligibilitySkipReason(gap as unknown as Record<string, unknown>);
      if (skip === null) nudgeEligible = true;
      else {
        const { countComposeNudgeSkip } = await import("../services/gap-drain-observer.js");
        countComposeNudgeSkip(skip);
      }
    } catch (err) {
      console.warn(`[substrate-gap] compose nudge eligibility check failed; suppressing nudge: ${String(err)}`);
    }
  }
  if (nudgeEligible) {
    const g = globalThis as { __gapComposeLastTrigger?: number };
    const nowMs = Date.now();
    // SPEND ENVELOPE (value-per-cost-selection 4.2). The nudge starts gap-compose.service and an
    // in-process compose, so it obeys the same envelope as auto-pick: exhausted, paused or
    // unreadable means neither starts. The throttle is not stamped, so the next write re-asks
    // (the helper caches its read for 30 s).
    let nudgeEnvelope: { allow: boolean; reason: string } = { allow: true, reason: "" };
    if (!g.__gapComposeLastTrigger || nowMs - g.__gapComposeLastTrigger > 60_000) {
      try {
        const { spendEnvelopeAllows } = await import("../judge/gap-policy.js");
        nudgeEnvelope = await spendEnvelopeAllows();
      } catch (err) {
        nudgeEnvelope = { allow: false, reason: "envelope check failed: " + String(err) };
      }
      if (!nudgeEnvelope.allow) console.log(`[substrate-gap] gap-compose nudge NOT started for ${gap.id}: spend envelope ${nudgeEnvelope.reason}`);
    }
    if ((!g.__gapComposeLastTrigger || nowMs - g.__gapComposeLastTrigger > 60_000) && nudgeEnvelope.allow) {
      g.__gapComposeLastTrigger = nowMs;
      // START THE UNIT *AND* NUDGE THE COMPOSER DIRECTLY.
      //
      // The spawn alone accomplished nothing for two reasons, both measured:
      //   1. `systemctl start` on a MASKED unit fails, and this code discarded the
      //      exit status — so "pickup triggered" printed on every gap filed while the
      //      unit could not start at all. The log certified an outage as healthy.
      //   2. Even unmasked, the unit runs watchdog-tick, which returns "flow alive"
      //      unless its stall marker is >20min old. That marker is
      //      /workspace/proposals/compose-lessons.jsonl, which EVERY compose in the
      //      fleet appends to — so it is never stale and the drain never fires.
      //
      // The event path through GapDrainObserver does not save us either: it subscribes
      // to activity-api's websocket, which on a spoke is the HUB's — unreachable when
      // the hub is down, and silently so.
      //
      // So call the composer in-process, which needs no unit, no marker and no bus.
      // Guarded by the SAME globals the observer uses so the two entry points cannot
      // launch concurrent composes (the picker would select the same top gap twice).
      // GUARD THE UNIT START TOO.
      //
      // The comment directly above claims these entry points are "guarded by the
      // SAME globals ... so the two entry points cannot launch concurrent
      // composes". They were not: this spawn sat ABOVE the `__composeDrainInflight`
      // check, which therefore protected only the in-process nudge below it. The
      // systemd unit fired on every tick regardless of how many composes were
      // already running.
      //
      // With per-compose worktree isolation having removed the old refusal,
      // nothing bounded the outcome: measured 27 concurrent typecheck/test
      // processes at load 50.8 on 14 CPUs. The resolver now enforces a hard
      // capacity cap as well; this is the cheap half — not launching a unit whose
      // work will be refused saves the process and keeps the log honest.
      const gdPre = globalThis as unknown as { __composeDrainInflight?: boolean };
      const unitAlreadyBusy = gdPre.__composeDrainInflight === true;
      if (unitAlreadyBusy) {
        console.log(`[substrate-gap] gap-compose unit NOT started for ${gap.id} — a compose is already in flight`);
      }
      // `--no-block` IS LOAD-BEARING, NOT COSMETIC (2026-09-14). Without it `systemctl start`
      // waits for the unit to finish ACTIVATING, and gap-compose is a oneshot that runs an
      // entire compose — so this spawnSync froze the whole vessel's event loop for minutes on
      // EVERY gap write. Measured: /health served in 0.001s at process age 94s, then timed out
      // at 11s from age 103s through 218s — 115 seconds of total silence — while burning ~3ms
      // CPU per 3s with RSS flat at 202MB. Zero CPU + zero output + flat memory is a process
      // blocked in a syscall on a child, not a leak and not load. The last log line before 5 of
      // 5 such silences was the `[gap-falsifier]` line directly above this call.
      //
      // The cost compounded: a frozen vessel fails its health probe, self-recovery restarts it,
      // the in-flight compose dies, and that failure MINTS A CHILD GAP — which is another gap
      // write, which freezes it again. The store grew 7,323 -> 7,650 rows in one night (~327
      // freezes), during which 36 gap picks produced ZERO cutovers and every operator
      // substrateGap_write returned curl RC=52 (empty reply — the vessel died mid-request).
      //
      // `--no-block` makes systemctl enqueue the job and return, so this blocks for the
      // enqueue round-trip (milliseconds) instead of the compose. The nudge is still delivered:
      // the sibling call ~30 lines below already uses exactly this flag. Keep spawnSync so the
      // existing exitCode/stdout/stderr error handling below stays valid.
      const proc = unitAlreadyBusy
        ? null
        : Bun.spawnSync(["systemctl", "start", "--no-block", "gap-compose.service"], { stdout: "pipe", stderr: "pipe" });
      if (proc !== null && proc.exitCode !== 0) {
        console.error(`[substrate-gap] gap-compose failed to start (systemctl exit ${proc?.exitCode ?? 'unknown'})`);
        if (proc?.stdout) {
          console.error(`[substrate-gap] gap-compose stdout: ${proc.stdout.toString()}`);
        }
        if (proc?.stderr) {
          console.error(`[substrate-gap] gap-compose stderr: ${proc.stderr.toString()}`);
        }
      } else {
        console.log(`[substrate-gap] event-driven gap-compose pickup triggered by ${gap.id}${reopened ? ' (reopened)' : ''}`);
      }
      if (proc !== null && proc.exitCode !== 0) {
        console.error(`[substrate-gap] gap-compose failed to start (systemctl exit ${proc?.exitCode ?? 'unknown'})`);

        if (proc?.stdout) {
          console.error(`[substrate-gap] gap-compose stdout: ${proc.stdout.toString()}`);
        }
        if (proc?.stderr) {
          console.error(`[substrate-gap] gap-compose stderr: ${proc.stderr.toString()}`);
        }
      } else {
        console.log(`[substrate-gap] event-driven gap-compose pickup triggered by ${gap.id}${reopened ? ' (reopened)' : ''}`);
      }

      const gd = globalThis as unknown as { __composeDrainInflight?: boolean; __composeDrainLastAt?: number; lastComposeFailureClass?: string };
      const COMPOSE_MIN_INTERVAL_MS = 90_000;
      // Capacity guard: do not fire a compose nudge when the autonomous lane has no free slot.
      // FAIL-CLOSED: if the capacity check fails or returns an unreadable shape, assume no capacity.
      try {
        const { peekComposeCapacity, hasFreeComposeCapacity } = await import("../compose-slots.js");
        const __cap = await peekComposeCapacity({ directed: false, armed: true });
        // Null = capacity unobservable: this nudge FAILS CLOSED (no nudge), as before.
        var __autoHasFree = __cap !== null && hasFreeComposeCapacity(__cap);
        if (!__autoHasFree) {
          console.log(`[substrate-gap] compose nudge skipped for ${gap.id} — compose lane full`);
        }
      } catch (err) {
        console.warn(`[substrate-gap] compose capacity check failed; suppressing nudge to avoid churn: ${String(err)}`);
        __autoHasFree = false;
      }
      if (!__autoHasFree) { /* skip nudge: compose lane full */ } else if (gd.__composeDrainInflight === true) {
        console.log(`[substrate-gap] compose nudge skipped for ${gap.id} — a compose is already in flight`);
      } else if (typeof gd.__composeDrainLastAt === "number" && nowMs - gd.__composeDrainLastAt < COMPOSE_MIN_INTERVAL_MS) {
        const proc = Bun.spawn(["systemctl", "start", "--no-block", "gap-compose.service"], { stdout: "pipe", stderr: "pipe" });
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          const stderr = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
          console.error(`Failed to start gap-compose.service, exit code: ${exitCode}. Stderr: ${stderr}`);
          return {
            shape: "structuredError",
            body: {
              error: "gap_service_start_failed",
              message: `gap-compose.service failed to start, exit code: ${exitCode}`
            }
          };
        }

        console.log(`[substrate-gap] event-driven gap-compose pickup triggered by ${incoming.id}`);
        return { shape: 'compose_nudge_triggered', body: { gapId: gap.id } };
      } else {
        gd.__composeDrainInflight = true;
        gd.__composeDrainLastAt = nowMs;
        const selfUrl = process.env["DEV_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8090";
        const t0 = Date.now();
        // gap_to_feature is gated like a write at this vessel's own route (lib/caller-credential.ts): carry the node key.
        const selfResolve = `${selfUrl}/v2/impulses/resolve`;
        void fetch(selfResolve, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...selfAuthHeaders(selfResolve, selfResolve) },
          body: JSON.stringify({ impulse: { type: "gap_to_feature", triggered_by: "substrate-gap-write", flow: "gap-compose" } }),
          signal: AbortSignal.timeout(600_000),
        })
          .then((r) => console.log(`[substrate-gap] compose nudge for ${gap.id} finished http=${r.status} in ${Date.now() - t0}ms`))
          .catch((err) => console.warn(`[substrate-gap] compose nudge for ${gap.id} failed (non-fatal): ${String(err)}`))
          .finally(() => { gd.__composeDrainInflight = false; });
        console.log("[substrate-gap] event-driven gap-compose pickup triggered by " + gap.id + (reopened ? " (reopened)" : ""));
      }
    }
  }
  try {
    const { resolvePoolImpulseWrite } = await import("./pool-impulse.js");
    resolvePoolImpulseWrite({
      type: "poolImpulse_write",
      id: "gap:" + gap.id,
      shape: "substrateGap",
      body: { gap_id: gap.id, category: gap.category, route: gap.route, remedy: gap.remedy, summary: gap.summary },
      source: "substrate-gap-mirror",
      status: gap.status === "open" ? "open" : "retired",
    });
  } catch (err) {
    console.log("[substrate-gap-mirror] pool mirror failed (non-fatal):", err);
  }

  const publishRefused = isScratchGapStoreRoot(workspaceRoot()) && !gapEventPublishFromScratchAllowed;
  if (publishRefused && !gapEventPublishRefusalLogged) {
    gapEventPublishRefusalLogged = true;
    console.log(`[substrate-gap-event-publish] gap store ${workspaceRoot()} is a scratch root: devvessel.gap.written is not published from it`);
  }
  // AUTHENTICATED, OR NOT AT ALL (2026-10-07, harm-stop): this used to publish with only `X-Internal-Api-Key:
  // development-vessel`, a literal that activity-api checked for presence and never against a secret. The hub's
  // activity-api is reachable from the internet, so that header path let anyone post to the bus and the trace store,
  // and activity-api is removing it. Publish with this vessel's API key (read at use time; SUBSTRATE_API_KEY is the
  // rename alias); with no key, publish nothing and count it.
  const publishKey = process.env["SUBSTRATE_API_KEY"] || process.env["METABOB_API_KEY"] || process.env["API_KEY"] || "";
  if (!publishRefused && !publishKey) gapEventPublishNoKey += 1;
  if (!publishRefused && publishKey) try {
    const activityApiUrl = process.env["ACTIVITY_API_ENDPOINT"] ?? process.env["ACTIVITY_API_URL"] ?? "http://127.0.0.1:8080";
    const response = await fetch(`${activityApiUrl}/v2/events/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${publishKey}` },
      body: JSON.stringify({
        type: "devvessel.gap.written",
        source_vessel_id: "development-vessel",
        data: { gap_id: gap.id, category: gap.category, route: gap.route, remedy: gap.remedy, status: gap.status },
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      console.error(`[substrate-gap-event-publish] publish failed with status ${response.status}: ${responseBody}`);
    } else {
      console.log(`[substrate-gap-event-publish] publish successful: ${response.status}`);
    }
  } catch (err) {
    console.error(`[substrate-gap-event-publish] publish failed (non-fatal):`, err);
  }

  return {
    shape: "substrateGapWriteResult",
    body: {
      id: gap.id,
      action,
      gap_class: classKey,
      falsifier,
      ...(unadvertisedShape ? { falsifier_unadvertised_shape: unadvertisedShape } : {}),
      ...(unresolvableReason ? { falsifier_unresolvable_reason: unresolvableReason } : {}),
      ...(dedupeReason ? { reason: dedupeReason } : {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP-STORE MERGE (2026-10-22). When the gap store moves to another holder, the node whose store is left behind
// pushes its rows here (resolvers/gap-store-merge-migration.ts) and this holder merges them into its own store as a
// migration: by id, by the conflict rule in lib/gap-store-merge.ts (identical content is no conflict; else the newer
// updated_at wins, a tie or an unparseable timestamp goes to the holder; the loser is kept in the _previous ledger
// beside the store, gaps/_previous.jsonl, never dropped). No row is hand-edited and none passes through the write
// gates: these rows were already admitted by the store that held them, and re-gating them would re-stamp or refuse
// rows that are history, not new writes.
//
// BY EFFECT. The plan is checked before anything is written; then the losers are appended to _previous FIRST (so a
// loser is durable before its winner replaces it), the store is saved, and BOTH files are read back from disk and
// checked again (lib/gap-store-merge.ts verifyGapStoreMerge: the row count is before + added, every holder row keeps
// its place, and every input row is live or kept). A failed read-back restores the store's prior rows and answers
// merge_verification_failed. Each verified chunk appends one line (counts only) to gaps/gap-store-merges.jsonl.
//
// WHO MAY MERGE. A merge writes rows past every gate, so it is trust-root grade: this node's own key (node-self) or
// an identity-validated key with the admin scope, named by the route (impulses.ts) and never by the body. A merge
// that reaches a node that does not hold the store is refused, never relayed.
// ─────────────────────────────────────────────────────────────────────────────
export const GAP_STORE_MERGE_MAX_ROWS = 1000;
const GAP_PREVIOUS_PATH = () => join(workspaceRoot(), "gaps", "_previous.jsonl");
const GAP_STORE_MERGES_PATH = () => join(workspaceRoot(), "gaps", "gap-store-merges.jsonl");
/** The local store's file (gaps.json under this module's store root): the merge migration reads it on a forwarder. */
export function gapStoreFilePath(): string { return GAPS_PATH(); }
let __gapStoreMergeAfterSaveHook: (() => Promise<void>) | null = null;
/** Tests only: runs after the merge's save and before its read-back (a test overwrites the file to prove the check reads disk). */
export function __setGapStoreMergeAfterSaveHookForTests(fn: (() => Promise<void>) | null): void { __gapStoreMergeAfterSaveHook = fn; }

async function readKeptPreviousKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let text = "";
  try { text = await readFile(GAP_PREVIOUS_PATH(), "utf-8"); } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return keys;
    throw err;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { const e = JSON.parse(line) as { id?: unknown; content_hash?: unknown }; if (typeof e.id === "string" && typeof e.content_hash === "string") keys.add(`${e.id}:${e.content_hash}`); } catch { /* a torn last line is not a kept row */ }
  }
  return keys;
}

export type GapStoreMergePrincipal = { node_self?: boolean; admin?: boolean };
export async function resolveSubstrateGapMergeWrite(pointer: Record<string, unknown>, opts: { principal?: GapStoreMergePrincipal } = {}): Promise<ResolverResult> {
  const refuse = (failure_mode: string, detail: string, extra: Record<string, unknown> = {}): ResolverResult =>
    ({ shape: "structuredError", body: { resolver: "substrateGapMerge_write", failure_mode, detail, ...extra } }) as ResolverResult;
  if (!gapStoreIsLocal()) return refuse("not_the_holder", "this node does not hold the gap store (GAP_STORE_ENDPOINT is set): a merge is applied only by the holder, never relayed");
  const pr = opts.principal;
  if (!pr || (pr.node_self !== true && pr.admin !== true)) return refuse("merge_principal_required", "a gap-store merge writes past every gate: it needs this node's own key or an identity-validated admin key");
  const { planGapStoreMerge, verifyGapStoreMerge, isMergeableRow } = await import("../lib/gap-store-merge.js");
  const migrationId = pointer["migration_id"];
  const rows = pointer["rows"];
  if (typeof migrationId !== "string" || migrationId.length === 0 || migrationId.length > 200) return refuse("invalid_merge", "migration_id must be a non-empty string of at most 200 characters");
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > GAP_STORE_MERGE_MAX_ROWS) return refuse("invalid_merge", `rows must be an array of 1..${GAP_STORE_MERGE_MAX_ROWS} gap rows`);
  const bad = rows.findIndex((r) => !isMergeableRow(r));
  if (bad >= 0) return refuse("invalid_merge", `rows[${bad}] is not a gap row with a non-empty string id; nothing was merged`);
  const source = rows as Array<Record<string, unknown> & { id: string }>;
  const chunkIndex = typeof pointer["chunk_index"] === "number" ? pointer["chunk_index"] : null;
  const sourceLabel = typeof pointer["source_label"] === "string" ? String(pointer["source_label"]).replace(/[^\w:.@-]/g, "").slice(0, 64) : "";
  return withGapLock(async () => {
    const before = (await loadGaps()) as unknown as Array<Record<string, unknown> & { id: string }>;
    const keptBefore = await readKeptPreviousKeys();
    const plan = planGapStoreMerge(before, source, keptBefore);
    const keptPlanned = new Set(keptBefore);
    for (const p of plan.previous) keptPlanned.add(`${p.id}:${p.content_hash}`);
    const pre = verifyGapStoreMerge(before, source, plan.rows, keptPlanned);
    if (pre.length > 0) return refuse("merge_plan_inconsistent", "the merge plan failed its own check; nothing was written", { problems: pre.slice(0, 10) });
    const at = new Date().toISOString();
    if (plan.previous.length > 0) {
      await mkdir(dirname(GAP_PREVIOUS_PATH()), { recursive: true }).catch(() => undefined);
      appendFileSync(GAP_PREVIOUS_PATH(), plan.previous.map((p) => JSON.stringify({ ...p, migration_id: migrationId, source_label: sourceLabel, kept_at: at })).join("\n") + "\n");
    }
    const changed = plan.counts.added + plan.counts.source_won > 0;
    if (changed) await saveGaps(plan.rows as unknown as SubstrateGap[]);
    if (__gapStoreMergeAfterSaveHook) await __gapStoreMergeAfterSaveHook();
    const readBack = await loadGaps();
    const keptBack = await readKeptPreviousKeys();
    const post = verifyGapStoreMerge(before, source, readBack, keptBack);
    if (post.length > 0) {
      await saveGaps(before as unknown as SubstrateGap[]);
      console.error(`[gap-store-merge] ${migrationId} chunk=${String(chunkIndex)}: the store read back after the merge failed the check (${post.slice(0, 3).join("; ")}); the prior rows were restored`);
      return refuse("merge_verification_failed", "the store read back after the merge lost or moved rows; the prior rows were restored", { problems: post.slice(0, 10), restored: true });
    }
    const counts = { ...plan.counts, after: readBack.length, previous_kept: plan.previous.length };
    try { appendFileSync(GAP_STORE_MERGES_PATH(), JSON.stringify({ migration_id: migrationId, source_label: sourceLabel, chunk_index: chunkIndex, counts, at }) + "\n"); }
    catch (err) { console.error(`[gap-store-merge] ${migrationId}: ledger line NOT recorded (the merge itself is verified): ${String(err).slice(0, 200)}`); }
    console.log(`[gap-store-merge] ${migrationId} chunk=${String(chunkIndex)} verified: before=${counts.holder_before} added=${counts.added} identical=${counts.identical} holder_won=${counts.holder_won} source_won=${counts.source_won} kept=${counts.previous_kept} after=${counts.after}`);
    return { shape: "substrateGapMerge_write", body: { migration_id: migrationId, chunk_index: chunkIndex, verified: true, counts } } as ResolverResult;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP-WRITE QUEUE (2026-10-22). A forwarding node's gap write used to be lost whenever the holder was unreachable:
// gateThenForward failed closed with gap_store_unavailable and nothing kept the write. Across hosts a link drop does
// that to every gap the node files during the outage. Now such a write is kept on disk (lib/gap-forward-queue.ts:
// gaps/forward-queue/, one file per write, tmp + rename, bounded) and replayed, oldest first, when the holder
// answers again.
//
// WHAT IS QUEUED. Only a write whose principal is this node: one it makes itself, or one its route received with
// the node's own key (the pull-sync gate files that way). A caller with its own key is live and can retry with its
// own credential, which a queue must never hold. The caller still gets `failure_mode: gap_store_unavailable`, the
// value it already matches on, plus `queued: true` and the write id, or `queued: false` with a typed
// `queue_refused` (queue_full, entry_too_large, queue_unwritable, principal_not_this_node). Only a TRANSIENT failure
// queues: the holder unreachable, a timeout, or HTTP 502/503/504 (failure_mode gap_store_unreachable). A refusal
// (4xx, a gate, gap_store_cleartext_refused) never queues: replaying a decided answer cannot change it.
//
// ONCE, BY WRITE ID. gateThenForward mints a write id on a write's first attempt and sends it with every forward. The
// holder applies a write id once. It keeps the applied ids (gaps/applied-write-ids.jsonl, bounded) and answers a
// repeat with action duplicate_write_id, so a write the holder applied before its answer was lost is not applied
// again on replay. One known debt: the id is recorded just AFTER the write's save, so a holder crash between the two
// lets one replay apply it a second time (an upsert of the same content).
//
// REPLAY. At unit start (after the merge migration) and after any HTTP answer from the holder, one drain at a time
// replays the queue oldest first, through the full write path again, so the gates judge the holder's CURRENT row:
//   - an answer that is not an error removes the entry;
//   - a transient failure adds one attempt to the SAME entry and stops the drain, because the link is still down;
//     after GAP_FORWARD_QUEUE_MAX_ATTEMPTS the entry is dead-lettered as attempts_exhausted;
//   - any other answer dead-letters it as refused_on_replay:<rule>.
// While writes wait, a new queueable write waits behind them (FIFO), so a later write of a gap never overtakes an
// earlier one. A write from a caller with its own key is not queued and can still go ahead of queued writes: a named
// limit.
// ─────────────────────────────────────────────────────────────────────────────
const GAP_STORE_TRANSIENT_HTTP: ReadonlySet<number> = new Set([502, 503, 504]);
const GAP_WRITE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const GAP_FORWARD_QUEUE_MAX_ATTEMPTS = 50;
const gapForwardQueueDir = (): string => join(workspaceRoot(), "gaps", "forward-queue");
const gapWriteReplay = new AsyncLocalStorage<true>();
function gapWriteReplaying(): boolean { return gapWriteReplay.getStore() === true; }
/** Whether a failed forward of the current write may be queued: this node is its principal, and it is not a replay. */
function gapWriteIsQueueable(): boolean {
  if (gapWriteReplaying() || !gapForwardQueueEnabled()) return false;
  const call = currentCallCredential();
  if (call === null) return true;
  const nodeKey = process.env["METABOB_API_KEY"] ?? process.env["API_KEY"];
  const m = /^ApiKey\s+(\S+)$/i.exec(call);
  return !!nodeKey && !!m && m[1] === nodeKey;
}
function queueGapWrite(id: string, writeId: string, pointer: Record<string, unknown>, why: string): ResolverResult {
  const { _route_caller: _dropped, ...kept } = pointer;
  const q = enqueueGapWrite(gapForwardQueueDir(), writeId, kept);
  gapForwardQueueMayHaveEntries = true;
  if (q.queued) {
    console.warn(`[gap-forward-queue] ${id}: ${why}; queued for replay as write ${writeId}`);
    scheduleGapForwardDrain();
    return { shape: "structuredError", body: { resolver: "substrateGap_write", failure_mode: "gap_store_unavailable", queued: true, write_id: writeId, detail: `gap ${id}: not yet at the holder (${why}); kept on disk and replayed when the holder answers` } } as ResolverResult;
  }
  console.error(`[gap-forward-queue] ${id}: ${why}, and the write was NOT queued (${q.reason}: ${q.detail})`);
  return { shape: "structuredError", body: { resolver: "substrateGap_write", failure_mode: "gap_store_unavailable", queued: false, queue_refused: q.reason, write_id: writeId, detail: `gap ${id}: not forwarded (${why}) and not queued (${q.reason}: ${q.detail})` } } as ResolverResult;
}

let gapForwardQueueMayHaveEntries = true; // unknown until the first drain looks
let gapForwardDrain: Promise<GapForwardDrainResult> | null = null;
let gapForwardDrainScheduled = false;
export type GapForwardDrainResult = { replayed: number; dead: number; remaining: number; stopped: string | null };
function noteGapStoreHolderAnswered(): void {
  if (gapForwardQueueMayHaveEntries && !gapWriteReplaying() && gapForwardQueueEnabled()) scheduleGapForwardDrain();
}
// NOT FROM A SCRATCH STORE IN TESTS, unless a test opts in (the gap-written publish's rule, above): the suite runs many
// files in one process on one scratch root, and a write one file queued against its down holder would otherwise
// replay into the next file's holder. The deployed store root is never a scratch root.
let gapForwardQueueFromScratchAllowed = false;
function gapForwardQueueEnabled(): boolean { return gapForwardQueueFromScratchAllowed || !isScratchGapStoreRoot(workspaceRoot()); }
/** Tests only: let the forward queue run from a scratch store root. */
export function __allowGapForwardQueueFromScratchForTests(on: boolean): void { gapForwardQueueFromScratchAllowed = on; }
// HELD WHILE THE MERGE MIGRATION RUNS (resolvers/gap-store-merge-migration.ts). Every merge chunk is an HTTP answer
// from the holder, which would otherwise start a drain between chunks. A queued write of gap X replayed before the
// merge delivers the old store's row X makes the holder create X from that write alone, newer than the old row, so the
// row with X's history (arming, falsifier, close evidence) would lose the conflict and end up only in _previous.
// After the merge, the write lands on the merged row and the write path carries that history forward.
let gapForwardDrainHolds = 0;
/** Hold queue drains until the returned release is called (the merge migration holds them for its whole run). */
export function holdGapForwardDrains(): () => void {
  gapForwardDrainHolds++;
  let released = false;
  return () => { if (!released) { released = true; gapForwardDrainHolds--; } };
}
function scheduleGapForwardDrain(): void {
  if (gapForwardDrainScheduled || gapWriteReplaying() || gapForwardDrainHolds > 0) return;
  gapForwardDrainScheduled = true;
  setTimeout(() => { gapForwardDrainScheduled = false; void drainGapForwardQueue().catch((err) => console.error(`[gap-forward-queue] drain failed: ${String(err).slice(0, 200)}`)); }, 0);
}
/** Replay the queue, oldest first, one drain at a time (a call while one runs joins it). */
export function drainGapForwardQueue(): Promise<GapForwardDrainResult> {
  if (gapForwardDrain) return gapForwardDrain;
  const run = runWithoutCallCredential(() => gapWriteReplay.run(true, async (): Promise<GapForwardDrainResult> => {
    const dir = gapForwardQueueDir();
    const out: GapForwardDrainResult = { replayed: 0, dead: 0, remaining: 0, stopped: null };
    if (!gapForwardQueueEnabled()) return out;
    if (gapForwardDrainHolds > 0) { out.remaining = queuedFiles(dir).length; out.stopped = "held while the gap-store merge migration runs"; return out; }
    if (gapStoreIsLocal()) { out.remaining = queuedFiles(dir).length; out.stopped = out.remaining > 0 ? "this node holds the store" : null; return out; }
    for (const file of queuedFiles(dir)) {
      const entry = readQueued(dir, file);
      if (!entry) { deadLetterQueued(dir, file, null, "unreadable_entry"); out.dead++; continue; }
      const r = await resolveSubstrateGapWrite(structuredClone(entry.pointer));
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (r.shape !== "structuredError") { removeQueued(dir, file); out.replayed++; continue; }
      if (b["failure_mode"] === "gap_store_unreachable" || b["transient"] === true) {
        const next = bumpQueuedAttempt(dir, file, entry, String(b["detail"] ?? "transient"));
        if (next.attempts >= GAP_FORWARD_QUEUE_MAX_ATTEMPTS) { deadLetterQueued(dir, file, next, "attempts_exhausted"); out.dead++; continue; }
        out.stopped = "the holder is still unreachable";
        break;
      }
      deadLetterQueued(dir, file, entry, `refused_on_replay:${String(b["rule"] ?? b["failure_mode"] ?? b["error"] ?? "error")}`);
      console.error(`[gap-forward-queue] write ${entry.write_id} refused on replay (${String(b["rule"] ?? b["failure_mode"] ?? "error")}); dead-lettered`);
      out.dead++;
    }
    out.remaining = queuedFiles(dir).length;
    gapForwardQueueMayHaveEntries = out.remaining > 0;
    if (out.replayed + out.dead > 0) console.log(`[gap-forward-queue] drain: replayed=${out.replayed} dead=${out.dead} remaining=${out.remaining}${out.stopped ? ` (${out.stopped})` : ""}`);
    return out;
  }));
  gapForwardDrain = run;
  // Writes queued while this drain ran are picked up by the next one, unless the holder is still away.
  void run.then((o) => { if (gapForwardDrain === run) gapForwardDrain = null; if (o.remaining > 0 && !o.stopped) scheduleGapForwardDrain(); },
    () => { if (gapForwardDrain === run) gapForwardDrain = null; });
  return run;
}

// THE HOLDER APPLIES A WRITE ID ONCE (see GAP-WRITE QUEUE). In memory from first use, appended per applied write,
// rewritten (tmp + rename) to the newest GAP_APPLIED_WRITE_IDS_MAX when it holds twice that many.
const GAP_APPLIED_WRITE_IDS_MAX = 20_000;
const GAP_APPLIED_WRITE_IDS_PATH = () => join(workspaceRoot(), "gaps", "applied-write-ids.jsonl");
let gapAppliedWriteIds: Map<string, string> | null = null;
let gapAppliedWriteIdLines = 0;
const gapWritesInFlight = new Map<string, Promise<ResolverResult>>();
function appliedWriteIds(): Map<string, string> {
  if (gapAppliedWriteIds) return gapAppliedWriteIds;
  const m = new Map<string, string>();
  let lines = 0;
  try {
    for (const line of readFileSync(GAP_APPLIED_WRITE_IDS_PATH(), "utf-8").split("\n")) {
      if (!line) continue;
      lines++;
      try { const e = JSON.parse(line) as { w?: unknown; g?: unknown }; if (typeof e.w === "string") { m.delete(e.w); m.set(e.w, String(e.g ?? "")); } } catch { /* a torn line */ }
    }
  } catch (err) { if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") console.error(`[gap-write-id] applied ids unreadable (a repeat may apply again): ${String(err).slice(0, 200)}`); }
  gapAppliedWriteIds = m;
  gapAppliedWriteIdLines = lines;
  return m;
}
function recordAppliedWriteId(writeId: string, gapId: string): void {
  const m = appliedWriteIds();
  m.delete(writeId); m.set(writeId, gapId);
  try {
    mkdirSync(dirname(GAP_APPLIED_WRITE_IDS_PATH()), { recursive: true });
    appendFileSync(GAP_APPLIED_WRITE_IDS_PATH(), JSON.stringify({ w: writeId, g: gapId }) + "\n");
    gapAppliedWriteIdLines++;
    if (gapAppliedWriteIdLines > 2 * GAP_APPLIED_WRITE_IDS_MAX) {
      while (m.size > GAP_APPLIED_WRITE_IDS_MAX) { const oldest = m.keys().next().value; if (oldest === undefined) break; m.delete(oldest); }
      const tmp = `${GAP_APPLIED_WRITE_IDS_PATH()}.${process.pid}.tmp`;
      writeFileSync(tmp, [...m].map(([w, g]) => JSON.stringify({ w, g })).join("\n") + "\n");
      renameSync(tmp, GAP_APPLIED_WRITE_IDS_PATH());
      gapAppliedWriteIdLines = m.size;
    }
  } catch (err) { console.error(`[gap-write-id] applied id ${writeId} NOT recorded (a repeat may apply again): ${String(err).slice(0, 200)}`); }
}
/** On the holder: run `apply` for a write id at most once (a repeat answers duplicate_write_id; a concurrent one joins). */
async function applyWriteOnce(pointer: unknown, audit: GapWriteAudit, apply: () => Promise<ResolverResult>): Promise<ResolverResult> {
  const wid = (pointer as { write_id?: unknown } | null)?.write_id;
  if (!gapStoreIsLocal() || typeof wid !== "string" || !GAP_WRITE_ID_RE.test(wid)) return apply();
  const prior = appliedWriteIds().get(wid);
  if (prior !== undefined) { audit.changed = []; return { shape: "substrateGapWriteResult", body: { id: prior, action: "duplicate_write_id", write_id: wid } } as ResolverResult; }
  const running = gapWritesInFlight.get(wid);
  if (running) { audit.changed = []; return running; }
  const p = apply();
  gapWritesInFlight.set(wid, p);
  try {
    const r = await p;
    if (r.shape !== "structuredError") recordAppliedWriteId(wid, String((r.body as { id?: unknown } | undefined)?.id ?? ""));
    return r;
  } finally { gapWritesInFlight.delete(wid); }
}
/** Tests only: forget the in-memory applied ids (the file is re-read on next use). */
export function __resetAppliedWriteIdsForTests(): void { gapAppliedWriteIds = null; gapAppliedWriteIdLines = 0; gapWritesInFlight.clear(); }
