import type { ResolverResult } from "./types.js";

/**
 * concept_select_for_prompt — deterministic multi-axis prior selection for
 * LLM-prompt activities.
 *
 * Activities that dispatch llm_completion_dispatch need to inject relevant
 * substrate priors as part of their prompt. Naive selection (fetch top-N by
 * vector similarity, dump in prompt) wastes tokens on irrelevant concepts
 * and crowds out task inputs.
 *
 * This resolver implements the §2 selection design from the 2026-06-03
 * concept-db architecture answer: rank eligible concepts by combined score
 * across four axes, then fill a token budget greedily.
 *
 * Ranking (combined_score, higher is better):
 *   1. source_type filter (hard): only concepts whose source_type ∈
 *      prior_source_types are eligible. Implemented by calling concept_search_
 *      by_source for each desired source_type.
 *   2. vector similarity rank: concept-db's /concepts/search already ranks
 *      by embedding similarity to the query. The position in the returned
 *      list maps to similarity_score = (limit - position) / limit.
 *   3. usage success rate: success_rate = times_succeeded /
 *      max(1, times_succeeded + times_failed). Concepts informing successful
 *      drafts get a bonus; concepts that consistently fail get demoted.
 *   4. priority (concept-db field, 0..1 default 0.5): operator/curation-
 *      assigned priority. Higher = preferred.
 *
 * combined_score = 0.40 * similarity_rank
 *                + 0.30 * success_rate
 *                + 0.20 * priority
 *                + 0.10 * (1 / log2(token_estimate + 4))  // token economy
 *
 * Greedy budget fill: iterate by combined_score desc, include concept if
 * (running_tokens + concept.token_estimate) <= budget_tokens.
 *
 * Immunity-pattern compliant: single resolver, no LLM (calls concept-db
 * deterministically), no iteration over a pool.
 */

export interface ConceptSelectForPromptPointer {
  type: "concept_select_for_prompt";
  /** Free-text query for vector similarity ranking. */
  query: string;
  /** Hard filter — only concepts with these source_types are eligible. */
  prior_source_types: string[];
  /** Token budget cap. Default 8000. */
  budget_tokens?: number;
  /** Max candidates pulled per source_type before filtering. Default 20. */
  candidates_per_source_type?: number;
  conceptDbUrl?: string;
}

const DEFAULT_CONCEPT_DB_URL = "http://127.0.0.1:8260/concepts/search";
const DEFAULT_BUDGET_TOKENS = 8000;
const DEFAULT_CANDIDATES_PER_SOURCE_TYPE = 20;

interface ConceptRow {
  id: string;
  source_type: string;
  name?: string;
  summary?: string;
  content?: string;
  times_succeeded?: number;
  times_failed?: number;
  priority?: number;
  token_estimate?: number;
}

interface ScoredConcept {
  id: string;
  source_type: string;
  name: string | null;
  content: string | null;
  token_estimate: number;
  similarity_rank: number;
  success_rate: number;
  priority: number;
  combined_score: number;
  why_selected: string;
}

function safeRowToScored(
  c: ConceptRow,
  position: number,
  limit: number,
): ScoredConcept {
  const succeeded = typeof c.times_succeeded === "number" ? c.times_succeeded : 0;
  const failed = typeof c.times_failed === "number" ? c.times_failed : 0;
  const successRate = succeeded / Math.max(1, succeeded + failed);
  const priority = typeof c.priority === "number" ? c.priority : 0.5;
  const tokenEstimate =
    typeof c.token_estimate === "number" && c.token_estimate > 0
      ? c.token_estimate
      : Math.max(50, (c.content?.length ?? 200) / 4);
  // Position is 0-indexed; rank decreases with position.
  const similarityRank = (limit - position) / Math.max(1, limit);
  const tokenEconomy = 1 / Math.log2(tokenEstimate + 4);
  const combinedScore =
    0.4 * similarityRank +
    0.3 * successRate +
    0.2 * priority +
    0.1 * tokenEconomy;
  return {
    id: c.id,
    source_type: c.source_type,
    name: c.name ?? null,
    content: c.content ?? c.summary ?? null,
    token_estimate: Math.round(tokenEstimate),
    similarity_rank: Number(similarityRank.toFixed(3)),
    success_rate: Number(successRate.toFixed(3)),
    priority,
    combined_score: Number(combinedScore.toFixed(3)),
    why_selected: `sim=${similarityRank.toFixed(2)} succ=${successRate.toFixed(2)} pri=${priority.toFixed(2)} tok=${Math.round(tokenEstimate)}`,
  };
}

async function fetchForSourceType(
  baseUrl: string,
  sourceType: string,
  query: string,
  limit: number,
  apiKey: string | undefined,
): Promise<ConceptRow[]> {
  const url = `${baseUrl}?q=${encodeURIComponent(query)}&limit=${limit * 3}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return [];
    const json = (await resp.json()) as { concepts?: unknown };
    const all = Array.isArray(json.concepts) ? (json.concepts as ConceptRow[]) : [];
    return all.filter((c) => c.source_type === sourceType).slice(0, limit);
  } catch {
    return [];
  }
}

export async function resolveConceptSelectForPrompt(
  pointer: ConceptSelectForPromptPointer,
): Promise<ResolverResult> {
  const baseUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB_URL;
  const budgetTokens = pointer.budget_tokens ?? DEFAULT_BUDGET_TOKENS;
  const candidatesPerSourceType =
    pointer.candidates_per_source_type ?? DEFAULT_CANDIDATES_PER_SOURCE_TYPE;
  const sourceTypes = pointer.prior_source_types ?? [];
  if (sourceTypes.length === 0) {
    return {
      shape: "structuredError",
      body: {
        resolver: "concept_select_for_prompt",
        detail: "prior_source_types must be non-empty",
      },
    };
  }

  const apiKey = process.env["METABOB_API_KEY"];

  // Pull candidates per source_type in parallel.
  const fetched = await Promise.all(
    sourceTypes.map((st) =>
      fetchForSourceType(baseUrl, st, pointer.query, candidatesPerSourceType, apiKey),
    ),
  );

  // Score each candidate (similarity_rank uses position within its source_type list).
  const scored: ScoredConcept[] = [];
  for (let i = 0; i < fetched.length; i++) {
    const list = fetched[i] ?? [];
    for (let j = 0; j < list.length; j++) {
      const row = list[j];
      if (row) scored.push(safeRowToScored(row, j, candidatesPerSourceType));
    }
  }

  // Sort by combined_score desc.
  scored.sort((a, b) => b.combined_score - a.combined_score);

  // Greedy budget fill.
  const selected: ScoredConcept[] = [];
  let runningTokens = 0;
  for (const s of scored) {
    if (runningTokens + s.token_estimate <= budgetTokens) {
      selected.push(s);
      runningTokens += s.token_estimate;
    }
  }

  return {
    shape: "conceptPromptPriors",
    body: {
      query: pointer.query,
      prior_source_types: sourceTypes,
      budget_tokens: budgetTokens,
      tokens_used: runningTokens,
      candidates_considered: scored.length,
      selected_count: selected.length,
      selected: selected.map((s) => ({
        id: s.id,
        source_type: s.source_type,
        name: s.name,
        content: s.content,
        token_estimate: s.token_estimate,
        combined_score: s.combined_score,
        why_selected: s.why_selected,
      })),
      completed_at: new Date().toISOString(),
    },
  };
}
