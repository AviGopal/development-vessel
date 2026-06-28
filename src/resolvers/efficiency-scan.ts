/**
 * efficiency_scan (2026-06-28) — the self-MANAGEMENT analogue of the failure
 * detectors. The substrate already detects what FAILS (trace_failure_pattern_report)
 * and what is MISSING (capability_gap_audit); it had no detector for what is SLOW /
 * SATURATED / WASTEFUL. This probes hot internal endpoints, MEASURES their latency
 * (learning by experimentation — the system observes its own performance), and emits
 * a substrateGap(performance_inefficiency) for any probe over threshold. The existing
 * gap_to_feature -> feature_compose loop then authors the fix. Because the gap carries
 * a concrete edit_site + proposed_fix, the author loop is grounded.
 *
 * This is how the system learns to "manage its own internal systems efficiently":
 * observe (probe) -> open a gap -> author -> verify -> cut over, no operator.
 */
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";
import type { ResolverResult } from "./types.js";

interface Probe {
  name: string;
  path: string;
  edit_site?: string;
  proposed_fix?: string;
}

export interface EfficiencyScanPointer {
  type: "efficiency_scan";
  /** Endpoints to probe (path under METABOB_ENDPOINT). Defaults to the known hot list endpoint. */
  probes?: Probe[];
  /** Latency at/above this (ms) — or a failed request — opens an inefficiency gap. Default 5000. */
  latency_threshold_ms?: number;
  /** If true, emit a substrateGap(performance_inefficiency) for each slow/failed probe. */
  emit_gap?: boolean;
}

// The hot endpoint diagnosed live 2026-06-28: the autonomous loop hammers
// execution-traces with limit=300/500, each materialising hundreds of LARGE trace
// documents (SurrealDB loads whole records; tasks/impulse_resolutions/metadata bloat
// each) AND compares the indexed datetime executed_at against a STRING param
// (defeating the index). Probe it at the representative limit so the real latency shows.
const DEFAULT_PROBES: Probe[] = [
  {
    name: "execution_traces_list",
    path: "/v2/activities/execution-traces?limit=200",
    edit_site: "repos/activity-api/src/routes/execution-traces.ts",
    proposed_fix:
      "The execution-traces LIST query is slow because it materialises hundreds of large trace "
      + "documents and compares the INDEXED datetime field `executed_at` against a STRING `$start_date` "
      + "param, which defeats the index. Two bounded, backward-compatible fixes: (1) wrap the date param "
      + "as `executed_at >= type::datetime($start_date)` so the index engages; (2) clamp the list `limit` "
      + "to a sane maximum (e.g. 100) for this list view so a single request never loads 300-500 full "
      + "documents. Do NOT change the JSON response field contract.",
  },
];

export async function resolveEfficiencyScan(pointer: EfficiencyScanPointer): Promise<ResolverResult> {
  const probes = pointer.probes ?? DEFAULT_PROBES;
  const threshold = pointer.latency_threshold_ms ?? 5000;
  const results: Array<{ name: string; path: string; latency_ms: number; ok: boolean; slow: boolean }> = [];
  let gapsEmitted = 0;

  for (const p of probes) {
    const start = Date.now();
    let ok = false;
    try {
      const res = await fetch(`${METABOB_ENDPOINT}${p.path}`, {
        headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
        signal: AbortSignal.timeout(30_000),
      });
      ok = res.ok;
      await res.text().catch(() => ""); // drain the body so the timing reflects full transfer
    } catch {
      ok = false;
    }
    const latency = Date.now() - start;
    const slow = latency >= threshold || !ok;
    results.push({ name: p.name, path: p.path, latency_ms: latency, ok, slow });

    if (pointer.emit_gap && slow) {
      const gapId = `performance-inefficiency-${p.name}`.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
      const summary = `Internal endpoint "${p.name}" (${p.path}) is inefficient: ${latency}ms`
        + (ok ? "" : " (request failed/timed out)")
        + ` >= threshold ${threshold}ms — author a fix so the substrate manages this load efficiently.`;
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: gapId,
            category: "performance_inefficiency",
            source: "substrate_detected",
            summary,
            detected_at: new Date().toISOString(),
            status: "open",
            classification_metadata: {
              probe: p.name,
              path: p.path,
              measured_latency_ms: latency,
              threshold_ms: threshold,
              request_ok: ok,
              edit_site: p.edit_site ?? null,
              proposed_fix: p.proposed_fix ?? null,
            },
          },
        });
        gapsEmitted++;
      } catch {
        /* best-effort: a failed gap-write must not break the scan */
      }
    }
  }

  return {
    shape: "efficiencyScanReport",
    body: {
      probes_run: results.length,
      slow_probes: results.filter((r) => r.slow).length,
      gaps_emitted: gapsEmitted,
      latency_threshold_ms: threshold,
      results,
      generated_at: new Date().toISOString(),
    },
  };
}
