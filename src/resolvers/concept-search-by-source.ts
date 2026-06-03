import type { ResolverResult } from "./types.js";

/**
 * concept_search_by_source — substrate-side reader of concept-db filtered by
 * source_type. Closes the READ side of the substrate's learning loop.
 *
 * Before authoring a new vessel, the substrate dispatches this resolver with
 * source_type="vessel_construction_pattern" and a query like "scaffold" or
 * "anatomy". The returned concepts are passed as inputs to the LLM tasks in
 * complete-vessel-scaffold / scaffold-and-publish-vessel so the model has
 * accumulated priors rather than starting from a blank slate.
 *
 * Immunity-pattern compliant: single resolver, no LLM, no iteration; takes
 * an optional query string and source_type filter, returns a ranked list.
 */

export interface ConceptSearchBySourcePointer {
  type: "concept_search_by_source";
  source_type:
    | "goal"
    | "memo"
    | "human_input"
    | "search"
    | "llm"
    | "metabob_annotation"
    | "write"
    | "read"
    | "cpg_embedding"
    | "extracted"
    | "impulse_signature"
    | "vessel_construction_pattern"
    | "impulse_activity_pattern";
  /** Optional free-text query for vector similarity ranking. */
  query?: string;
  /** Cap on results returned. Default 10. */
  limit?: number;
  conceptDbUrl?: string;
}

const DEFAULT_CONCEPT_DB_URL = "http://127.0.0.1:8260/concepts/search";

interface ConceptHit {
  id: string;
  source_type: string;
  name?: string;
  summary?: string;
  content?: string;
  pointer?: unknown;
  times_succeeded?: number;
  times_failed?: number;
  relevance?: number;
}

export async function resolveConceptSearchBySource(
  pointer: ConceptSearchBySourcePointer,
): Promise<ResolverResult> {
  const baseUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB_URL;
  const limit = pointer.limit ?? 10;
  const q = pointer.query ?? "";
  const url = `${baseUrl}?q=${encodeURIComponent(q)}&limit=${limit * 3}`;

  const apiKey = process.env["METABOB_API_KEY"];
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return {
        shape: "structuredError",
        body: {
          resolver: "concept_search_by_source",
          detail: `concept-db search returned ${resp.status}: ${detail}`,
        },
      };
    }
    const json = (await resp.json()) as { concepts?: unknown };
    const allHits = Array.isArray(json.concepts) ? (json.concepts as ConceptHit[]) : [];
    // Filter by source_type — concept-db's /concepts/search ranks by similarity
    // across ALL source_types; we want only ours.
    const filtered = allHits.filter((c) => c.source_type === pointer.source_type);
    const limited = filtered.slice(0, limit);

    return {
      shape: "conceptSearchResult",
      body: {
        source_type: pointer.source_type,
        query: q,
        total_returned_by_db: allHits.length,
        matched_by_source: filtered.length,
        limit_applied: limited.length,
        concepts: limited.map((c) => ({
          id: c.id,
          name: c.name ?? null,
          summary: c.summary ?? null,
          content: c.content ?? null,
          times_succeeded: c.times_succeeded ?? 0,
          times_failed: c.times_failed ?? 0,
        })),
        completed_at: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "concept_search_by_source",
        detail: `concept-db search failed: ${(err as Error).message}`,
      },
    };
  }
}
