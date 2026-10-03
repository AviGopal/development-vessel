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
import type { ResolverResult } from "./types.js";
import { onlyTestsProblem } from "./test-suite.js";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { carryGoalReachEntries, isGoalReachEntry, mergeDemandGoal, type GoalReachDemandEntry } from "../lib/demand-goals.js";

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

async function forwardToGapStore(pointer: Record<string, unknown>): Promise<ResolverResult | null> {
  const ep = process.env["GAP_STORE_ENDPOINT"];
  if (!ep) return null;
  const key = process.env["METABOB_API_KEY"] ?? process.env["API_KEY"];
  try {
    const r = await fetch(ep, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) }, body: JSON.stringify({ impulse: { pointer } }), signal: AbortSignal.timeout(15_000) });
    const j = await r.json() as { shape?: string; body?: unknown };
    return { shape: String(j.shape ?? "structuredError"), body: j.body ?? { detail: `gap store at ${ep} answered HTTP ${r.status}` } } as ResolverResult;
  } catch (e) {
    return { shape: "structuredError", body: { resolver: "substrateGap", detail: `gap store at ${ep} unreachable: ${(e as Error).message}` } } as ResolverResult;
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
function readFromCorrectWorkspace(path: string): string {
  // Ensure we read from the live workspace, not a stale one
  const liveRoot = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
  return path.replace(DEFAULT_WORKSPACE_ROOT, liveRoot);
}

/**
 * Determines if a predicate literal is already present, and whether its presence
 * indicates a state of 'armed' or 'unarmed' for gap resolution.
 *
 * This function addresses four issues identified in the substrate gap:
 * 1. INVERT THE DECISION: It returns `true` if the literal is present and should
 *    prevent arming (i.e., indicates the fix is already in place, or a defect is present).
 *    For `expected_literal`, `true` means the literal is present and a gap should NOT be armed.
 *    For `expected_literal`, `true` means the literal is already present (count > 0) and thus should NOT be armed.
 *    For `hardcoded_url`, `true` means the literal is *absent* (count === 0) and thus should NOT be armed.2. READ THE SAME TREE THE PREDICATE READS: Uses `runtimeRoot()` for path resolution to align
 *    arming with evaluation.
 * 3. COUNT LITERALLY, NOT BY REGEX: Counts occurrences using string `indexOf` to avoid regex
 *    metacharacter issues.
 * 4. HONOUR THE NAME: For `expected_literal`, a non-zero count (meaning already present) will refuse arming.
 *    For `hardcoded_url`, a zero count (meaning absent) will refuse arming.
 *
 * @param literal The string literal to search for.
 * @param filePath The file path relative to the runtime root.
 * @param detectDefect If true, `true` means a defect (e.g., `hardcoded_url` is present). If false (default),
 *                     `true` means the fix is present (e.g., `expected_literal` is present).
 * @returns `true` if the condition for refusal (or defect detection) is met, `false` otherwise.
 */
function predicateLiteralNotUnique(literal: unknown, filePath: unknown, detectDefect = false): boolean {
  if (typeof filePath === 'string') {
    filePath = readFromCorrectWorkspace(filePath);
  }
  if (typeof literal !== 'string' || typeof filePath !== 'string') return false;
  const runtimePath = filePath.replace(/^repos\//, "");

  try {
    const content = readFileSync(join(workspaceRoot(), runtimePath), 'utf8');
    let count = 0;
    let lastIndex = 0;
    while ((lastIndex = content.indexOf(literal, lastIndex)) !== -1) {
      count++;
      lastIndex += literal.length;
    }

    if (detectDefect) {
      // For `hardcoded_url`, absence (count === 0) means it's not a defect *yet*.
      // We refuse to arm if the URL is *absent* (count === 0), as the gap describes something to remove.
      return count === 0;
    } else {
      // For `expected_literal`, presence (count > 0) means the literal is already there.
      // We refuse to arm if the literal is *present* (count > 0), as the gap describes something to add.
      return count > 0;
    }
  } catch {
    return false;
  }
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
  try {
    const raw = await readFile(GAPS_PATH(), "utf-8");
    const parsed = JSON.parse(raw) as SubstrateGap[];
    if (!Array.isArray(parsed)) throw new Error("gaps.json did not parse to an array - refusing to treat as empty");
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // If the file doesn't exist, this is an empty store, not an error.
      return [];
    }
    // For any other error (parse error, permissions, etc.), treat as an unrecoverable failure.
    throw new Error("gaps.json could not be loaded or parsed - refusing to treat as empty: " + (err as Error).message);
  }
}

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
   * Why an "unresolvable" verdict was reached when it is NOT an unadvertised shape — today
   * only the Class-1-without-edit-site case. An escalation that cannot say WHY a predicate
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
  if (usablePredicateString(m["expected_literal"])) {
    if (predicateLiteralNotUnique(m["expected_literal"], m["edit_site"] ?? m["file_path"])) return { falsifier: "unresolvable" };
    if (m["edit_site"] || m["file_path"]) return { falsifier: "class1", predicate_position: "expected_literal" };
    return { falsifier: "unresolvable" };
  }
  if (usablePredicateString(m["hardcoded_url"])) {
    if (predicateLiteralNotUnique(m["hardcoded_url"], m["edit_site"] ?? m["file_path"], true)) return { falsifier: "unresolvable" };
    const editSite = usablePredicateString(m["edit_site"]) ?? usablePredicateString(m["file_path"]);
        if (!editSite || !existsSync(join(workspaceRoot(), readFromCorrectWorkspace(editSite).replace(/^repos\//, "")))) {

      return {
        falsifier: "unresolvable",
        predicate_position: "hardcoded_url",
        unresolvable_reason: "hardcoded_url without edit_site/file_path — verifyGapCondition never enters the Class-1 branch",
        classified_at: at,
      };
    }
    return { falsifier: "class1", predicate_position: "hardcoded_url", classified_at: at };
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

  const vocab = vocabulary === undefined ? cachedFleetVocabulary() : vocabulary;
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
// same judge on the same predicate, and honoured only when its key equals the merged predicate's.
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
export type BirthJudge = (gap: Record<string, unknown>) => Promise<string>;
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
function birthCheckRepo(meta: Record<string, unknown>): { dir: string; files: string[] } | null {
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

async function defaultBirthJudge(gap: Record<string, unknown>): Promise<string> {
  const { evaluateGapCheck } = await import("./gap-to-feature.js");
  return evaluateGapCheck(gap);
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
        (verdict === "present" ? "" : moved ? ` — absent, but the tree moved (${tree!.reason}): unknown, not suspect` : " — predicate_suspect: not admissible, and its absent closes nothing" + (tree ? ` [${tree.reason}]` : "")) +
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
  trusted: { predicate_key: string; verdict: "present" | "absent" | "unknown" } | undefined,
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
  if (trusted && trusted.predicate_key === key) {
    merged["predicate_birth_key"] = key;
    merged["predicate_birth_verdict"] = trusted.verdict;
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
  const gaps = await loadGaps();
  const limit = pointer.limit ?? 50;

  let results = gaps;

  if (pointer.id) {
    results = results.filter((g) => g.id === pointer.id);
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

  results = results
    .sort((a, b) => (b.updated_at || b.created_at || b.detected_at || "").localeCompare(a.updated_at || a.created_at || a.detected_at || ""))
    .slice(0, limit);

  return {
    shape: "substrateGap",
    body: {
      gaps: results,
      total: results.length,
      // ADDITIVE. Existing consumers read `gaps`/`total` only. This is the census
      // over the WHOLE open store (not the filtered/limited page) so that
      // "how many open gaps can never close?" is answerable from any read instead
      // of by hand-grepping the store file.
      falsifier_coverage: falsifierCoverage(gaps),
      ...(pointer.include_calibration ? { expectation_calibration: readExpectationCalibration() } : {}),
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
export function unrenderedBindingToken(s: string): string | null {
  for (const m of s.matchAll(TEMPLATE_TOKEN)) {
    const i = m.index ?? 0;
    const end = i + m[0].length;
    if (s[i - 1] === "`" && s[end] === "`") continue;
    if (s[i - 1] === "=" || JSX_OBJECT_LITERAL.test(m[1] ?? "")) continue;
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
async function gateThenForward(pointer: Record<string, unknown>, incoming: Record<string, unknown>): Promise<ResolverResult> {
  const id = String(incoming["id"]);
  const status = String(incoming["status"] ?? "open");
  const read = await forwardToGapStore({ type: "substrateGap", id, limit: 5 });
  const rows = (read?.body as { gaps?: unknown } | undefined)?.gaps;
  if (!read || read.shape !== "substrateGap" || !Array.isArray(rows)) {
    console.warn(`[substrate-gap] NOT forwarded ${id}: the gap-store holder could not be read, so the write gates cannot be applied`);
    return {
      shape: "structuredError",
      body: {
        resolver: "substrateGap_write",
        failure_mode: "gap_store_unavailable",
        detail: `gap ${id}: not forwarded — the gap-store holder could not be read (${JSON.stringify(read?.body ?? null).slice(0, 200)}), so the write gates cannot be applied`,
      },
    } as ResolverResult;
  }
  const stored = (rows as SubstrateGap[]).find((g) => g && g.id === id);
  const ph = placeholderGate(incoming, id, status, stored);
  if (ph) return ph;
  if (stored) {
    const rg = existingRowGates(pointer, incoming, id, status, stored);
    if ("refused" in rg) return rg.refused;
  }
  return (await forwardToGapStore(pointer))!;
}

export async function resolveSubstrateGapWrite(
  pointer: SubstrateGapWritePointer | Record<string, unknown>,
  // Additive, test-facing: inject a vocabulary rather than depending on the host's
  // filesystem layout. No production caller passes it (the cached fleet scan is used).
  opts?: {
    vocabulary?: ShapeVocabulary | null,
    anchorNotFoundHandler?: (error: Error) => void,
    /** In-process only: a verdict the caller just took with the same judge on this exact class-2 check (see BIRTH EVALUATION). */
    birthVerdict?: { predicate_key: string; verdict: "present" | "absent" | "unknown" },
    /** Tests only: the judge for this write's birth evaluation. */
    birthJudge?: BirthJudge,
    /** In-process only: the commit the writer detected the defect against (see WHICH TREE). */
    detectedSha?: string,
  },
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
  if (process.env["GAP_STORE_ENDPOINT"]) return gateThenForward(pointer as Record<string, unknown>, incoming as unknown as Record<string, unknown>);

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
    | { action: "created" | "updated"; summaryChanged: boolean; reopened: boolean; classKey: string; falsifier: FalsifierClass; unadvertisedShape?: string; birthJob: { id: string; key: string; meta: Record<string, unknown> } | null }
  > => {
  const gaps = await loadGaps();
  // Dedup by gap CLASS (volatile-stripped id), not raw id, so timestamped
  // re-emissions of the same logical gap upsert onto one row instead of
  // accumulating. Exact-id match wins first (preserves explicit-id callers);
  // otherwise fall back to class match against a non-closed row.
  const classKey = gapClassKey(gap.id);
  let existingIdx = gaps.findIndex((g) => g.id === gap.id);
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
  if (existingIdx >= 0) {
    const existing = gaps[existingIdx]!;
    priorMetaForBirth = { ...((existing.classification_metadata ?? {}) as Record<string, unknown>) };
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
    if (existing.status === "closed" && gap.status === "open") {
      gap.reopen_count = (existing.reopen_count ?? 0) + 1;
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
    if (demandGoalAppends.length > 0) {
      const meta = { ...((gap.classification_metadata ?? {}) as Record<string, unknown>) };
      for (const e of demandGoalAppends) meta["demand_goals"] = mergeDemandGoal(meta["demand_goals"], e);
      gap.classification_metadata = meta;
    }
    gaps.push(gap);
    action = "created";
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
  let birthJob: { id: string; key: string; meta: Record<string, unknown> } | null = null;
  try {
    const merged = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    const c = classifyFalsifier(merged, vocabForClassify);
    falsifier = c.falsifier;
    unadvertisedShape = c.unadvertised_shape;
    // ADD BESIDE, NEVER REWRITE (constraint C). The writer's predicate — whatever it
    // said, however wrong the shape name — survives byte-identical. An "unresolvable"
    // verdict is a label on the data, not a correction of it; silently mutating a
    // caller's metadata is how the field-name mismatches in this store became
    // invisible in the first place.
    merged["falsifier"] = c.falsifier;
    if (c.predicate_position) merged["falsifier_position"] = c.predicate_position;
    else delete merged["falsifier_position"];
    if (c.unadvertised_shape) merged["falsifier_unadvertised_shape"] = c.unadvertised_shape;
    else delete merged["falsifier_unadvertised_shape"];  // clear a stale accusation carried from the old row
    merged["falsifier_classified_at"] = c.classified_at;
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

  await saveGaps(gaps);
  return { action, summaryChanged, reopened, classKey, falsifier, unadvertisedShape, birthJob };
  });

  if ("early" in outcome) return outcome.early;
  const { action, summaryChanged, reopened, classKey, falsifier, unadvertisedShape, birthJob } = outcome;
  if (birthJob) scheduleBirthEvaluation(birthJob, opts?.birthJudge ?? __birthJudgeOverride ?? defaultBirthJudge);
  // ONE LINE PER WRITE. A silent classification is worth nothing: this codebase has
  // repeatedly shipped mechanisms whose CONFIRMING case emitted no evidence, and a
  // mechanism that only speaks when it objects is indistinguishable from one that
  // never ran. Naming the unadvertised shape matters most — that literal is what an
  // escalation needs, and the drafter guessed `failurePatternReport` twice for want
  // of exactly this feedback.
  console.log(
    `[gap-falsifier] ${action} ${gap.id}: falsifier=${falsifier}` +
    (unadvertisedShape ? ` unadvertised_shape="${unadvertisedShape}" (predicate is INERT — it will resolve to nothing and the sweep will abstain forever)` : ""),
  );
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
  if (!skipComposeTrigger && (action === "created" || (action === "updated" && (summaryChanged || reopened))) && (gap.status ?? "open") === "open") {
    const g = globalThis as { __gapComposeLastTrigger?: number };
    const nowMs = Date.now();
    // SPEND ENVELOPE (value-per-cost-selection 4.2). The nudge starts gap-compose.service and an
    // in-process compose, so it obeys the same envelope as auto-pick: exhausted, paused or
    // unreadable means neither starts. The throttle is not stamped, so the next write re-asks
    // (the helper caches its read for 30 s).
    let nudgeEnvelope: { allow: boolean; reason: string } = { allow: true, reason: "" };
    if (!g.__gapComposeLastTrigger || nowMs - g.__gapComposeLastTrigger > 60_000) {
      try {
        const { spendEnvelopeAllows } = await import("./gap-to-feature.js");
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
        const { peekComposeCapacity } = await import("../compose-slots.js");
        const __cap = await peekComposeCapacity({ directed: false });
        var __autoHasFree = (() => {
          const c = __cap as unknown as {
            autonomous_free?: boolean;
            free?: boolean;
            autonomousFree?: boolean;
            available?: boolean;
            autonomousAvailable?: boolean;
            observed?: number;
            cap?: number;
          } | null | undefined;
          if (!c || typeof c !== "object") return false;
          if (typeof c.autonomous_free === "boolean") return c.autonomous_free;
          if (typeof c.autonomousFree === "boolean") return c.autonomousFree;
          if (typeof c.autonomousAvailable === "boolean") return c.autonomousAvailable;
          if (typeof c.free === "boolean") return c.free; // some impls expose a single free flag
          if (typeof c.available === "boolean") return c.available;
          if (typeof c.observed === "number" && typeof c.cap === "number") {
            const capNum = c.cap;
            const obsNum = c.observed;
            // Autonomous lane holds cap-1 to reserve one for directed work; floor at 1.
            const autonomousLimit = Math.max(1, capNum - 1);
            return obsNum < autonomousLimit;
          }
          return false; // unknown shape => treat as no capacity
        })();
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
        void fetch(`${selfUrl}/v2/impulses/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

  try {
    const activityApiUrl = process.env["ACTIVITY_API_ENDPOINT"] ?? process.env["ACTIVITY_API_URL"] ?? "http://127.0.0.1:8080";
    const response = await fetch(`${activityApiUrl}/v2/events/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Api-Key": "development-vessel" },
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
    },
  };
}
