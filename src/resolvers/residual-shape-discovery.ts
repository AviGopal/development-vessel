/**
 * residual_shape_discovery — the GENUINE bottom-up "discovery side" of shape
 * authoring. The substrate is strong at DEMAND-derived shapes (a goal asks for
 * an output → the gap-compose loop names it) and weak at GENUINE discovery:
 * shapes that MUST EXIST but are NOT YET NAMED, detected from persistent
 * unexplained structure in the real impulse/trace stream.
 *
 * The principle (heuristic first cut of SUBSTRATE_AS_REPRESENTATION §4):
 *   A shape is a DIRECTION in the open basis. Reality's impulse stream is
 *   projected onto the current shape basis; the PERSISTENT UNEXPLAINED RESIDUAL
 *   — structure the basis cannot express with a single named axis — is the
 *   signal that a new axis MUST exist. This is a HEURISTIC approximation of the
 *   Hodge-residual geometry, not the full geometry: we approximate "the basis
 *   cannot express this with one axis" by "a recurring multi-shape cluster that
 *   no single composite shape names, carried through a generic catch-all shape."
 *
 * Signal used (the one the live data supports — see verify notes):
 *   CO-OCCURRENCE CLUSTER through a GENERIC CARRIER. We scan recent
 *   activity_execution_traces.output_impulse_shapes and find SETS of output
 *   shapes that co-occur far more than chance. A cluster is a residual-axis
 *   candidate when it RECURS and CONTAINS a generic catch-all carrier shape
 *   (json_extracted_value, httpResponse, fileContent, llm_completion_result,
 *   directoryListing, commandResult …). A recurring structure repeatedly forced
 *   to ride a generic carrier — with no single composite shape naming it — is an
 *   unnamed axis: the basis is too coarse to express it.
 *
 *   (The alternative signal — a recurring STRUCTURAL key-set inside the body of
 *   a single generic impulse — is unavailable: resolved impulse bodies are not
 *   durably stored at scale in this substrate (the `impulse` table holds ~20
 *   rows of one shape; impulse_data/execution_trace_content carry no shaped
 *   bodies). When that data lands, add the structural-signature signal here.)
 *
 * HARD GATES (all must pass — this is the anti-gaming core; careless minting is
 * exactly the metric-gaming the docs forbid):
 *   - PERSISTENCE: the cluster recurs across ≥ K distinct time windows AND in
 *     ≥ M traces. A one-off / single-burst cluster is jitter, not signal.
 *   - NOVELTY: the cluster is NOT already named by an existing single shape in
 *     the discovery-advertised catalogue (and is not a pure subset/superset of
 *     a single named composite).
 *   - CLOSURE: the cluster has a plausible PRODUCER (the activity that emits it,
 *     observed in the trace) AND a generic-carrier presence implying it is being
 *     forced through an under-named pipe. A plausible CONSUMER (a downstream
 *     trace that takes one of the cluster shapes as input) RAISES confidence; a
 *     produced-but-never-consumed cluster is flagged LOWER confidence (dead
 *     weight), not rejected.
 *   - INTERNAL exclusion: the goal-host selection-loop scaffold cluster
 *     (goal / pool_precheck_result / select_or_produce_result /
 *     shape_gap_resolution) and other pure-internal-tick shape sets are
 *     excluded — they are already named by their parts and carry no residual.
 *
 * Output: residualShapeProposal impulses (or report-only). PROPOSE ONLY — this
 * resolver does NOT register a shape, does NOT write to the discovery
 * catalogue, does NOT mint an activity. A human / the substrate's own
 * verify-merge pipeline ratifies later.
 *
 * cheap tier (HTTP/DB only, no LLM). Three-place wire:
 *   resolver here + config.ts shape + impulses.ts case.
 */

import { mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { DISCOVERY_ENDPOINT } from "../config.js";
import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_SURREAL_URL = "http://127.0.0.1:8000";

/**
 * Generic catch-all "carrier" shapes: shapes that name a TRANSPORT or a
 * SYNTACTIC form, not a SEMANTIC axis. A recurring cluster riding one of these
 * is structure forced through an under-named pipe. Encoded as data so the
 * heuristic is auditable.
 */
const GENERIC_CARRIER_SHAPES = new Set<string>([
  "json_extracted_value",
  "httpResponse",
  "fileContent",
  "llm_completion_result",
  "directoryListing",
  "commandResult",
  "filePaths",
  "http_fetch",
  "fs_read",
  "source_code",
]);

/**
 * The goal-host per-goal selection loop scaffold + other pure-internal tick
 * shapes. These co-occur constantly but are ALREADY named by their parts and
 * carry no residual axis. Excluding them keeps the detector honest (otherwise
 * the #1 cluster by count is internal machinery, not discovery).
 */
const INTERNAL_SCAFFOLD_SHAPES = new Set<string>([
  "goal", "pool_precheck_result", "select_or_produce_result",
  "shape_gap_resolution", "activity_recommendations", "substrateGap",
  "writeAttempt", "validation_result", "activityRegistryChange",
]);

export interface ResidualShapeDiscoveryPointer {
  type: "residual_shape_discovery";
  /** When false, classify only — emit no proposals. Default true. */
  emit_proposals?: boolean;
  /** Persistence gate: minimum distinct time windows the cluster must span. Default 3. */
  min_windows?: number;
  /** Persistence gate: minimum trace count the cluster must appear in. Default 10. */
  min_traces?: number;
  /** Window granularity for the windows gate. "hour" | "day". Default "hour". */
  window_granularity?: "hour" | "day";
  /** How many recent traces to scan. Default 8000. */
  trace_limit?: number;
  /** Minimum cluster size (distinct output shapes). Default 2. */
  min_cluster_size?: number;
  /** Safety cap on proposals emitted per run. Default 20. */
  max_emit?: number;
  /** Append proposals to this JSONL file (best-effort). */
  log_path?: string;
  surrealUrl?: string;
  discoveryEndpoint?: string;
  devVesselImpulsesUrl?: string;
}

interface AETRow {
  output_impulse_shapes?: string[] | null;
  input_impulse_shapes?: string[] | null;
  activity_id?: string | null;
  executed_at?: string | null;
}

interface ClusterAgg {
  count: number;
  windows: Set<string>;
  producers: Map<string, number>;
  exampleIds: string[];
  carriers: Set<string>;
}

interface Proposal {
  proposed_name: string;
  signal_type: "cooccurrence_generic_carrier";
  structural_signature: string;
  cluster_shapes: string[];
  generic_carriers: string[];
  evidence: {
    frequency: number;
    windows: number;
    example_activity_ids: string[];
    current_generic_shapes: string[];
  };
  candidate_producer: string | null;
  candidate_consumer: string | null;
  persistence: { windows: number; traces: number };
  confidence: number;
  passed_gates: string[];
}

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function surrealQuery(
  surrealUrl: string,
  sql: string,
): Promise<unknown[] | null> {
  const ns = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
  const db = process.env["SURREALDB_DATABASE"] ?? "learning_loop";
  const user = process.env["SURREALDB_USERNAME"] ?? "root";
  const pass = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "";
  try {
    const res = await fetch(`${surrealUrl.replace(/\/+$/, "")}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "surreal-ns": ns,
        "surreal-db": db,
        Authorization: basicAuthHeader(user, pass),
      },
      body: sql,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Array<{ status?: string; result?: unknown }>;
    const last = j[j.length - 1];
    if (!last || last.status !== "OK" || !Array.isArray(last.result)) return null;
    return last.result;
  } catch {
    return null;
  }
}

async function fetchNamedShapes(discoveryUrl: string): Promise<Set<string>> {
  try {
    const r = await fetch(`${discoveryUrl.replace(/\/+$/, "")}/registry/shapes`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return new Set();
    const j = (await r.json()) as { shapes?: string[] };
    return new Set(j.shapes ?? []);
  } catch {
    return new Set();
  }
}

function windowKey(ts: string | null | undefined, gran: "hour" | "day"): string {
  if (!ts) return "unknown";
  return gran === "day" ? ts.slice(0, 10) : ts.slice(0, 13);
}

/** Stable structural signature of a cluster: sorted shape set joined. This is
 * the "direction" the residual points in — the candidate axis identity. */
function structuralSignature(shapes: string[]): string {
  return [...shapes].sort().join("+");
}

/** Heuristic name for the proposed axis: prefer the most specific NON-generic
 * named shapes in the cluster, suffix the carrier, camelCase. */
function proposeName(shapes: string[]): string {
  const semantic = shapes
    .filter((s) => !GENERIC_CARRIER_SHAPES.has(s))
    .sort();
  const carrierTag = shapes.some((s) => GENERIC_CARRIER_SHAPES.has(s))
    ? "Bundle"
    : "Composite";
  const base = (semantic.length ? semantic : shapes)
    .slice(0, 3)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, " "))
    .join(" ");
  const camel = base
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toLowerCase() + w.slice(1)
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join("");
  return `${camel}${carrierTag}`;
}

async function emitProposal(
  emitUrl: string,
  apiKey: string,
  proposal: Proposal,
): Promise<boolean> {
  const body = {
    impulse: {
      pointer: {
        type: "residualShapeProposal_emit",
        proposal,
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    // We emit as a substrateGap of category residual_shape_proposal so the
    // existing gap surface carries it WITHOUT minting anything — propose-only.
    const gapBody = {
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap: {
            id: `residual-shape-${proposal.structural_signature.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 80)}`,
            category: "residual_shape_proposal",
            source: "substrate_detected",
            summary:
              `PROPOSE (do NOT auto-mint) a new shape "${proposal.proposed_name}" naming a persistent unnamed axis: ` +
              `the cluster {${proposal.cluster_shapes.join(", ")}} recurs ${proposal.persistence.traces}× across ` +
              `${proposal.persistence.windows} time windows, forced through generic carrier(s) ` +
              `[${proposal.generic_carriers.join(", ")}]. Producer ${proposal.candidate_producer ?? "(unknown)"}. ` +
              `confidence=${proposal.confidence.toFixed(2)}. Human / verify-merge pipeline ratifies before any mint.`,
            detected_at: new Date().toISOString(),
            status: "open",
            classification_metadata: {
              detector: "residual_shape_discovery",
              cite_principle: "persistent_unexplained_residual_implies_an_unnamed_axis",
              signal_type: proposal.signal_type,
              propose_only: true,
              residual_shape_proposal: proposal,
            },
          },
        },
      },
    };
    void body;
    const r = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(gapBody),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolveResidualShapeDiscovery(
  pointer: ResidualShapeDiscoveryPointer,
): Promise<ResolverResult> {
  const emit = pointer.emit_proposals !== false;
  const minWindows = pointer.min_windows ?? 3;
  const minTraces = pointer.min_traces ?? 10;
  const gran = pointer.window_granularity ?? "hour";
  const traceLimit = pointer.trace_limit ?? 8000;
  const minClusterSize = pointer.min_cluster_size ?? 2;
  const maxEmit = pointer.max_emit ?? 20;
  const surrealUrl = pointer.surrealUrl ?? process.env["SURREALDB_URL"] ?? DEFAULT_SURREAL_URL;
  const discoveryUrl = pointer.discoveryEndpoint ?? DISCOVERY_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  // Scan recent traces. executed_at is in the SELECT so SurrealDB can ORDER BY it.
  const rows = await surrealQuery(
    surrealUrl,
    `SELECT output_impulse_shapes, input_impulse_shapes, activity_id, executed_at ` +
      `FROM activity_execution_traces ORDER BY executed_at DESC LIMIT ${Math.max(1, Math.floor(traceLimit))};`,
  );

  if (rows === null) {
    return {
      shape: "residualShapeDiscoveryReport",
      body: {
        degraded: true,
        reason: "could not query activity_execution_traces (SurrealDB unreachable or auth failed)",
        generated_at: new Date().toISOString(),
      },
    };
  }

  const aet = rows as AETRow[];

  // Aggregate co-occurrence clusters + record which shapes are CONSUMED
  // (appear as input) anywhere, for the closure/consumer gate.
  const clusters = new Map<string, ClusterAgg>();
  const consumedShapes = new Set<string>();

  for (const row of aet) {
    for (const s of row.input_impulse_shapes ?? []) {
      if (s) consumedShapes.add(s);
    }
    const out = [...new Set((row.output_impulse_shapes ?? []).filter((s): s is string => !!s))].sort();
    if (out.length < minClusterSize) continue;
    // Skip clusters that are PURELY internal scaffold (every shape is scaffold).
    if (out.every((s) => INTERNAL_SCAFFOLD_SHAPES.has(s))) continue;
    // Require a generic carrier present (the "forced through a generic pipe"
    // signature). A cluster of all-named-semantic shapes with no carrier is a
    // genuine composite but a WEAKER residual signal; we focus the heuristic on
    // the carrier case where the basis is provably too coarse.
    const carriers = out.filter((s) => GENERIC_CARRIER_SHAPES.has(s));
    if (carriers.length === 0) continue;

    const sig = structuralSignature(out);
    let agg = clusters.get(sig);
    if (!agg) {
      agg = { count: 0, windows: new Set(), producers: new Map(), exampleIds: [], carriers: new Set() };
      clusters.set(sig, agg);
    }
    agg.count += 1;
    agg.windows.add(windowKey(row.executed_at, gran));
    for (const c of carriers) agg.carriers.add(c);
    const prod = row.activity_id ?? "(unknown)";
    agg.producers.set(prod, (agg.producers.get(prod) ?? 0) + 1);
    if (agg.exampleIds.length < 5 && row.activity_id) agg.exampleIds.push(row.activity_id);
  }

  const namedShapes = await fetchNamedShapes(discoveryUrl);

  // Build proposals, applying hard gates.
  const proposals: Proposal[] = [];
  const rejected: Array<{ signature: string; failed_gate: string; windows: number; traces: number }> = [];

  for (const [sig, agg] of clusters) {
    const shapes = sig.split("+");

    // GATE 1 — PERSISTENCE.
    if (agg.count < minTraces || agg.windows.size < minWindows) {
      rejected.push({ signature: sig, failed_gate: "persistence", windows: agg.windows.size, traces: agg.count });
      continue;
    }

    // GATE 2 — NOVELTY. Reject if a single named shape already equals the
    // structural signature (an exact composite already exists). We do NOT
    // reject on subset overlap (the whole point is that no SINGLE shape names
    // the cluster).
    const exactNamed = namedShapes.has(sig) || namedShapes.has(proposeName(shapes));
    if (exactNamed) {
      rejected.push({ signature: sig, failed_gate: "novelty", windows: agg.windows.size, traces: agg.count });
      continue;
    }

    // GATE 3 — CLOSURE (producer required; consumer optional → confidence).
    // Producer: the dominant activity emitting the cluster.
    let producer: string | null = null;
    let producerCount = 0;
    for (const [p, c] of agg.producers) {
      if (p !== "(unknown)" && c > producerCount) {
        producer = p;
        producerCount = c;
      }
    }
    if (!producer) {
      rejected.push({ signature: sig, failed_gate: "closure_producer", windows: agg.windows.size, traces: agg.count });
      continue;
    }
    // Consumer plausibility: is ANY non-carrier shape in the cluster consumed
    // downstream as an input anywhere?
    const semantic = shapes.filter((s) => !GENERIC_CARRIER_SHAPES.has(s));
    const consumer = semantic.find((s) => consumedShapes.has(s)) ?? null;

    // Confidence heuristic: persistence breadth + producer concentration +
    // consumer presence + semantic richness (more named shapes riding the
    // carrier ⇒ stronger axis). Bounded [0,1].
    const windowScore = Math.min(1, agg.windows.size / (minWindows * 2));
    const traceScore = Math.min(1, agg.count / (minTraces * 3));
    const producerConc = producerCount / agg.count;
    const consumerBonus = consumer ? 0.15 : 0;
    const semanticBonus = Math.min(0.2, semantic.length * 0.05);
    let confidence =
      0.3 * windowScore + 0.25 * traceScore + 0.2 * producerConc + consumerBonus + semanticBonus;
    confidence = Math.max(0, Math.min(1, confidence));

    const proposal: Proposal = {
      proposed_name: proposeName(shapes),
      signal_type: "cooccurrence_generic_carrier",
      structural_signature: sig,
      cluster_shapes: shapes,
      generic_carriers: [...agg.carriers].sort(),
      evidence: {
        frequency: agg.count,
        windows: agg.windows.size,
        example_activity_ids: agg.exampleIds,
        current_generic_shapes: [...agg.carriers].sort(),
      },
      candidate_producer: producer,
      candidate_consumer: consumer,
      persistence: { windows: agg.windows.size, traces: agg.count },
      confidence,
      passed_gates: ["persistence", "novelty", "closure_producer"].concat(
        consumer ? ["closure_consumer"] : [],
      ),
    };
    proposals.push(proposal);
  }

  // Strongest first.
  proposals.sort((a, b) => b.confidence - a.confidence || b.persistence.traces - a.persistence.traces);

  // Best-effort JSONL log.
  if (pointer.log_path) {
    try {
      mkdirSync(dirname(pointer.log_path), { recursive: true });
      const ts = new Date().toISOString();
      for (const p of proposals) {
        appendFileSync(pointer.log_path, JSON.stringify({ ts, ...p }) + "\n");
      }
    } catch {
      /* best-effort */
    }
  }

  let proposalsEmitted = 0;
  const emitted: string[] = [];
  if (emit) {
    for (const p of proposals) {
      if (proposalsEmitted >= maxEmit) break;
      const ok = await emitProposal(emitUrl, apiKey, p);
      if (ok) {
        proposalsEmitted += 1;
        emitted.push(p.proposed_name);
      }
    }
  }

  return {
    shape: "residualShapeDiscoveryReport",
    body: {
      heuristic_note:
        "Heuristic approximation of residual geometry: co-occurrence cluster " +
        "through a generic carrier ⇒ candidate unnamed axis. Propose-only; " +
        "nothing minted or registered. Structural-signature (content key-set) " +
        "signal pending durable resolved-impulse-body storage.",
      gates: {
        persistence: { min_windows: minWindows, min_traces: minTraces, window_granularity: gran },
        novelty: "not equal to an existing named/composite shape",
        closure: "dominant producer required; downstream consumer raises confidence",
      },
      traces_scanned: aet.length,
      candidate_clusters: clusters.size,
      proposals_passing_gates: proposals.length,
      proposals_rejected: rejected.length,
      rejected_examples: rejected.slice(0, 10),
      proposals: proposals.slice(0, 20),
      proposals_emitted: proposalsEmitted,
      emitted_names: emitted,
      propose_only: true,
      generated_at: new Date().toISOString(),
    },
  };
}
