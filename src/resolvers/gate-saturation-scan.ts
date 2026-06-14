import type { ResolverResult } from "./types.js";
import { resolveResolverPatternReport } from "./resolver-pattern-report.js";

/**
 * gate_saturation_scan — deterministic detector for gate/filter resolvers that
 * return the same verdict for ~all inputs (saturation).
 *
 * Meta-detector for the bug class where comprehensibility_check scored 0.000 on
 * EVERY authored chain (the 0.6 Jaccard floor was unreachable), silently
 * rejecting 100% of inputs while looking like it "ran". A gate that never lets
 * anything through is broken, not strict — and nothing watched for it.
 *
 * Signal: consume resolver_pattern_report (per-(resolver_id, output_shape)
 * success_rate over a window). A gate-like resolver whose success_rate is at or
 * below `min_pass_rate` over at least `min_volume` samples is saturated-failing.
 * "Gate-like" is a configurable id regex (check/gate/valid/verify/comprehensib/
 * filter/guard/saturat) so ordinary resolvers that legitimately fail aren't
 * implicated. One substrateGap_write per saturated cell
 * (gap_subtype=gate_saturation) routes the fix into the gap → bridge → drafter
 * loop so the next instance self-completes.
 *
 * Mirrors stale_pointer_emit / phantom_trace_scan: one server-side resolver,
 * deterministic filter, conditional emit-per-finding, no LLM. Reuses the
 * existing resolver_pattern_report aggregation rather than re-scanning traces.
 */

export interface GateSaturationScanPointer {
  type: "gate_saturation_scan";
  /** Lookback window for the underlying pattern report. Default 86400 (24h). */
  lookbackWindowSeconds?: number;
  /** A cell is saturated-failing when success_rate <= this. Default 0.05. */
  minPassRate?: number;
  /** Minimum sample count before a cell can be flagged. Default 8. */
  minVolume?: number;
  /** Regex matched against resolver_id to scope to gate/filter resolvers. */
  gateIdPattern?: string;
  /** Override dev-vessel impulses URL (self-POST). */
  devVesselImpulsesUrl?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation. Default 25. */
  maxEmits?: number;
  /** Test hook: use these rows instead of calling resolver_pattern_report. */
  _rows?: PatternRow[];
}

interface PatternRow {
  resolver_id?: unknown;
  output_shape?: unknown;
  count?: unknown;
  success_count?: unknown;
  success_rate?: unknown;
}

interface SaturationFinding {
  resolver_id: string;
  output_shape: string;
  count: number;
  success_rate: number;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
}

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_GATE_ID_PATTERN = "check|gate|valid|verify|comprehensib|filter|guard|saturat";
const DEFAULT_MIN_PASS_RATE = 0.05;
const DEFAULT_MIN_VOLUME = 8;
const DEFAULT_MAX_EMITS = 25;

export async function resolveGateSaturationScan(
  pointer: GateSaturationScanPointer,
): Promise<ResolverResult> {
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;
  const minPassRate = pointer.minPassRate ?? DEFAULT_MIN_PASS_RATE;
  const minVolume = pointer.minVolume ?? DEFAULT_MIN_VOLUME;
  let gateRe: RegExp;
  try { gateRe = new RegExp(pointer.gateIdPattern ?? DEFAULT_GATE_ID_PATTERN, "i"); }
  catch { gateRe = new RegExp(DEFAULT_GATE_ID_PATTERN, "i"); }

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  // 1. Obtain per-(resolver, shape) success rates.
  let rows: PatternRow[] = [];
  if (pointer._rows) {
    rows = pointer._rows;
  } else {
    const report = await resolveResolverPatternReport({
      type: "resolver_pattern_report",
      lookback_window_seconds: pointer.lookbackWindowSeconds,
      min_count: minVolume,
    });
    const body = (report.body ?? {}) as { rows?: unknown };
    if (Array.isArray(body.rows)) rows = body.rows as PatternRow[];
    else return { shape: "structuredError", body: { resolver: "gate_saturation_scan", detail: "resolver_pattern_report returned no rows" } };
  }

  // 2. Flag gate-like cells that are saturated-failing.
  const findings: SaturationFinding[] = [];
  let evaluated = 0;
  for (const r of rows) {
    const resolverId = typeof r.resolver_id === "string" ? r.resolver_id : "";
    const outputShape = typeof r.output_shape === "string" ? r.output_shape : "";
    const count = typeof r.count === "number" ? r.count : 0;
    const successRate = typeof r.success_rate === "number" ? r.success_rate : 1;
    if (!resolverId) continue;
    if (!gateRe.test(resolverId)) continue;
    evaluated += 1;
    if (count < minVolume) continue;
    if (successRate > minPassRate) continue;
    findings.push({
      resolver_id: resolverId,
      output_shape: outputShape,
      count,
      success_rate: successRate,
      gap_id: `gate-saturation-${resolverId}-${outputShape}`.replace(/[^a-zA-Z0-9._-]/g, "_"),
      posted: false,
    });
    if (findings.length >= maxEmits) break;
  }

  // 3. Emit one substrateGap per saturated gate cell (unless dry_run).
  if (!dryRun) {
    for (const f of findings) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: f.gap_id,
              category: "detector_output_shape_mismatch",
              source: "substrate_detected",
              summary:
                `Gate resolver '${f.resolver_id}' (→ ${f.output_shape}) is saturated-failing: ` +
                `success_rate=${f.success_rate.toFixed(3)} over ${f.count} samples (≤ ${minPassRate}). ` +
                `A gate that rejects ~everything is broken, not strict — the class that made ` +
                `comprehensibility_check score 0.000 on every authored chain.`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "gate_saturation",
                resolver_id: f.resolver_id,
                output_shape: f.output_shape,
                success_rate: f.success_rate,
                sample_count: f.count,
                min_pass_rate: minPassRate,
                remediation_hint:
                  "Inspect the gate's threshold/metric calibration (e.g. a Jaccard floor set to a " +
                  "semantic-cosine target) or an input-parsing bug that empties its comparison side. " +
                  "Mirrors the comprehensibility_check string-parse + floor fix.",
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        f.post_status = resp.status;
        f.posted = resp.ok;
      } catch {
        f.post_status = "error";
      }
    }
  }

  return {
    shape: "gateSaturationReport",
    body: {
      gate_cells_evaluated: evaluated,
      finding_count: findings.length,
      findings,
      min_pass_rate: minPassRate,
      min_volume: minVolume,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
