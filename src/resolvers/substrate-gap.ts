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
  return id
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "U")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.\-Z]+/g, "T")
    .replace(/\d{4}-\d{2}-\d{2}/g, "D")
    .replace(/\d{13}/g, "M")
    .replace(/\d{10}/g, "S");
}

async function loadGaps(): Promise<SubstrateGap[]> {
  try {
    const raw = await readFile(GAPS_PATH(), "utf-8");
    return JSON.parse(raw) as SubstrateGap[];
  } catch {
    return [];
  }
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
  const tmp = GAPS_PATH() + ".tmp";
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

export async function resolveSubstrateGapWrite(
  pointer: SubstrateGapWritePointer,
): Promise<ResolverResult> {
  const now = new Date().toISOString();
  const incoming = pointer.gap;

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

  const gap: SubstrateGap = {
    ...incoming,
    status: incoming.status ?? "open",
    created_at: incoming.created_at ?? now,
    updated_at: now,
  };

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
    const openInClass = gaps.filter((g) => g.status === "open" && gapClassKey(g.id) === classKey).length;
    if (openInClass >= cap) {
      console.log(`[gap-consumption-gate] refused open write: class=${classKey} open=${openInClass} cap=${cap} id=${gap.id}`);
      return {
        shape: "structuredError",
        body: {
          resolver: "substrateGap_write",
          failure_mode: "consumption_gated",
          detail: `gap ${gap.id}: class "${classKey}" already has ${openInClass} open rows (cap ${cap}) — consumption-gated: class backlog un-drained`,
        },
      };
    }
  }
  if (existingIdx < 0) {
    existingIdx = gaps.findIndex((g) => g.status !== "closed" && gapClassKey(g.id) === classKey);
  }

  let action: "created" | "updated";
  if (existingIdx >= 0) {
    const existing = gaps[existingIdx]!;
    gap.id = existing.id;
    gap.created_at = existing.created_at;
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
    for (const k of ["failed_attempts", "last_failed_at", "mispredicted_lands", "last_predicted_p"]) {
      if (!(k in inMeta) && k in exMeta) inMeta[k] = exMeta[k];
    }
    gap.classification_metadata = inMeta;
    gaps[existingIdx] = gap;
    action = "updated";
  } else {
    gaps.push(gap);
    action = "created";
  }

  await saveGaps(gaps);

  return {
    shape: "substrateGapWriteResult",
    body: { id: gap.id, action, gap_class: classKey },
  };
}
