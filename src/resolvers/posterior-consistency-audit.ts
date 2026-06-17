import type { ResolverResult } from "./types.js";

/**
 * posterior_consistency_audit — cross-check claimed Thompson α/β vs empirical
 * trace counts. Emits substrateGap (category=posterior_consistency_drift) when
 * posterior means drift > threshold. Catches stale posteriors that
 * trace_outcome_validity_audit won't flag.
 */

const DEFAULT_METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface PosteriorConsistencyAuditPointer {
  type: "posterior_consistency_audit";
  drift_threshold?: number;
  min_samples?: number;
  emit_gap?: boolean;
  template_limit?: number;
  trace_limit?: number;
  metabobEndpoint?: string;
  devVesselImpulsesUrl?: string;
}

interface TemplateMetric {
  id?: string;
  template_id?: string;
  metrics?: { thompson_alpha?: number; thompson_beta?: number };
  thompson_alpha?: number;
  thompson_beta?: number;
}

interface DriftedCell {
  activity_id: string;
  claimed_alpha: number;
  claimed_beta: number;
  claimed_mean: number;
  empirical_alpha: number;
  empirical_beta: number;
  empirical_mean: number;
  drift: number;
}

const strip = (id: string) => id.replace(/^activity:⟨/, "").replace(/⟩$/, "");

async function fetchJson<T>(url: string, apiKey: string): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch { return null; }
}

async function emitGap(emitUrl: string, apiKey: string, cells: DriftedCell[]): Promise<{ ok: boolean; status: number | "error" }> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `posterior-drift-${Date.now()}`,
          category: "posterior_consistency_drift",
          source: "substrate_detected",
          summary: `${cells.length} activity_metrics cells have Thompson posterior means drifting from empirical trace counts > threshold. Stale posteriors cause Thompson Sampling + momentum to allocate traffic based on outdated belief.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "posterior_consistency_audit",
            cite_principle: "outcomes_must_reflect_substantive_work",
            drifted_cells: cells.slice(0, 10),
            suggested_remediation: "Verify trace ingestion writes posterior deltas atomically; check trace_outcome_inconsistency clusters; if persistent, re-derive posteriors from traces.",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { ok: resp.ok, status: resp.status };
  } catch { return { ok: false, status: "error" }; }
}

export async function resolvePosteriorConsistencyAudit(pointer: PosteriorConsistencyAuditPointer): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? DEFAULT_METABOB_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const drift_threshold = pointer.drift_threshold ?? 0.20;
  const min_samples = pointer.min_samples ?? 10;
  const emit = pointer.emit_gap !== false;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  // Paginate the FULL template registry. The endpoint caps page size at ~100,
  // so a single large `limit` silently returns only the first page — this audit
  // is the substrate's forward-model-vs-reality calibration check (stored
  // Thompson posterior vs empirical trace counts), so it must examine EVERY
  // template's posterior, not just the first 100. Loop on offset until `total`
  // is reached or a page comes back empty.
  const pageSize = 100;
  const templates: TemplateMetric[] = [];
  let templateTotal: number | null = null;
  let offset = 0;
  for (let guard = 0; guard < 200; guard++) {
    const page = await fetchJson<{ templates?: TemplateMetric[]; data?: TemplateMetric[]; total?: number }>(
      `${endpoint}/v2/activities/templates?limit=${pageSize}&offset=${offset}`,
      apiKey,
    );
    if (!page) break;
    if (typeof page.total === "number") templateTotal = page.total;
    const rows = page.templates ?? page.data ?? [];
    if (rows.length === 0) break;
    templates.push(...rows);
    offset += rows.length;
    if (templateTotal !== null && templates.length >= templateTotal) break;
  }
  const trJson = await fetchJson<{ executions?: Array<{ activity_id?: string; status?: string }> }>(
    `${endpoint}/v2/activities/execution-traces?limit=${pointer.trace_limit ?? 500}`,
    apiKey,
  );
  const traces = trJson?.executions ?? [];

  const empirical = new Map<string, { alpha: number; beta: number }>();
  for (const t of traces) {
    const aid = strip(String(t.activity_id ?? ""));
    if (!aid) continue;
    const cell = empirical.get(aid) ?? { alpha: 0, beta: 0 };
    if (t.status === "success" || t.status === "completed") cell.alpha += 1;
    else if (t.status === "failure" || t.status === "failed") cell.beta += 1;
    empirical.set(aid, cell);
  }

  const drifted: DriftedCell[] = [];
  for (const tpl of templates) {
    const aid = strip(String(tpl.id ?? tpl.template_id ?? ""));
    if (!aid) continue;
    const a = tpl.metrics?.thompson_alpha ?? tpl.thompson_alpha ?? 1;
    const b = tpl.metrics?.thompson_beta ?? tpl.thompson_beta ?? 1;
    const claimed_mean = a / (a + b);
    const emp = empirical.get(aid);
    if (!emp) continue;
    const samples = emp.alpha + emp.beta;
    if (samples < min_samples) continue;
    const empirical_mean = (emp.alpha + 1) / (samples + 2);
    const drift = Math.abs(claimed_mean - empirical_mean);
    if (drift > drift_threshold) {
      drifted.push({ activity_id: aid, claimed_alpha: a, claimed_beta: b, claimed_mean, empirical_alpha: emp.alpha, empirical_beta: emp.beta, empirical_mean, drift });
    }
  }

  let gaps_emitted = 0;
  let emission_status: number | "error" | null = null;
  if (emit && drifted.length > 0) {
    const r = await emitGap(emitUrl, apiKey, drifted);
    emission_status = r.status;
    if (r.ok) gaps_emitted = 1;
  }

  return {
    shape: "posteriorConsistencyResult",
    body: {
      templates_examined: templates.length,
      template_total: templateTotal,
      audit_coverage_fraction: templateTotal && templateTotal > 0 ? Number((templates.length / templateTotal).toFixed(3)) : null,
      traces_examined: traces.length,
      drift_threshold,
      min_samples,
      drifted_cells: drifted,
      gaps_emitted,
      emission_status,
      completed_at: new Date().toISOString(),
    },
  };
}
