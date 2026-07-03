import type { ResolverResult } from "./types.js";

/**
 * credit_primed_concepts (2026-06-13) — the FIX half of the learning-signal pair.
 *
 * Concept relevance = (times_succeeded + 1) / (times_loaded + 2). The drafter
 * primes the top-N concepts (by relevance) into its prompt — that records LOADS
 * (times_loaded++, via concept-db's passive-usage path) but no success, so
 * relevance decays with use. This task runs at the drafter's SUCCESS terminal
 * (it only executes when the draft+register chain reached the end), and credits
 * those same primed concepts with outcome=success — first-hand outcome reporting
 * by the activity that loaded and used them. Not re-derivation: it reports the
 * success it observed (reaching the terminal) for the concepts it loaded.
 *
 * Reads the primed set from concept-db's OWN search (the same query the drafter
 * primes with) and writes via concept-db's own POST /concepts/:id/usage. The
 * load and the credit thus target the same top-N, making relevance two-sided.
 */

const DEFAULT_BASE = "http://127.0.0.1:8260";

export interface CreditPrimedConceptsPointer {
  type: "credit_primed_concepts";
  conceptDbBase?: string;
  /** Same query the drafter primes with. */
  minRelevance?: number;
  limit?: number;
  outcome?: "success" | "failure";
  traceId?: string;
  /** Exact primed concept ids to credit; when non-empty, skips the search fetch. */
  conceptIds?: string[];
}

interface ConceptLike { id?: string }

export async function resolveCreditPrimedConcepts(
  pointer: CreditPrimedConceptsPointer,
): Promise<ResolverResult> {
  const base = pointer.conceptDbBase ?? DEFAULT_BASE;
  const minRelevance = pointer.minRelevance ?? 0.3;
  const limit = pointer.limit ?? 15;
  const outcome = pointer.outcome ?? "success";
  const traceId = pointer.traceId ?? "drafter-success-credit";
  const apiKey = process.env["METABOB_API_KEY"] ?? "";
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  // 1. Use explicitly-supplied primed ids when given; else fetch top-N by relevance.
  let ids: string[] = Array.isArray(pointer.conceptIds)
    ? pointer.conceptIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (ids.length === 0) try {
    const res = await fetch(
      `${base}/concepts/search?min_relevance=${minRelevance}&limit=${limit}`,
      { headers: authHeaders, signal: AbortSignal.timeout(10_000) },
    );
    const json = (await res.json()) as { concepts?: ConceptLike[] };
    ids = (json.concepts ?? []).map((c) => c.id).filter((x): x is string => typeof x === "string");
  } catch (err) {
    return {
      shape: "conceptCreditResult",
      body: { error: err instanceof Error ? err.message.slice(0, 200) : String(err), credited: 0 },
    };
  }

  // 2. Credit each with the observed outcome via concept-db's own usage endpoint.
  let credited = 0;
  let errors = 0;
  for (const id of ids) {
    const bare = id.replace(/^concept:/, "").replace(/[⟨⟩]/g, "");
    try {
      const res = await fetch(`${base}/concepts/${encodeURIComponent(bare)}/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ outcome, trace_id: traceId }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) credited += 1; else errors += 1;
    } catch {
      errors += 1;
    }
  }

  return {
    shape: "conceptCreditResult",
    body: {
      primed_concepts: ids.length,
      credited,
      errors,
      outcome,
      generated_at: new Date().toISOString(),
    },
  };
}
