import type { ResolverResult } from "./types.js";
import { readFileSync, readdirSync, appendFileSync } from "node:fs";
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
  source?: string;
}
interface Sentinel { outcome_shape?: string; delegated_to?: string }

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Gap categories considered low-value for auto-close purposes */
const LOW_VALUE_CATEGORIES = new Set([
  'auto_draft_fallback_recommend',
  'auto_draft_triggered',
  'wasted_cycle',
]);

interface GapRecord {
  gap_id: string;
  state?: string;
  information_yield?: string;
  last_touch?: string;
  category?: string;
  gap_subtype?: string;
  context?: unknown;
}

interface GapStore {
  updateGapState(gapId: string, update: { state: string; reason: string; closed_at: string }): Promise<void>;
}

interface GapClosureEvent {
  event_type: string;
  gap_id: string;
  category?: string;
  gap_subtype?: string;
  previous_state?: string;
  new_state: string;
  reason: string;
  stale_duration_ms: number;
  closed_at: string;
}

interface GapEventEmitter {
  emit(event: GapClosureEvent): Promise<void>;
}

/** activity_lifecycle gaps auto-close only when they lack a state change */
function isLowValueActivityLifecycle(gap: GapRecord): boolean {
  if ((gap.gap_subtype ?? gap.category ?? '') !== 'activity_lifecycle') {
    return false;
  }
  const ctx = gap.context as Record<string, unknown> | null | undefined;
  const hasStateChange =
    ctx != null &&
    (ctx['from_state'] != null ||
      ctx['to_state'] != null ||
      ctx['state_transition'] != null);
  return !hasStateChange;
}

/**
 * Auto-close stale gaps: >48h untouched, information_yield='idle', low-value category.
 * Returns the list of gap IDs that were closed and the closure events emitted.
 */
export async function autoCloseStaleGaps(
  gaps: GapRecord[],
  store: GapStore,
  eventEmitter: GapEventEmitter
): Promise<{ closedIds: string[]; closureEvents: GapClosureEvent[] }> {
  const now = Date.now();
  const closedIds: string[] = [];
  const closureEvents: GapClosureEvent[] = [];

  for (const gap of gaps) {
    if (gap.state === 'closed' || gap.state === 'closed_stale') continue;

    // (1) information_yield must be idle
    if (gap.information_yield !== 'idle') continue;

    // (2) last_touch must be >48h ago
    const lastTouch =
      gap.last_touch != null ? new Date(gap.last_touch).getTime() : 0;
    if (now - lastTouch <= STALE_THRESHOLD_MS) continue;

    // (3) must be low-value category or low-value activity_lifecycle
    const category = gap.gap_subtype ?? gap.category ?? '';
    const isLowValue =
      LOW_VALUE_CATEGORIES.has(category) ||
      isLowValueActivityLifecycle(gap);
    if (!isLowValue) continue;

    // Transition to closed_stale
    await store.updateGapState(gap.gap_id, {
      state: 'closed_stale',
      reason: 'no_actionable_progress',
      closed_at: new Date().toISOString(),
    });

    const event: GapClosureEvent = {
      event_type: 'gap_auto_closed',
      gap_id: gap.gap_id,
      category: gap.category,
      gap_subtype: gap.gap_subtype,
      previous_state: gap.state,
      new_state: 'closed_stale',
      reason: 'no_actionable_progress',
      stale_duration_ms: now - lastTouch,
      closed_at: new Date().toISOString(),
    };

    await eventEmitter.emit(event);
    closedIds.push(gap.gap_id);
    closureEvents.push(event);
  }

  return { closedIds, closureEvents };
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

  // Auto-close stale gaps before computing scan result
  const openGapRecords = open.map((g) => ({
    gap_id: g.id!,
    state: g.status,
    information_yield: 'idle' as const,
    last_touch: g.updated_at ?? g.created_at,
    category: g.category,
    gap_subtype: undefined,
    context: undefined,
  }));
  const autoCloseStore: GapStore = {
    async updateGapState(_gapId, _update) { /* scan-mode: no-op; closures handled via impulse API below */ },
  };
  const autoCloseEmitter: GapEventEmitter = {
    async emit(_event) { /* scan-mode: no-op */ },
  };
  const { closedIds, closureEvents } = autoClose && !dryRun
    ? await autoCloseStaleGaps(openGapRecords, autoCloseStore, autoCloseEmitter)
    : { closedIds: [] as string[], closureEvents: [] as GapClosureEvent[] };

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  const lowValueClosed: string[] = [];
  if (autoClose && !dryRun) {
    for (const id of closedIds.slice(0, maxClose)) {
      const g = open.find((x) => x.id === id);
      if (!g) continue;
      // Age-boundary re-verification: detector upsert-by-id refreshes updated_at,
      // so updated_at > created_at + staleHours*h means the gap was re-detected
      // within the current age window — do NOT close, count the verified boundary.
      const createdAt = g.created_at ? new Date(g.created_at).getTime() : 0;
      const updatedAt = g.updated_at ? new Date(g.updated_at).getTime() : 0;
      const staleWindowMs = staleHours * 60 * 60 * 1000;
      const reDetected = updatedAt > createdAt + staleWindowMs;
      if (reDetected) {
        const meta = (g as any).classification_metadata ?? {};
        const prevBoundaries = Number(meta.verified_age_boundaries ?? 0);
        try {
          await fetch(emitUrl.replace(/\/v2\/impulses\/resolve$/, '') + `/v2/gaps/${g.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({
              classification_metadata: {
                ...meta,
                verified_age_boundaries: prevBoundaries + 1,
              },
            }),
            signal: AbortSignal.timeout(8_000),
          });
        } catch { }
        continue;
      }
      const metaForClose = (g as any).classification_metadata ?? {};
      const prevVerified = Number(metaForClose.verified_age_boundaries ?? 0);
      const closeReason = prevVerified >= 1 ? 'condition_cleared' : 'stale_low_value';
      try {
        const resp = await fetch(emitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ impulse: { pointer: { type: 'substrateGap_write', gap: { id: g.id, category: g.category ?? 'other', source: 'substrate_detected', summary: `[auto-closed by gap_lifecycle_scan] ${(g.summary ?? '').slice(0, 160)} — stale low-value (not re-detected >${staleHours}h). Live detectors re-open if still real.`, status: 'closed', detected_at: new Date().toISOString(), classification_metadata: { closed_reason: closeReason, closed_by: 'gap_lifecycle_scan', previous_status: 'open', last_seen: g.updated_at ?? g.created_at } } } } }),
          signal: AbortSignal.timeout(8_000)
        });
        if (resp.ok) lowValueClosed.push(g.id!);
      } catch { }
    }
  }

  // Remove auto-closed gaps from further processing this run
  const remainingOpen = open.filter((g) => !closedIds.includes(g.id!));

  const churned = remainingOpen.filter((g) => failedSentinels.has(sanitizeId(g.id!)) && stale(g));
  const staleOpen = remainingOpen.filter((g) => stale(g));

  const expireHours = (p as any).expireHours ?? 336;
  const maxExpire = (p as any).maxExpire ?? 100;
  const expireBefore = Date.now() - expireHours * 3_600_000;
  const detectorExpireHours = (p as any).detectorExpireHours ?? 120;
  const detectorExpireBefore = Date.now() - detectorExpireHours * 3_600_000;
  const expiredCandidates = remainingOpen.filter((g) => {
    const t = Date.parse(g.updated_at ?? g.created_at ?? '');
    return Number.isFinite(t) && t < (g.source === 'substrate_detected' ? detectorExpireBefore : expireBefore) && !lowValueClosed.includes(g.id!);
  });
  const expired: string[] = [];
  if (autoClose && !dryRun) {
    for (const g of expiredCandidates.slice(0, maxExpire)) {
      try {
        const resp = await fetch(emitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ impulse: { pointer: { type: 'substrateGap_write', gap: { id: g.id, category: g.category ?? 'other', source: 'substrate_detected', summary: `[expired by gap_lifecycle_scan] ${(g.summary ?? '').slice(0, 160)} — not re-detected within ${expireHours}h TTL; detector liveness (upsert-by-id) says this is likely no longer valid. Re-opens automatically if a detector re-emits it.`, status: 'closed', detected_at: new Date().toISOString(), classification_metadata: { closed_reason: 'expired_not_redetected', closed_by: 'gap_lifecycle_scan', previous_status: 'open', first_detected: g.created_at, last_seen: g.updated_at ?? g.created_at } } } } }),
          signal: AbortSignal.timeout(8_000)
        });
        if (resp.ok) expired.push(g.id!);
      } catch { }
    }
  }

  // 1. Auto-close churned gaps (safe: re-emitted next cycle if still real).
  const closed: string[] = [];

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

  const historyPath = "/workspace/gaps/funnel-history.jsonl";
  const runRecord = {
    run_at: new Date().toISOString(),
    total: gaps.length,
    open_before: open.length,
    open_after: open.length - lowValueClosed.length - expired.length - closed.length,
    stale_open: staleOpen.length,
    low_value_closed: lowValueClosed.length,
    expired: expired.length,
    churned_closed: closed.length,
    closed_total: gaps.filter((g) => g.status === "closed").length,
  };
  let funnelHistory: unknown[] = [];
  try {
    if (!dryRun) appendFileSync(historyPath, JSON.stringify(runRecord) + "\n");
    funnelHistory = readFileSync(historyPath, "utf-8").trim().split("\n").slice(-12).map((l) => JSON.parse(l));
  } catch {
    funnelHistory = [runRecord];
  }

  return {
    shape: "gapLifecycleReport",
    body: {
      total_gaps: gaps.length, open: open.length,
      stale_open: staleOpen.length, churned: churned.length,
      auto_closed: closed.length, auto_closed_ids: closed.slice(0, 20),
      low_value_closed: lowValueClosed.length,
      expired: expired.length,
      expire_hours: expireHours,
      funnel_history: funnelHistory,
      consumption_queue: remainingOpen.filter((g) => !expired.includes(g.id!)).map((g) => ({ id: g.id, category: g.category, landability: landability(g) })).sort((a, b) => b.landability - a.landability).slice(0, 10),
      gap_priority_ranking: remainingOpen.map((g) => { const meta = ((g as { classification_metadata?: Record<string, unknown> }).classification_metadata ?? {}) as Record<string, unknown>; const shape = String(meta.desired_shape ?? "").toLowerCase(); const citations = Number(meta.failed_attempts ?? 0) + (shape.length > 3 ? gaps.filter((o) => o.id !== g.id && (o.summary ?? "").toLowerCase().includes(shape)).length : 0); const unlock = gaps.filter((o) => o.id !== g.id && o.status === "open" && (o.summary ?? "").toLowerCase().includes(String(g.id ?? "").toLowerCase())).length; const surgical = (typeof meta.target_file === "string" || typeof meta.edit_site === "string" || typeof meta.matched_excerpt === "string" || typeof meta.code_site === "string") ? 1 : 0; const score = citations * 3 + unlock * 2 + surgical + landability(g); return { id: g.id, citations, unlock_fan_out: unlock, drafter_fit: surgical ? "surgical" : "unanchored", score, justification: "cited by " + citations + " failure signal(s), unlocks " + unlock + " other gap(s), " + (surgical ? "surgical (anchored code site)" : "needs localization") + ", landability " + landability(g).toFixed(2) }; }).sort((a, b) => b.score - a.score).slice(0, 15),
      backlog_meta_gap_posted: backlogPosted,
      top_stale_categories: Object.fromEntries(topCats),
      stale_hours: staleHours, dry_run: dryRun, auto_close: autoClose,
      completed_at: new Date().toISOString(),
    },
  };
}
