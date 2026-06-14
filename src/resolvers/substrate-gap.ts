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
  | "other";

export type SubstrateGapSource = "operator_narration" | "substrate_detected";

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
}

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

  results = results
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
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
  if (existingIdx < 0) {
    existingIdx = gaps.findIndex((g) => g.status !== "closed" && gapClassKey(g.id) === classKey);
  }

  let action: "created" | "updated";
  if (existingIdx >= 0) {
    const existing = gaps[existingIdx]!;
    gap.id = existing.id;
    gap.created_at = existing.created_at;
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
