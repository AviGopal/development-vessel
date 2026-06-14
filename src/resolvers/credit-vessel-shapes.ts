import type { ResolverResult } from "./types.js";

/**
 * credit_vessel_shapes (2026-06-13) — the REWARD EDGE for vessel interactions.
 *
 * SUBSTRATE_AS_MDP §8 names vessel addition as monotone (ΔS, ΔA, ΔR): a new
 * vessel's (signature, template) cells start at the Beta(1,1) prior. Thompson
 * exploration will *try* them, and the trace-write path updates α/β on success
 * — but the per-impulse relevance signal (which shapes were load-bearing) is
 * NOT written automatically; callers must POST it. For a freshly-arrived vessel
 * nothing posts it, so the binding layer never learns that the vessel's shapes
 * are useful and they stay at zero relevance forever ("tried-but-never-learned").
 *
 * This resolver is the generic bridge: given a vessel id + the shapes it
 * advertises + the variant that successfully interacted with it, it writes one
 * impulse-relevance record per shape to activity-api. The write is down-weighted
 * (source="vessel_arrival_characterization", replay_weight default 0.5) because
 * a characterization is a weaker signal than a real goal execution that consumed
 * the shape — it seeds the cold-start relevance off zero without pretending the
 * shape carried a full workload. Any future vessel-interaction activity can call
 * this same resolver to credit the shapes it used.
 *
 * Mirror of credit_primed_concepts: first-hand outcome reporting, written to the
 * service that owns the data (activity-api), never re-derived.
 */

const DEFAULT_METABOB = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface CreditVesselShapesPointer {
  type: "credit_vessel_shapes";
  metabobEndpoint?: string;
  apiKey?: string;
  /** Vessel whose shapes were load-bearing in a successful interaction. */
  vesselId: string;
  /** Advertised shapes to credit. */
  shapes: string[];
  /** Variant id of the activity that interacted with the vessel. */
  activityVariantId: string;
  /** Execution that produced the interaction (provenance). */
  executionId?: string;
  outcome?: "success" | "failure";
  /** Shrinkage factor [0..1]; characterization credit is partial by design. */
  replayWeight?: number;
  /** Marks the relevance row's provenance. */
  source?: string;
  resolverTier?: string;
  timeoutMs?: number;
}

export async function resolveCreditVesselShapes(
  pointer: CreditVesselShapesPointer,
): Promise<ResolverResult> {
  const endpoint = (pointer.metabobEndpoint ?? DEFAULT_METABOB).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const vesselId = pointer.vesselId;
  const shapes = Array.isArray(pointer.shapes) ? pointer.shapes : [];
  const activityVariantId = pointer.activityVariantId;
  const outcome = pointer.outcome ?? "success";
  const replayWeight = pointer.replayWeight ?? 0.5;
  const source = pointer.source ?? "vessel_arrival_characterization";
  const resolverTier = pointer.resolverTier ?? "deterministic";
  const timeoutMs = pointer.timeoutMs ?? 5000;

  if (!vesselId || !activityVariantId || shapes.length === 0) {
    return {
      shape: "vesselShapeCreditResult",
      body: {
        error: "vesselId, activityVariantId, and a non-empty shapes[] are required",
        credited: 0,
        vessel_id: vesselId ?? null,
      },
    };
  }
  if (!apiKey) {
    return {
      shape: "vesselShapeCreditResult",
      body: { error: "missing_api_key", credited: 0, vessel_id: vesselId },
    };
  }

  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `ApiKey ${apiKey}`,
  };

  let credited = 0;
  let errors = 0;
  const failures: string[] = [];
  for (const shape of shapes) {
    const impulseId = `vessel:${vesselId}:${shape}`;
    try {
      const res = await fetch(`${endpoint}/v2/activities/impulse-relevance`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          impulse_id: impulseId,
          activity_variant_id: activityVariantId,
          was_loaded: true,
          execution_succeeded: outcome === "success",
          pointer_type: shape,
          resolver_tier: resolverTier,
          resolver_name: vesselId,
          source,
          replay_weight: replayWeight,
          ...(pointer.executionId ? { execution_id: pointer.executionId } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) credited += 1;
      else {
        errors += 1;
        if (failures.length < 5) failures.push(`${shape}:${res.status}`);
      }
    } catch (err) {
      errors += 1;
      if (failures.length < 5) {
        failures.push(`${shape}:${err instanceof Error ? err.message.slice(0, 60) : "err"}`);
      }
    }
  }

  return {
    shape: "vesselShapeCreditResult",
    body: {
      vessel_id: vesselId,
      activity_variant_id: activityVariantId,
      shapes_total: shapes.length,
      credited,
      errors,
      outcome,
      replay_weight: replayWeight,
      source,
      ...(failures.length ? { sample_failures: failures } : {}),
      generated_at: new Date().toISOString(),
    },
  };
}
