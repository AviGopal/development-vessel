import type { ResolverResult } from "./types.js";
import {
  predictLandabilityBatch,
  type GapLandabilityFeatures,
  LANDABILITY_THRESHOLD,
} from "./gap-landability-model";



async function _DELETED_autoCloseStaleSubstrateGaps(
  gaps: Array<{ id: string; createdAt: Date | string; status: string }>,
  checkProgress: (gapId: string) => Promise<boolean>,
  closeGap: (gapId: string) => Promise<void>
): Promise<string[]> {
  const now = Date.now();
  const closed: string[] = [];
  for (const gap of gaps) {
    if (gap.status === "closed") continue;
    const age = now - new Date(gap.createdAt).getTime();
    if (age < FORTY_EIGHT_HOURS_MS) continue;
    const hasProgress = await checkProgress(gap.id);
    if (hasProgress) continue;
    await closeGap(gap.id);
    closed.push(gap.id);
  }
  return closed;
}
import type { GapLifecycleScanResult } from '../types/gap-types';
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Categories that are known to produce un-actionable gaps and should be
 * auto-closed when they have zero progress signals after the stale threshold.
 */
const PROBLEMATIC_STALE_CATEGORIES = new Set([
  'auto_draft_fallback_recommend',
  'auto_draft_triggered',
  'novel_failure_mode_detected',
]);

/**
 * Returns true when a gap should be auto-closed due to stale inactivity.
 *
 * Criteria (ALL must hold):
 *   1. Gap has been open > 48 h without any update.
 *   2. No draft updates recorded (draft_updated_at is absent or equals created_at).
 *   3. No linked resolutions (linked_resolution_ids is empty / absent).
 *   4. The gap category is either in the known-problematic set OR the gap is
 *      older than 72 h (generic fallback for all categories).
 */
export function shouldAutoClose(gap: {
  category?: string;
  created_at?: string | number;
  updated_at?: string | number;
  draft_updated_at?: string | number;
  linked_resolution_ids?: string[];
}): boolean {
  const now = Date.now();

  const createdAt =
    gap.created_at !== undefined ? new Date(gap.created_at).getTime() : null;
  const updatedAt =
    gap.updated_at !== undefined ? new Date(gap.updated_at).getTime() : null;

  if (createdAt === null || isNaN(createdAt)) return false;

  const lastTouched = updatedAt !== null && !isNaN(updatedAt) ? updatedAt : createdAt;
  const ageMs = now - lastTouched;

  if (ageMs <= STALE_THRESHOLD_MS) return false;

  // Zero progress signals: no draft updates beyond creation
  const draftUpdatedAt =
    gap.draft_updated_at !== undefined
      ? new Date(gap.draft_updated_at).getTime()
      : null;
  const hasDraftProgress =
    draftUpdatedAt !== null &&
    !isNaN(draftUpdatedAt) &&
    draftUpdatedAt > createdAt;

  if (hasDraftProgress) return false;

  // No linked resolutions
  const hasLinkedResolution =
    Array.isArray(gap.linked_resolution_ids) &&
    gap.linked_resolution_ids.length > 0;

  if (hasLinkedResolution) return false;

  // Auto-close if in known-problematic category OR age > 72 h
  const isProblematicCategory =
    gap.category !== undefined && PROBLEMATIC_STALE_CATEGORIES.has(gap.category);
  const isVeryOld = ageMs > 72 * 60 * 60 * 1000;

  return isProblematicCategory || isVeryOld;
}

// NOTE: un-landable stale gaps are now also caught proactively by
// gap-landability-model.ts (predictive, backward model) before they go stale.
// This scanner remains the reactive safety net for gaps that slip through.

/**
 * gap_lifecycle_scan — a SECOND-ORDER (lever-4 emergent) detector whose subject is
 * the gap store itself, not any single execution. Per-step detectors emit gaps;
 * none watches what happens to gaps AFTER emission. Result: the store accumulates
 * stale-open and churned gaps (observed: 236 open / 268) — including gaps the loop
 * drafted, failed to apply, yet left open (the self-alteration-throughput-zero-apply
 * churn). This detects the emergent gap-lifecycle pathologies:
 *
 *  - churned_gap: open + a draft was attempted (proposal sentinel exists) + that
 *    apply FAILED (outcome_shape=structuredError) + stale. The loop tried and
 *    couldn't land it — likely already-resolved or not patch-with-tools-tractable.
 *    AUTO-CLOSED (safe: live detectors re-emit it next cycle if still real), which
 *    stops the drafter wasting cycles re-drafting an un-landable gap.
 *  - stale_open_gap (aggregate): open + untouched > staleHours. Reported as a
 *    backlog-health summary (one meta-gap), not one-per-gap (avoid flooding).
 *
 * Deterministic, no LLM. Same snapshot-reader pattern as cost_expectation_scan /
 * self_alteration_funnel_scan. auto_close defaults false (safe); the seed enables it.
 */

export interface GapLifecycleScanPointer {
  type: "gap_lifecycle_scan";
  gapsPath?: string;          // default /workspace/gaps/gaps.json
  proposalsDir?: string;      // default /workspace/proposals
  staleHours?: number;        // open+untouched beyond this = stale. default 48
  autoClose?: boolean;        // auto-close churned gaps. default false (seed sets true)
  maxClose?: number;          // cap auto-closes per run. default 25
  devVesselImpulsesUrl?: string;
  dry_run?: boolean;
}

const DEFAULT_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const sanitizeId = (id: string): string => id.replace(/:/g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// Categories that are known to produce un-actionable / never-closing gaps
const AUTO_CLOSE_CATEGORIES = new Set([
  'auto_draft_fallback_recommend',
  'auto_draft_triggered',
  'novel_failure_mode_detected',
]);

function isAutoCloseable(gap: {
  category?: string;
  updatedAt?: string | number | Date;
  draftUpdates?: number;
  linkedResolutions?: number;
}): boolean {
  const now = Date.now();
  const updated = gap.updatedAt ? new Date(gap.updatedAt).getTime() : 0;
  const ageMs = now - updated;
  const isStale = ageMs > STALE_THRESHOLD_MS;
  const noProgress =
    (gap.draftUpdates ?? 0) === 0 && (gap.linkedResolutions ?? 0) === 0;
  return isStale && noProgress && AUTO_CLOSE_CATEGORIES.has(gap.category ?? '');
}

interface Gap {
  id?: string; category?: string; status?: string;
  created_at?: string; updated_at?: string; summary?: string;
}
interface Sentinel { outcome_shape?: string; delegated_to?: string }

export async function resolveGapLifecycleScan(p: GapLifecycleScanPointer): Promise<ResolverResult> {
  const gapsPath = p.gapsPath ?? "/workspace/gaps/gaps.json";
  const proposalsDir = p.proposalsDir ?? "/workspace/proposals";
  const staleHours = p.staleHours ?? 48;
  const autoClose = p.autoClose === true;
  const maxClose = p.maxClose ?? 25;
  const dryRun = p.dry_run === true;
  const emitUrl = p.devVesselImpulsesUrl ?? DEFAULT_URL;
  const staleBefore = Date.now() - staleHours * 3_600_000;

  let gaps: Gap[] = [];
  try {
    const parsed = JSON.parse(readFileSync(gapsPath, "utf-8"));
    gaps = Array.isArray(parsed) ? parsed : (parsed.gaps ?? []);
  } catch (err) {
    return { shape: "structuredError", body: { resolver: "gap_lifecycle_scan", detail: `gaps store unreadable: ${(err as Error).message}` } };
  }

  // Failed-apply sentinels: gaps the loop drafted + tried to apply + that FAILED.
  const failedSentinels = new Set<string>();
  try {
    for (const name of readdirSync(join(proposalsDir, ".applied"))) {
      if (!name.endsWith("-report.json")) continue;
      try {
        const s = JSON.parse(readFileSync(join(proposalsDir, ".applied", name), "utf-8")) as Sentinel;
        if (s.outcome_shape === "structuredError") failedSentinels.add(name.replace(/-report\.json$/, ""));
      } catch { /* skip */ }
    }
  } catch { /* tolerant */ }

  const open = gaps.filter((g) => g.status === "open" && typeof g.id === "string");
  const stale = (g: Gap) => { const t = Date.parse(g.updated_at ?? g.created_at ?? ""); return Number.isFinite(t) && t < staleBefore; };

  // Backward predictive model: learn landability from closed/churned outcomes.
  // Features: remediation_present (summary mentions fix/patch), single_file (one path token),
  // category. Label: landed (status==="closed" and not in failedSentinels) vs not-landed.
  const features = (g: Gap): { remediation: number; singleFile: number; category: string } => {
    const s = (g.summary ?? "").toLowerCase();
    const remediation = /\b(fix|patch|remediat|apply|replace|add|remove)\b/.test(s) ? 1 : 0;
    const paths = (g.summary ?? "").match(/[\w./-]+\.[a-zA-Z]{1,5}\b/g) ?? [];
    const singleFile = paths.length === 1 ? 1 : 0;
    return { remediation, singleFile, category: g.category ?? "?" };
  };
  const trainSet = gaps.filter((g) => g.status === "closed" || (typeof g.id === "string" && failedSentinels.has(sanitizeId(g.id))));
  const catLandRate: Record<string, { land: number; total: number }> = {};
  let remLand = 0, remTotal = 0, sfLand = 0, sfTotal = 0, baseLand = 0, baseTotal = 0;
  for (const g of trainSet) {
    const landed = g.status === "closed" && !(typeof g.id === "string" && failedSentinels.has(sanitizeId(g.id)));
    const f = features(g);
    baseTotal++; if (landed) baseLand++;
    if (f.remediation) { remTotal++; if (landed) remLand++; }
    if (f.singleFile) { sfTotal++; if (landed) sfLand++; }
    const c = catLandRate[f.category] ?? { land: 0, total: 0 };
    c.total++; if (landed) c.land++;
    catLandRate[f.category] = c;
  }
  const baseRate = baseTotal > 0 ? baseLand / baseTotal : 0.5;
  const landability = (g: Gap): number => {
    const f = features(g);
    const remScore = remTotal > 0 ? remLand / remTotal : baseRate;
    const sfScore = sfTotal > 0 ? sfLand / sfTotal : baseRate;
    const cat = catLandRate[f.category];
    const catScore = cat && cat.total > 0 ? cat.land / cat.total : baseRate;
    const weighted = (f.remediation ? remScore : (1 - remScore)) * 0.4
      + (f.singleFile ? sfScore : (1 - sfScore)) * 0.2
      + catScore * 0.4;
    return Math.max(0, Math.min(1, weighted));
  };
  const LANDABILITY_THRESHOLD = 0.2;
  const unlandable = open.filter((g) => landability(g) < LANDABILITY_THRESHOLD);

  const churned = open.filter((g) => failedSentinels.has(sanitizeId(g.id!)) && stale(g));
  const staleOpen = open.filter((g) => stale(g));

  // 1. Auto-close churned gaps (safe: re-emitted next cycle if still real).
  const closed: string[] = [];
  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
  if (autoClose && !dryRun) {
    for (const g of churned.slice(0, maxClose)) {
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: {
            id: g.id, category: g.category ?? "other", source: "substrate_detected",
            summary: `[auto-closed by gap_lifecycle_scan] ${(g.summary ?? "").slice(0, 160)} — drafted + apply FAILED (structuredError) + stale >${staleHours}h; likely already-resolved or not patch-tractable. Live detectors will re-open if still real.`,
            status: "closed", detected_at: new Date().toISOString(),
            classification_metadata: { closed_reason: "churned_unlandable", closed_by: "gap_lifecycle_scan" },
          } } } }),
          signal: AbortSignal.timeout(8_000),
        });
        if (resp.ok) closed.push(g.id!);
      } catch { /* best-effort */ }
    }
  }

  // 2. One aggregate backlog-health meta-gap (not one-per-gap).
  const byCat: Record<string, number> = {};
  for (const g of staleOpen) byCat[g.category ?? "?"] = (byCat[g.category ?? "?"] ?? 0) + 1;
  const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  let backlogPosted: number | "error" | null = null;
  if (!dryRun && staleOpen.length >= 50) {
    try {
      const resp = await fetch(emitUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: {
          id: "gap-backlog-unhealthy", category: "architectural_pattern", source: "substrate_detected",
          summary: `Gap store backlog unhealthy: ${staleOpen.length}/${open.length} open gaps are stale (>${staleHours}h untouched), ${churned.length} churned (drafted+failed+stale). Top stale categories: ${topCats.map(([c, n]) => `${c}=${n}`).join(", ")}. Many gaps never close — needs auto-close + a gap-emission audit (are detectors emitting un-actionable gaps?).`,
          detected_at: new Date().toISOString(), status: "open",
          classification_metadata: { gap_subtype: "gap_backlog_unhealthy", open: open.length, stale_open: staleOpen.length, churned: churned.length, auto_closed_this_run: closed.length, top_stale_categories: Object.fromEntries(topCats) },
        } } } }),
        signal: AbortSignal.timeout(8_000),
      });
      backlogPosted = resp.status;
    } catch { backlogPosted = "error"; }
  }

  return {
    shape: "gapLifecycleReport",
    body: {
      total_gaps: gaps.length, open: open.length,
      stale_open: staleOpen.length, churned: churned.length,
      auto_closed: closed.length, auto_closed_ids: closed.slice(0, 20),
      backlog_meta_gap_posted: backlogPosted,
      top_stale_categories: Object.fromEntries(topCats),
      stale_hours: staleHours, dry_run: dryRun, auto_close: autoClose,
      completed_at: new Date().toISOString(),
    },
  };
}
