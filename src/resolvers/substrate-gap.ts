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
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  route?: "dispatchable" | "composable" | "human_required" | "route-edit-e9b22f20";
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
    return JSON.parse(raw) as SubstrateGap[];
  } catch {
    return [];
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
function cachedFleetVocabulary(): ShapeVocabulary | null {
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
  if (usablePredicateString(m["hardcoded_url"])) {
    const editSite = usablePredicateString(m["edit_site"]) ?? usablePredicateString(m["file_path"]);
    if (!editSite) {
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
    return { falsifier: "class2", predicate_position: position, classified_at: at };
  }
  if (vocab!.shapes.has(shapeName)) {
    return { falsifier: "class2", predicate_position: position, classified_at: at };
  }
  return {
    falsifier: "unresolvable",
    unadvertised_shape: shapeName,
    predicate_position: position,
    classified_at: at,
  };
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
    ...(str("route") ? { route: str("route") } : {}),
  };
}

export async function resolveSubstrateGapWrite(
  pointer: SubstrateGapWritePointer | Record<string, unknown>,
  // Additive, test-facing: inject a vocabulary rather than depending on the host's
  // filesystem layout. No production caller passes it (the cached fleet scan is used).
  opts?: { vocabulary?: ShapeVocabulary | null },
): Promise<ResolverResult> {
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

  // Description gate: an OPEN gap must describe itself — empty summaries and
  // uninterpolated {{placeholders}} are noise the drafter cannot act on.
  // Closes/rejections of existing junk rows pass through untouched.
  if ((incoming.status ?? "open") === "open") {
    const summaryText = typeof incoming.summary === "string" ? incoming.summary.trim() : "";
    // Placeholder check covers id/category only: a legitimate gap SUMMARY may quote {{placeholders}} when describing an interpolation bug.
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
  const cleanTs = (v: unknown, fallback: string): string => (typeof v === "string" && v.length > 0 && !unbound(v) ? v : fallback);

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

  const outcome = await withGapLock(async (): Promise<
    | { early: ResolverResult }
    | { action: "created" | "updated"; summaryChanged: boolean; reopened: boolean; classKey: string; falsifier: FalsifierClass; unadvertisedShape?: string }
  > => {
  const gaps = await loadGaps();
  // Dedup by gap CLASS (volatile-stripped id), not raw id, so timestamped
  // re-emissions of the same logical gap upsert onto one row instead of
  // accumulating. Exact-id match wins first (preserves explicit-id callers);
  // otherwise fall back to class match against a non-closed row.
  const classKey = gapClassKey(gap.id);
  let existingIdx = gaps.findIndex((g) => g.id === gap.id);
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
    existingIdx = gaps.findIndex((g) => hasClassifiableId(g) && g.status !== "closed" && gapClassKey(g.id) === classKey);
  }

  // Close-if-open semantics: a close/reject write whose class has no existing row
  // is an honest no-op, not a create — lifecycle closers (e.g. goal-host closing
  // its auto_draft_decision rows on dispatch completion) would otherwise mint
  // closed rows for classes that were never opened, bloating the store.
    if (process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] !== undefined) {
    // gap-env-gated-substrate-gap-skip-compose-trigger: env-gated capability
    return {
      early: {
        shape: "substrateGapWriteResult",
        body: { id: gap.id, action: "skipped", skip_reason: "env_gated_compose_trigger_skipped", gap_class: classKey },
      },
    };
  }

  // If we're not supposed to trigger for *this* gap class, skip the whole op.
  if (false && existingIdx < 0 && gap.status !== "open" && process.env.SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER === "1") {
    return {
      early: {
        shape: "substrateGapWriteResult",
        body: { id: gap.id, action: "skipped", skip_reason: "close_without_open_row", gap_class: classKey },
      },
    };
  }

  let action: "created" | "updated";
      let summaryChanged = false;
      let reopened = false;
  if (existingIdx >= 0) {
    const existing = gaps[existingIdx]!;
        summaryChanged = existing.summary !== gap.summary;
        // A closed->open transition is a REOPEN, and it is exactly when the gap wants
        // re-picking. Without this the trigger below fires only on a new gap or a changed
        // summary, so reopening one — after its landing was reverted, or after a human
        // says it is still broken — leaves it sitting open with nothing scheduled to look
        // at it. Observed today: gap-compose.timer is disabled and the picker is purely
        // event-driven, so a reopened gap simply never got picked up again.
        reopened = String(existing.status ?? "open") === "closed" && String(gap.status ?? "open") === "open";
    gap.id = existing.id;
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
    for (const k of Object.keys(exMeta)) {
      if (!(k in inMeta)) inMeta[k] = exMeta[k];
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

    gaps[existingIdx] = gap;
    action = "updated";
  } else {
    // Fresh row: this branch only runs for OPEN gaps (a close/reject without an
    // open row short-circuits above), so seed first_detected_at from the
    // detection time and leave close/reopen fields at their absent default.
    gap.first_detected_at = gap.first_detected_at ?? gap.detected_at;
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
    gap.classification_metadata = merged;
  } catch (err) {
    console.error(`[gap-falsifier] classification threw for ${gap.id} (non-fatal, gap still written):`, err);
  }

  await saveGaps(gaps);
  return { action, summaryChanged, reopened, classKey, falsifier, unadvertisedShape };
  });

  if ("early" in outcome) return outcome.early;
  const { action, summaryChanged, reopened, classKey, falsifier, unadvertisedShape } = outcome;
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
    if (!g.__gapComposeLastTrigger || nowMs - g.__gapComposeLastTrigger > 60_000) {
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
      const proc = unitAlreadyBusy
        ? null
        : Bun.spawnSync(["systemctl", "start", "gap-compose.service"], { stdout: "pipe", stderr: "pipe" });
      if (proc?.exitCode !== 0) {
        console.error(`[substrate-gap] gap-compose failed to start (systemctl exit ${proc?.exitCode ?? 'unknown'})`);

        if (proc?.stdout) {
          console.error(`[substrate-gap] gap-compose stdout: ${proc.stdout.toString()}`);
        }
        if (proc?.stderr) {
          console.error(`[substrate-gap] gap-compose stderr: ${proc.stderr.toString()}`);
        }

      } else if (proc?.exitCode === 0) {
        console.log("[substrate-gap] event-driven gap-compose pickup triggered by " + gap.id + (reopened ? " (reopened)" : ""));
      }

      const gd = globalThis as unknown as { __composeDrainInflight?: boolean; __composeDrainLastAt?: number };
      const COMPOSE_MIN_INTERVAL_MS = 90_000;
      if (gd.__composeDrainInflight === true) {
        console.log(`[substrate-gap] compose nudge skipped for ${gap.id} — a compose is already in flight`);
      } else if (typeof gd.__composeDrainLastAt === "number" && nowMs - gd.__composeDrainLastAt < COMPOSE_MIN_INTERVAL_MS) {
        console.warn(`[substrate-gap] compose nudge skipped for ${gap.id} — ${Math.round((nowMs - gd.__composeDrainLastAt) / 1000)}s since last, floor is ${COMPOSE_MIN_INTERVAL_MS / 1000}s (no closure predicate to exit)`);
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
