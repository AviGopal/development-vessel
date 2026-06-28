/**
 * performance_reach_gate (2026-06-28) — the reach-gate generalised from GOAL SHAPES
 * to a METRIC. The goal reach-gate (verifyGoalReached) accepts a goal execution only
 * if the asked output shapes actually appeared; this accepts a PERFORMANCE change only
 * if the target metric actually improved. Without it, a perf "fix" that typecheck-passes
 * but does NOT make anything faster lands and the substrate "declares victory" — exactly
 * what happened to an operator type::datetime() edit that left execution-traces at 8-11s.
 *
 * For perf, THE METRIC IS THE REWARD. This re-measures the live endpoint (median of N
 * samples to survive load noise) and returns reached=true only if the median is at/below
 * the target latency OR improved over the recorded baseline by min_improvement_pct.
 *
 * Wiring (the autonomous canary loop): a performance_inefficiency change is a CANARY —
 * apply -> cut over (restart) -> performance_reach_gate -> if reached keep, else REVERT
 * via the self-recovery immune system. This is the perf analogue of the goal /resolve
 * loop's in-flight recovery: a fix that does not move the metric is excluded, and a
 * genuinely different fix-class is tried next.
 */
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface PerformanceReachGatePointer {
  type: "performance_reach_gate";
  /** Endpoint path under METABOB_ENDPOINT to re-measure (e.g. /v2/activities/execution-traces?limit=200). */
  probe_path: string;
  /** Reached if the measured median is at/below this (ms). Default 2000. */
  target_latency_ms?: number;
  /** Baseline latency (ms) — typically the gap's measured_latency_ms. Reached if improved by min_improvement_pct vs this. */
  baseline_latency_ms?: number;
  /** Required improvement over baseline (%) to count as reached when target not met. Default 25. */
  min_improvement_pct?: number;
  /** Probes to take; median is used to survive load noise. Default 3. */
  samples?: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

export async function resolvePerformanceReachGate(pointer: PerformanceReachGatePointer): Promise<ResolverResult> {
  const target = pointer.target_latency_ms ?? 2000;
  const minPct = pointer.min_improvement_pct ?? 25;
  const samples = Math.max(1, Math.min(pointer.samples ?? 3, 7));

  const latencies: number[] = [];
  let anyFailed = false;
  for (let i = 0; i < samples; i++) {
    const start = Date.now();
    try {
      const res = await fetch(`${METABOB_ENDPOINT}${pointer.probe_path}`, {
        headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
        signal: AbortSignal.timeout(30_000),
      });
      await res.text().catch(() => "");
      if (!res.ok) anyFailed = true;
    } catch {
      anyFailed = true;
    }
    latencies.push(Date.now() - start);
  }

  const med = median(latencies);
  const baseline = pointer.baseline_latency_ms;
  const improvementPct = typeof baseline === "number" && baseline > 0
    ? Math.round(((baseline - med) / baseline) * 1000) / 10
    : null;

  const metTarget = med <= target && !anyFailed;
  const metImprovement = improvementPct !== null && improvementPct >= minPct && !anyFailed;
  const reached = metTarget || metImprovement;

  return {
    shape: "performanceReachVerdict",
    body: {
      reached,
      verdict: reached ? "improved" : "not_improved",
      probe_path: pointer.probe_path,
      median_latency_ms: med,
      samples_ms: latencies,
      any_request_failed: anyFailed,
      target_latency_ms: target,
      met_target: metTarget,
      baseline_latency_ms: baseline ?? null,
      improvement_pct: improvementPct,
      min_improvement_pct: minPct,
      met_improvement: metImprovement,
      // The decision this gate hands the cutover/recovery loop:
      action: reached ? "keep" : "revert",
      reason: reached
        ? (metTarget ? `median ${med}ms <= target ${target}ms` : `improved ${improvementPct}% >= ${minPct}% vs baseline`)
        : `median ${med}ms still > target ${target}ms${improvementPct !== null ? ` and only ${improvementPct}% better than baseline ${baseline}ms` : ""}${anyFailed ? " (a probe failed/timed out)" : ""} — the change did NOT make it fast enough; revert and try a different fix-class.`,
      generated_at: new Date().toISOString(),
    },
  };
}
