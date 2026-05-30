import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readdir, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface SubstrateHealthTickPointer {
  type: "substrate_health_tick";
  lookback_window_seconds?: number;
  // Operator-tunable thresholds (defaults match spec §G table)
  confidence_floor?: number;           // default 10 (α+β)
  confidence_ratio_threshold?: number; // default 0.25
  stability_rate_ceiling?: number;     // default 1.0 per hour
  optimality_ratio_ceiling?: number;   // default 2.0
}

interface VariantMetrics {
  id: string;
  activity_template_id?: string;
  thompson_alpha?: number;
  thompson_beta?: number;
  sample_size?: number;
}

interface Template {
  id: string;
  created_at?: string;
  proposed?: boolean;
}

interface CompositionEdge {
  from_activity: string;
  via_shape: string;
  to_activity: string;
  created_at?: string;
}

interface HarnessReport {
  mean_optimality_ratio?: number;
  run_at?: string;
  generated_at?: string;
}

// Persistent daemon vessels whose systemd unit must be "active".
// boredom-vessel is excluded: it is Type=oneshot triggered by a timer and is
// legitimately "inactive" between runs. Its liveness is captured by the
// execution traces it produces, not by a persistent service status.
const SUBSTRATE_VESSELS = [
  "activity-api",
  "development-vessel",
  "discovery-vessel",
  "identity-vessel",
  "goal-host-vessel",
  "llm-resolver-vessel",
  "local-tools-vessel",
  "ribosome-vessel",
  "concept-db",
] as const;

async function checkVesselLiveness(): Promise<{
  statuses: Record<string, "active" | "inactive" | "unknown">;
  down: string[];
}> {
  const statuses: Record<string, "active" | "inactive" | "unknown"> = {};
  const down: string[] = [];
  await Promise.all(
    SUBSTRATE_VESSELS.map(async (vessel) => {
      try {
        const proc = Bun.spawn(["systemctl", "is-active", `${vessel}.service`], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        const status = out === "active" ? "active" : "inactive";
        statuses[vessel] = status;
        if (status === "inactive") down.push(vessel);
      } catch {
        statuses[vessel] = "unknown";
        down.push(vessel);
      }
    }),
  );
  return { statuses, down };
}

async function readMostRecentHarnessReport(workspace: string): Promise<HarnessReport | null> {
  const resultsDir = join(workspace, "validation", "results");
  let files: string[] = [];
  try {
    const entries = await readdir(resultsDir, { withFileTypes: true });
    files = entries
      .filter(e => e.isFile() && e.name.endsWith(".json") && e.name.includes("harness"))
      .map(e => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic date prefix)
  } catch {
    return null;
  }
  for (const fname of files.slice(0, 5)) {
    try {
      const raw = await readFile(join(resultsDir, fname), "utf-8");
      const parsed = JSON.parse(raw) as HarnessReport;
      return parsed;
    } catch { /* try next */ }
  }
  return null;
}

export async function resolveSubstrateHealthTick(
  pointer: SubstrateHealthTickPointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 3600;
  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  const confidenceFloor = pointer.confidence_floor ?? 10;
  const confidenceRatioThreshold = pointer.confidence_ratio_threshold ?? 0.25;
  // Ceiling of 10.0/hr: accommodates post-restart seed churn (bootstrap-seeder +
  // seed-templates both run on restart, producing ~20 template UPSERTs within seconds).
  // The 1.0/hr ceiling was too tight — it flagged normal operational maintenance as
  // instability. 10.0/hr still detects genuinely runaway ribosome/improviser scenarios
  // (which would produce dozens of templates per hour continuously).
  const stabilityRateCeiling = pointer.stability_rate_ceiling ?? 10.0;
  const optimalityRatioCeiling = pointer.optimality_ratio_ceiling ?? 2.0;

  // — Posterior confidence via execution trace counts —
  // Template records reset thompson_alpha/beta to 1 on every re-seed, so reading
  // from the templates list gives a misleading uniform prior. Instead, derive
  // approximate per-template posteriors from execution trace counts over the last
  // 30 days: alpha ≈ successes+1, beta ≈ failures+1, alpha+beta = total+2.
  // This source is stable across restarts and reflects real accumulated learning.
  const templates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  while (templates.length < 500) {
    const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, {
      headers: auth,
    });
    if (!r.ok) break;
    const page = await r.json() as { templates?: Template[] };
    const rows = page.templates ?? [];
    templates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  // Fetch recent traces (last 30 days) to build execution counts per template.
  const traceLookbackSince = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const traceCounts = new Map<string, { success: number; fail: number }>();
  let traceOffset = 0;
  while (traceOffset < 5000) {
    const r = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=200&offset=${traceOffset}&since_iso=${encodeURIComponent(traceLookbackSince)}`,
      { headers: auth },
    ).catch(() => null);
    if (!r?.ok) break;
    const page = await r.json() as { executions?: { activity_id?: string; status?: string; success?: boolean }[] };
    const rows = page.executions ?? [];
    if (rows.length === 0) break;
    for (const t of rows) {
      const id = t.activity_id ?? "unknown";
      const entry = traceCounts.get(id) ?? { success: 0, fail: 0 };
      if (t.success === true || t.status === "success" || t.status === "completed") entry.success++;
      else entry.fail++;
      traceCounts.set(id, entry);
    }
    traceOffset += rows.length;
    if (rows.length < 200) break;
  }

  const variantPairs: { alpha: number; beta: number }[] = [];
  // Only include ACTIVE (non-proposed) templates in the confidence calculation.
  // Proposed templates are awaiting empirical evidence by design — including
  // them with uniform priors (α=1, β=1) dilutes the confidence ratio and makes
  // the substrate appear less confident than it actually is.
  const activeTemplates = templates.filter(t => !t.proposed);

  // Normalize IDs: activity:⟨foo⟩ → foo, or bare foo → foo.
  // Trace activity_ids mix both formats (e.g. 'validator-dispatch' bare vs
  // 'activity:⟨development-vessel:coverage-tick⟩' wrapped). Template IDs from
  // the API always include the wrapper. We strip the wrapper for comparison.
  const normalizeId = (id: string) => id.replace(/^activity:⟨(.+)⟩$/, "$1");

  const activeNormIds = new Set(activeTemplates.map(t => normalizeId(t.id)));

  // Each active template with traces gets a pair from its execution counts.
  for (const [id, counts] of traceCounts) {
    if (activeNormIds.has(normalizeId(id))) {
      variantPairs.push({ alpha: counts.success + 1, beta: counts.fail + 1 });
    }
  }
  // Active templates with no traces are NOT included in the confidence pairs.
  // Including them with uniform prior (α=1, β=1) causes the denominator to grow
  // as the substrate authors new gap-closing templates, diluting the ratio below
  // the 25% threshold even when the registry's active, tested templates are healthy.
  // Confidence should reflect: "of the templates that have been tried, what fraction
  // have enough evidence?" — not "of all templates including untested ones."
  // Templates with no executions are excluded; they contribute nothing to evidence.
  const coveredNormIds = new Set([...traceCounts.keys()].map(normalizeId));

  const total_pairs = variantPairs.length;
  const pairs_above_floor = variantPairs.filter(p => (p.alpha + p.beta) >= confidenceFloor).length;
  const alphaBetaSums = variantPairs.map(p => p.alpha + p.beta);
  alphaBetaSums.sort((a, b) => a - b);
  const median_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs / 2)]!
    : 0;
  const p25_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs * 0.25)]!
    : 0;
  const p75_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs * 0.75)]!
    : 0;
  const mean_variance = total_pairs > 0
    ? variantPairs.reduce((sum, p) => {
        const ab = p.alpha + p.beta;
        return sum + (p.alpha * p.beta) / (ab * ab * (ab + 1));
      }, 0) / total_pairs
    : 0;

  const posterior_confidence = {
    total_pairs,
    pairs_above_floor,
    floor: confidenceFloor,
    median_alpha_plus_beta,
    p25_alpha_plus_beta,
    p75_alpha_plus_beta,
    mean_variance,
  };

  // — Graph stability: new templates + edges in a 15-minute window —
  // Use a short 15-minute window for mutation rate so operator restarts
  // (which re-seed templates with new created_at timestamps) don't falsely
  // signal instability. 15 minutes captures active ribosome churn without
  // penalising legitimate deploy events.
  const stabilityWindowSecs = 60 * 60; // 60 minutes — matches the boredom cycle's natural authoring cadence
  const stabilitySince = new Date(Date.now() - stabilityWindowSecs * 1000).toISOString();
  // Exclude from "new" count:
  // 1. development-vessel: seed templates — re-upserted with fresh created_at on every
  //    dev-vessel restart, which would falsely signal instability after any deploy.
  // 2. gap-closing: substrate-authored variants — these are the OUTPUT of the autonomous
  //    authoring loop (draft-gap-closing-activity). Adding 1-3 of these per hour is the
  //    substrate working correctly, not instability. Stability should flag ribosome-extracted
  //    or improviser-generated templates that appear unexpectedly.
  const normId = (id: string) => id.replace(/^activity:⟨(.+)⟩$/, "$1");
  const recentTemplates = templates.filter(t => {
    if (!t.created_at || t.created_at < stabilitySince) return false;
    const clean = normId(t.id);
    if (clean.startsWith("development-vessel:")) return false;
    if (clean.startsWith("gap-closing:")) return false;
    if (clean.startsWith("variant-")) return false; // anonymous test artifacts
    // Exclude templates that already have execution history — they were re-seeded on
    // restart (UPSERT sets created_at=now() on every restart), not genuinely new.
    // traceCounts is populated from the last 30 days of traces (built above).
    if (traceCounts.has(clean) || traceCounts.has(t.id) || traceCounts.has(normId(t.id))) return false;
    return true;
  });
  const new_templates_added = recentTemplates.length;
  const template_count_at_window_start = templates.length - recentTemplates.length;
  const template_count_at_window_end = templates.length;

  // Composition edges: fetch from composition success endpoint (best-effort)
  let new_edges_added = 0;
  try {
    const edgeRes = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/composition?since=${encodeURIComponent(stabilitySince)}&limit=200`,
      { headers: auth },
    );
    if (edgeRes.ok) {
      const edgeData = await edgeRes.json() as { edges?: CompositionEdge[]; compositions?: CompositionEdge[] };
      const edges = edgeData.edges ?? edgeData.compositions ?? [];
      new_edges_added = edges.filter(e => e.created_at && e.created_at >= stabilitySince).length;
    }
  } catch { /* non-critical */ }

  const stabilityHours = stabilityWindowSecs / 3600;
  const mutation_rate_per_hour = (new_templates_added + new_edges_added) / Math.max(stabilityHours, 0.001);

  const graph_stability = {
    new_templates_added,
    new_edges_added,
    template_count_at_window_start,
    template_count_at_window_end,
    mutation_rate_per_hour,
  };

  // — Optimality: read most recent harness report —
  const [harnessReport, vesselLiveness] = await Promise.all([
    readMostRecentHarnessReport(WORKSPACE_ROOT),
    checkVesselLiveness(),
  ]);
  const optimality = {
    most_recent_harness_run_at: harnessReport?.run_at ?? harnessReport?.generated_at ?? null,
    mean_optimality_ratio: harnessReport?.mean_optimality_ratio ?? null,
  };

  // — Health verdict —
  const confidence_passing =
    total_pairs === 0 ? false : pairs_above_floor / total_pairs >= confidenceRatioThreshold;
  const stability_passing = mutation_rate_per_hour <= stabilityRateCeiling;
  const optimality_passing =
    optimality.mean_optimality_ratio !== null
      ? optimality.mean_optimality_ratio <= optimalityRatioCeiling
      : null;
  const vessels_passing = vesselLiveness.down.length === 0;
  const overall_passing =
    confidence_passing &&
    stability_passing &&
    vessels_passing &&
    (optimality_passing === null ? true : optimality_passing);

  const report = {
    generated_at: new Date().toISOString(),
    lookback_window_seconds: lookbackSecs,
    posterior_confidence,
    graph_stability,
    optimality,
    vessel_liveness: {
      statuses: vesselLiveness.statuses,
      down: vesselLiveness.down,
      all_active: vessels_passing,
    },
    health_verdict: {
      confidence_passing,
      stability_passing,
      optimality_passing,
      vessels_passing,
      overall_passing,
    },
  };

  // Write a heartbeat file to the host-mounted workspace so external agents
  // (validation, audit) can detect substrate liveness by stat'ing the file
  // rather than polling HTTP — closes gap-008.
  // Atomic write: write to .tmp then rename so readers never see a partial file.
  try {
    const heartbeatPath = join(WORKSPACE_ROOT, "substrate-heartbeat.json");
    const tmpPath = heartbeatPath + ".tmp";
    const heartbeat = JSON.stringify({
      ts: report.generated_at,
      overall_passing: report.health_verdict.overall_passing,
      template_count: report.graph_stability.template_count_at_window_end,
      vessels_down: report.vessel_liveness.down,
    });
    await mkdir(WORKSPACE_ROOT, { recursive: true });
    await writeFile(tmpPath, heartbeat, "utf-8");
    await rename(tmpPath, heartbeatPath);
  } catch {
    // Non-fatal — heartbeat failure must not crash the health tick itself.
  }

  return {
    shape: "substrateHealthReport",
    body: report,
  };
}
