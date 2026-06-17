import type { ResolverResult } from "./types.js";

/**
 * learning_signal_health_observer (2026-06-13) — promotes a SILENT learning-loop
 * degradation into impulse form: the concept-relevance signal going one-sided.
 *
 * relevance = (times_succeeded + 1) / (times_loaded + 2) (computed in concept-db).
 * When concepts are LOADED (primed into prompts) but their SUCCESS is never
 * credited, times_loaded grows while times_succeeded stays 0, so relevance
 * DECAYS with use and the corpus average sinks below the 0.5 prior. Status
 * counters say "usage recorded ✓" while the signal is inverted — exactly the
 * green-status-but-broken-substance class this observer is built to catch.
 *
 * Reads concept-db's OWN metrics (does not re-derive): success_credit_ratio =
 * concepts[loaded>0 & succeeded>0] / concepts[loaded>0], and avgRelevance.
 * Emits learningSignalHealth + a substrateGap when the ratio is low AND there
 * is enough load volume (cold-start guard — its own recursive what-new-bug
 * check: a fresh substrate legitimately has loaded=0 everywhere).
 */

const DEFAULT_CONCEPT_DB_SEARCH = "http://127.0.0.1:8260/concepts/search?limit=5000";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface LearningSignalHealthObserverPointer {
  type: "learning_signal_health_observer";
  conceptSearchUrl?: string;
  devVesselUrl?: string;
  /** success_credit_ratio below this is unhealthy. Default 0.1. */
  ratioThreshold?: number;
  /** Need at least this many loaded concepts before judging (cold-start guard). Default 50. */
  minLoadedVolume?: number;
}

interface ConceptLike {
  times_loaded?: number;
  times_succeeded?: number;
  relevance?: number;
}

export async function resolveLearningSignalHealthObserver(
  pointer: LearningSignalHealthObserverPointer,
): Promise<ResolverResult> {
  const searchUrl = pointer.conceptSearchUrl ?? DEFAULT_CONCEPT_DB_SEARCH;
  const devVesselUrl = pointer.devVesselUrl ?? DEFAULT_DEV_VESSEL_URL;
  const ratioThreshold = pointer.ratioThreshold ?? 0.1;
  const minLoadedVolume = pointer.minLoadedVolume ?? 50;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  let concepts: ConceptLike[] = [];
  try {
    const res = await fetch(searchUrl, {
      headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { concepts?: ConceptLike[] };
    concepts = Array.isArray(json.concepts) ? json.concepts : [];
  } catch (err) {
    return {
      shape: "learningSignalHealth",
      body: { error: err instanceof Error ? err.message.slice(0, 200) : String(err), generated_at: new Date().toISOString() },
    };
  }

  const total = concepts.length;
  const loaded = concepts.filter((c) => (c.times_loaded ?? 0) > 0);
  const loadedWithSuccess = loaded.filter((c) => (c.times_succeeded ?? 0) > 0);
  const successCreditRatio = loaded.length > 0 ? loadedWithSuccess.length / loaded.length : null; // null = unknown (no loaded data); do NOT report a false 1.0
  const relSum = concepts.reduce((s, c) => s + (c.relevance ?? 0.5), 0);
  const avgRelevance = total > 0 ? relSum / total : 0.5;

  const enoughVolume = loaded.length >= minLoadedVolume;
  const oneSided = enoughVolume && ((successCreditRatio !== null && successCreditRatio < ratioThreshold) || avgRelevance < 0.5);

  let gapEmission: "emitted" | "error" | "not_needed" = "not_needed";
  if (oneSided) {
    gapEmission = await emitGap(devVesselUrl, apiKey, {
      successCreditRatio: successCreditRatio ?? 0,
      avgRelevance,
      loaded: loaded.length,
      loadedWithSuccess: loadedWithSuccess.length,
    });
  }

  return {
    shape: "learningSignalHealth",
    body: {
      total_concepts: total,
      loaded_concepts: loaded.length,
      loaded_with_success: loadedWithSuccess.length,
      success_credit_ratio: successCreditRatio === null ? null : Math.round(successCreditRatio * 10000) / 10000,
      avg_relevance: Math.round(avgRelevance * 10000) / 10000,
      prior: 0.5,
      ratio_threshold: ratioThreshold,
      min_loaded_volume: minLoadedVolume,
      enough_volume: enoughVolume,
      one_sided: oneSided,
      gap_emission: gapEmission,
      diagnosis: oneSided
        ? "Concept relevance signal is one-sided: loads recorded but success rarely credited (relevance decays with use). Fix at the source — make loaded concepts visible in the execution trace so the ExecutionObserver credits success."
        : (enoughVolume ? "healthy" : "insufficient load volume to judge (cold start)"),
      generated_at: new Date().toISOString(),
    },
  };
}

async function emitGap(
  devVesselUrl: string,
  apiKey: string,
  m: { successCreditRatio: number; avgRelevance: number; loaded: number; loadedWithSuccess: number },
): Promise<"emitted" | "error"> {
  try {
    const res = await fetch(devVesselUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
      body: JSON.stringify({
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: "learning-signal-one-sided",
              category: "learning_signal_degraded",
              source: "substrate_detected",
              summary: `Concept relevance signal one-sided: only ${m.loadedWithSuccess}/${m.loaded} loaded concepts ever credited success (ratio ${m.successCreditRatio.toFixed(3)}); avg relevance ${m.avgRelevance.toFixed(3)} < 0.5 prior — usage is dragging relevance DOWN`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                detector: "learning_signal_health_observer",
                success_credit_ratio: m.successCreditRatio,
                avg_relevance: m.avgRelevance,
                root_cause: "loaded concepts (search-primed) not recorded in the execution trace, so ExecutionObserver never credits their success",
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? "emitted" : "error";
  } catch {
    return "error";
  }
}
