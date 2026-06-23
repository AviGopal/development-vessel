import type { ResolverResult } from "./types.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// NOTE: For proactive un-landable gap suppression see gap-landability-model.ts
// which provides a backward model (predict→validate→residual) that auto-closes
// gaps before they become stale, reducing the reactive workload here.

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

// Categories known to emit un-actionable gaps that rarely/never transition to closed or churned.
// These are subject to threshold-based filtering and auto-close after STALE_THRESHOLD_MS.
const UNACTIONABLE_CATEGORIES = new Set([
  'auto_draft_fallback_recommend',
  'auto_draft_triggered',
  'novel_failure_mode_detected',
  'activity_lifecycle',
  'wasted_cycle',
]);

// Gaps untouched for longer than this are considered stale and eligible for auto-close.
const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// Maximum fraction of open gaps allowed from a single un-actionable category before
// new emissions from that detector are suppressed (threshold-based filtering).
const CATEGORY_DOMINANCE_THRESHOLD = 0.25; // 25% of open gap pool

// Maximum absolute count of open gaps allowed per un-actionable category before
// new emissions are suppressed.
const CATEGORY_MAX_OPEN = 50;

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

interface Gap {
  id?: string; category?: string; status?: string;
  created_at?: string; updated_at?: string; summary?: string;
}
interface Sentinel { outcome_shape?: string; delegated_to?: string }

/**
 * Determine whether a gap is stale (untouched for more than STALE_THRESHOLD_MS).
 */
function isStale(gap: { updatedAt?: string | number | Date; createdAt?: string | number | Date }): boolean {
  const lastTouch = gap.updatedAt ?? gap.createdAt;
  if (!lastTouch) return false;
  return Date.now() - new Date(lastTouch as string).getTime() > STALE_THRESHOLD_MS;
}

/**
 * Build an audit finding for a detector category that is emitting un-actionable gaps.
 */
function buildAuditFinding(
  category: string,
  openCount: number,
  autoClosedCount: number,
  reason: string
): Record<string, unknown> {
  return {
    type: 'gap_emission_audit',
    category,
    openCount,
    autoClosedCount,
    reason,
    recommendation:
      `Detector '${category}' is emitting gaps that rarely transition to closed/churned. ` +
      `Consider refining emission criteria or removing the detector. ` +
      `${autoClosedCount} stale gap(s) were auto-closed this run.`,
    timestamp: new Date().toISOString(),
  };
}

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

  const result: Record<string, unknown> = {
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
    gaps,
  };

  // ── Auto-close stale gaps & gap-emission audit ──────────────────────────
  const allGaps: Array<Record<string, unknown>> = Array.isArray(result['gaps'])
    ? (result['gaps'] as Array<Record<string, unknown>>)
    : [];

  const totalOpen = allGaps.filter((g) => g['status'] === 'open').length;

  // Tally open counts per category (for threshold filtering)
  const openByCategory: Record<string, number> = {};
  for (const g of allGaps) {
    if (g['status'] !== 'open') continue;
    const cat = typeof g['category'] === 'string' ? g['category'] : '__unknown__';
    openByCategory[cat] = (openByCategory[cat] ?? 0) + 1;
  }

  // Auto-close stale gaps and collect per-category close counts
  const autoClosedByCategory: Record<string, number> = {};
  let totalAutoClosed = 0;

  for (const g of allGaps) {
    if (g['status'] !== 'open') continue;
    const cat = typeof g['category'] === 'string' ? g['category'] : '__unknown__';
    if (!isStale(g as { updatedAt?: string; createdAt?: string })) continue;

    // Auto-close unconditionally for un-actionable categories; also close for
    // any category when the gap has been stale beyond the threshold.
    g['status'] = 'auto_closed';
    g['autoClosedAt'] = new Date().toISOString();
    g['autoCloseReason'] = 'stale_48h_no_touch';
    autoClosedByCategory[cat] = (autoClosedByCategory[cat] ?? 0) + 1;
    totalAutoClosed++;
  }

  // Build audit findings for un-actionable categories
  const auditFindings: Array<Record<string, unknown>> = [];
  const suppressedCategories: string[] = [];

  for (const category of UNACTIONABLE_CATEGORIES) {
    const openCount = openByCategory[category] ?? 0;
    const autoClosedCount = autoClosedByCategory[category] ?? 0;
    if (openCount === 0 && autoClosedCount === 0) continue;

    let reason = '';
    const dominanceFraction = totalOpen > 0 ? openCount / totalOpen : 0;

    if (openCount > CATEGORY_MAX_OPEN) {
      reason = `Category has ${openCount} open gaps, exceeding absolute limit of ${CATEGORY_MAX_OPEN}.`;
      suppressedCategories.push(category);
    } else if (dominanceFraction > CATEGORY_DOMINANCE_THRESHOLD) {
      reason =
        `Category dominates ${(dominanceFraction * 100).toFixed(1)}% of open gaps ` +
        `(threshold: ${(CATEGORY_DOMINANCE_THRESHOLD * 100).toFixed(0)}%).`;
      suppressedCategories.push(category);
    } else if (autoClosedCount > 0) {
      reason = `${autoClosedCount} gap(s) auto-closed as stale (>48 h untouched).`;
    }

    if (reason) {
      auditFindings.push(buildAuditFinding(category, openCount, autoClosedCount, reason));
    }
  }

  // Threshold-based filtering: mark suppressed categories so callers can gate
  // new gap emissions from those detectors.
  result['autoClosedThisRun'] = totalAutoClosed;
  result['suppressedCategories'] = suppressedCategories;
  result['gapEmissionAudit'] = auditFindings;

  if (totalAutoClosed > 0 || auditFindings.length > 0) {
    console.warn(
      `[gap-lifecycle-scan] auto-closed=${totalAutoClosed} stale gaps; ` +
        `audit findings=${auditFindings.length}; ` +
        `suppressed categories=${suppressedCategories.join(', ') || 'none'}`
    );
  }

  return result as unknown as ResolverResult;
}
