import { resolveLoadAttribution } from "./load-attribution.js";
import type { ResolverResult } from "./types.js";

export interface LoadAttributionReportPointer {
  type: "load_attribution_report";
  /** Records to scan. Default 200. */
  limit?: number;
  /** Minimum invocations per template to be reported. Default 3. */
  min_invocations?: number;
  /**
   * cpu_usec_delta threshold above which an invocation is "load-spiking".
   * Default 5_000_000_000 (5 seconds of CPU time per invocation).
   */
  cpu_delta_threshold?: number;
}

interface TemplateAggregate {
  template_id: string;
  invocations: number;
  cpu_delta_usec_total: number;
  cpu_delta_usec_median: number;
  cpu_delta_usec_max: number;
  spike_count: number;
  spike_ratio: number;
  duration_ms_median: number;
  load_1m_delta_median: number | null;
  example_dispatch_ids: string[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Substrate-citizen causal attribution for load spikes.
 *
 * Reads recent loadAttribution records (boredom-vessel writes one per dispatch
 * with before/after samples of system_load_report), groups by template_id,
 * and surfaces templates whose CPU delta crosses threshold across multiple
 * invocations. Same group-by-template pattern as trace_failure_pattern_report,
 * but for resource consumption instead of failure modes.
 *
 * Per-trace noise (concurrent observers, ribosome, concept-db work) averages
 * out across invocations. A template with spike_count >= 3 of last 5 invocations
 * is the actual culprit — exactly what the operator did manually with docker
 * stats in iter-086, now substrate-citizen.
 */
export async function resolveLoadAttributionReport(
  pointer: LoadAttributionReportPointer,
): Promise<ResolverResult> {
  const limit = pointer.limit ?? 200;
  const minInvocations = pointer.min_invocations ?? 3;
  const cpuThreshold = pointer.cpu_delta_threshold ?? 5_000_000_000;

  const raw = await resolveLoadAttribution({ type: "loadAttribution", limit });
  const body = raw.body as { records?: Array<Record<string, unknown>> };
  const allRecords = (body.records ?? []) as unknown as Array<{
    dispatch_id: string;
    template_id?: string;
    duration_ms: number;
    cpu_usec_delta: number | null;
    load_1m_delta: number | null;
    sample_quality?: string;
  }>;

  // Filter: only "both_present" records have valid deltas. Older records
  // without sample_quality fall back to the cpu_usec_delta-not-null check
  // (backward compatible with pre-quality-marker records).
  const records = allRecords.filter((r) => {
    if (r.sample_quality !== undefined) return r.sample_quality === "both_present";
    return r.cpu_usec_delta !== null && r.cpu_usec_delta !== undefined;
  });
  const skipped_unreliable = allRecords.length - records.length;

  // Group by template_id (skip records without one — typically free-text goals).
  const groups = new Map<string, typeof records>();
  for (const r of records) {
    if (!r.template_id) continue;
    const arr = groups.get(r.template_id) ?? [];
    arr.push(r);
    groups.set(r.template_id, arr);
  }

  const aggregates: TemplateAggregate[] = [];
  for (const [template_id, group] of groups.entries()) {
    if (group.length < minInvocations) continue;
    // cpu_usec_delta is non-null in this branch — filter step above already
    // ensured sample_quality === "both_present".
    const cpuDeltas = group
      .map((r) => r.cpu_usec_delta)
      .filter((v): v is number => v !== null);
    const durations = group.map((r) => r.duration_ms);
    const loadDeltas = group
      .map((r) => r.load_1m_delta)
      .filter((v): v is number => v !== null);
    const spikeCount = cpuDeltas.filter((d) => d >= cpuThreshold).length;
    aggregates.push({
      template_id,
      invocations: group.length,
      cpu_delta_usec_total: cpuDeltas.reduce((a, b) => a + b, 0),
      cpu_delta_usec_median: median(cpuDeltas),
      cpu_delta_usec_max: Math.max(...cpuDeltas),
      spike_count: spikeCount,
      spike_ratio: spikeCount / group.length,
      duration_ms_median: median(durations),
      load_1m_delta_median: loadDeltas.length > 0 ? median(loadDeltas) : null,
      example_dispatch_ids: group.slice(0, 3).map((r) => r.dispatch_id),
    });
  }

  // Sort by total CPU spent — the templates burning the most absolute CPU.
  aggregates.sort((a, b) => b.cpu_delta_usec_total - a.cpu_delta_usec_total);

  // Spiking templates: spike_ratio > 0.5 (more than half of invocations exceed threshold).
  const spiking = aggregates.filter((a) => a.spike_ratio > 0.5);

  return {
    shape: "loadAttributionReport",
    body: {
      records_examined: records.length,
      records_skipped_unreliable: skipped_unreliable,
      templates_aggregated: aggregates.length,
      spiking_template_count: spiking.length,
      cpu_delta_threshold: cpuThreshold,
      aggregates,
      spiking,
      generated_at: new Date().toISOString(),
    },
  };
}
