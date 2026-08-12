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

// Read at call time, not module load, so tests can override WORKSPACE_ROOT
// after this module is imported (config.ts snapshots at load — that's fine
// for production where the env is set before bun starts, but tests need
// late-binding).
function workspaceRoot(): string {
  return process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
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
  route?: "dispatchable" | "composable" | "human_required";
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
    body: { gaps: results, total: results.length },
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
  const outcome = await withGapLock(async (): Promise<
    | { early: ResolverResult }
    | { action: "created" | "updated"; summaryChanged: boolean; reopened: boolean; classKey: string }
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
  existingIdx = gaps.findIndex((g) => gapClassKey(g.id) === classKey);

    // hasClassifiableId FIRST: a row missing `status` passes `!== "closed"`, so
    // without this guard the id check never runs. That exact ordering is what
    // made one malformed row unwritable-store poison.
    existingIdx = gaps.findIndex((g) => hasClassifiableId(g) && g.status !== "closed" && gapClassKey(g.id) === classKey);
  }

  // Close-if-open semantics: a close/reject write whose class has no existing row
  // is an honest no-op, not a create — lifecycle closers (e.g. goal-host closing
  // its auto_draft_decision rows on dispatch completion) would otherwise mint
  // closed rows for classes that were never opened, bloating the store.
  if (existingIdx < 0 && gap.status !== "open") {
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

  await saveGaps(gaps);
  return { action, summaryChanged, reopened, classKey };
  });

  if ("early" in outcome) return outcome.early;
  const { action, summaryChanged, reopened, classKey } = outcome;
  if ((action === "created" || (action === "updated" && (summaryChanged || reopened))) && (gap.status ?? "open") === "open") {
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
        : Bun.spawn(["systemctl", "start", "gap-compose.service"], { stdout: "ignore", stderr: "ignore" });
      void proc?.exited.then((code) => {
        if (code === 0) console.log("[substrate-gap] gap-compose unit started for " + gap.id + (reopened ? " (reopened)" : ""));
        else console.warn(`[substrate-gap] gap-compose unit did NOT start for ${gap.id} (systemctl exit ${code}) — masked or missing; relying on the in-process nudge`);
      }).catch(() => { /* spawn-level failure is reported by the nudge path */ });

      const gd = globalThis as unknown as { __composeDrainInflight?: boolean; __composeDrainLastAt?: number };
      const COMPOSE_MIN_INTERVAL_MS = 90_000;
      if (gd.__composeDrainInflight === true) {
        console.log(`[substrate-gap] compose nudge skipped for ${gap.id} — a compose is already in flight`);
      } else if (typeof gd.__composeDrainLastAt === "number" && nowMs - gd.__composeDrainLastAt < COMPOSE_MIN_INTERVAL_MS) {
        console.log(`[substrate-gap] compose nudge skipped for ${gap.id} — ${Math.round((nowMs - gd.__composeDrainLastAt) / 1000)}s since last, floor is ${COMPOSE_MIN_INTERVAL_MS / 1000}s`);
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
    body: { id: gap.id, action, gap_class: classKey },
  };
}
