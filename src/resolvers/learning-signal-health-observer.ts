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
  // THE SAMPLE IS SELECTED BY THE QUANTITY BEING MEASURED. /concepts/search with no query
  // orders by relevance DESC, and relevance is (times_succeeded + 1) / (times_loaded + 2),
  // so a page that fills to its limit returns precisely the concepts that HAVE successes.
  // Measured 2026-09-10: total = loaded = loadedWithSuccess = 5000 against a store of 69,142
  // concepts whose true ratio was 0.456 - the numerator had chosen the denominator.

  const relSum = concepts.reduce((s, c) => s + (c.relevance ?? 0.5), 0);
  const avgRelevance = total > 0 ? relSum / total : 0.5;

    // PER-SUBGROUP, FETCHED WITH A source_type FILTER SO THE PAGE IS THE WHOLE SUBGROUP.
  // The fleet page above is ordered by relevance DESC, and relevance is derived from the
  // success counts this check measures, so its ratio is success-biased at any volume and
  // cannot carry a verdict. A filtered request has no such ordering problem: it returns
  // the subgroup itself. Fleet numbers are retained for context only.
  const SUBGROUP_NAMES = ["compose_lesson"];
  const MIN_SUBGROUP_VOLUME = 5;
  const subgroups: Record<string, { loaded: number; credited: number; ratio: number | null }> = {};
  for (const name of SUBGROUP_NAMES) {
    try {
      const subUrl = new URL(searchUrl);
      subUrl.searchParams.set("source_type", name);
      subUrl.searchParams.set("limit", "1000");
      const subRes = await fetch(subUrl.toString(), {
        headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      const subJson = (await subRes.json()) as { concepts?: ConceptLike[] };
      const subRows = Array.isArray(subJson.concepts) ? subJson.concepts : [];
      const subLoaded = subRows.filter((c) => (c.times_loaded ?? 0) > 0);
      const subCredited = subLoaded.filter((c) => (c.times_succeeded ?? 0) > 0);
      subgroups[name] = {
        loaded: subLoaded.length,
        credited: subCredited.length,
        ratio: subLoaded.length > 0 ? subCredited.length / subLoaded.length : null,
      };
    } catch {
      subgroups[name] = { loaded: 0, credited: 0, ratio: null };
    }
  }
  // A SUBGROUP NEEDS ITS OWN FLOOR. minLoadedVolume is 50 and no individual subgroup
  // reaches it - compose_lesson had 17 loaded - so inheriting it would compute the
  // breakdown and then suppress it, reproducing one layer down the permanently
  // "insufficient volume" defect this observer already had at fleet level.
  const starvedSubgroups = Object.entries(subgroups)
    .filter(([, s]) => s.loaded >= MIN_SUBGROUP_VOLUME && s.ratio !== null && s.ratio < ratioThreshold)
    .map(([n, s]) => `${n} ${s.credited}/${s.loaded}`);
  const enoughVolume = loaded.length >= minLoadedVolume;
  const oneSided = starvedSubgroups.length > 0 || (enoughVolume && ((successCreditRatio !== null && successCreditRatio < ratioThreshold) || avgRelevance < 0.5));

  let gapEmission: "emitted" | "error" | "not_needed" = "not_needed";
  if (oneSided) {
    // REPORT THE EVIDENCE THAT TRIPPED THIS, NOT THE FLEET PAGE. The fleet counts come
    // from a relevance-ordered page and are success-biased by construction: they read
    // 5000/5000 at ratio 1.000 while the verdict was driven by a subgroup at 0 of 15.
    // A gap whose summary says "ratio 1.000" reads as healthy to whoever acts on it,
    // which is precisely the misdirection this observer exists to prevent.
    const triggerSubgroup = Object.entries(subgroups).find(
      ([, s]) => s.loaded >= MIN_SUBGROUP_VOLUME && s.ratio !== null && s.ratio < ratioThreshold,
    );
    gapEmission = await emitGap(devVesselUrl, apiKey, {
      successCreditRatio: triggerSubgroup ? (triggerSubgroup[1].ratio ?? 0) : (successCreditRatio ?? 0),
      avgRelevance,
      loaded: triggerSubgroup ? triggerSubgroup[1].loaded : loaded.length,
      loadedWithSuccess: triggerSubgroup ? triggerSubgroup[1].credited : loadedWithSuccess.length,
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
