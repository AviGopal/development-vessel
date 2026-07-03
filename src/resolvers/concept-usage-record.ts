import type { ResolverResult } from "./types.js";

/**
 * concept_usage_record — POST outcome feedback to concept-db.
 *
 * Closes the missing write-back wire in concept-db's learning loop. Without
 * this resolver, concepts accumulate `times_loaded` (via concept_select_for_prompt
 * / concept_search_by_source reads) but never `times_succeeded` / `times_failed`,
 * so the Laplace-smoothed Bayesian relevance formula `(ts+1)/(tl+2)` decays
 * monotonically from 0.5 toward 0 as loads accumulate.
 *
 * Empirical state 2026-06-03T05:24Z: 21 of 30 sampled concepts had tl>0
 * but ts=0+tf=0 — the relevance signal was inverted (high-utility concepts
 * looked LESS relevant the more they were cited). This resolver fixes it.
 *
 * Caller pattern: after a trace completes, identify concepts cited in any
 * input impulse with shape=conceptPromptPriors, then dispatch this resolver
 * once per concept_id with the trace's outcome.
 *
 * Immunity-pattern compliant — single resolver, no LLM, no iteration over
 * a pool. Caller iterates and dispatches one at a time.
 */

export interface ConceptUsageRecordPointer {
  type: "concept_usage_record";
  concept_id: string;
  trace_id: string;
  outcome: "success" | "failure";
  /** Optional weight (concept-db schema accepts but we don't currently use it). */
  weight?: number;
  conceptDbUrl?: string;
}

const DEFAULT_CONCEPT_DB_URL = "http://127.0.0.1:8260/concepts";

export async function resolveConceptUsageRecord(
  pointer: ConceptUsageRecordPointer,
): Promise<ResolverResult> {
  // Defensive hygiene (2026-06-18): some executor paths (notably light-dispatch)
  // dispatch this resolver WITHOUT binding the template variables, so
  // `{{concept_id}}` / `{{trace_id}}` arrive as literal placeholders. Writing
  // those to concept-db pollutes usage attribution and DEFEATS per-trace dedup
  // (every leaked record shares the single key "{{trace_id}}"). Observed in the
  // concept-db journal. A placeholder concept_id means the upstream extract
  // failed — skip the write entirely; a placeholder/empty trace_id gets a unique
  // synthesized fallback so each usage event still keys distinctly.
  const isPlaceholder = (v: unknown): boolean =>
    typeof v === "string" && /\{\{.*\}\}/.test(v);
  if (isPlaceholder(pointer.concept_id) || !pointer.concept_id) {
    // An empty/placeholder concept_id means the upstream extract selected nothing
    // (e.g. a boredom dispatch with no real query) — the intended behaviour is to
    // SKIP the usage write, which is a benign NO-OP, not a failure. Returning
    // `structuredError` here made goal-host's proxy throw (index.ts) and fail the
    // WHOLE composed activity, so concept transformers running via composition all
    // failed whenever they selected nothing. Return the declared success shape with
    // skipped:true so the chain completes gracefully and composition can self-assemble.
    return {
      shape: "conceptUsageRecorded",
      body: {
        resolver: "concept_usage_record",
        skipped: true,
        recorded: false,
        reason: `unresolved/empty concept_id ("${String(pointer.concept_id).slice(0, 40)}") — skipped usage write (no-op)`,
      },
    };
  }
  if (isPlaceholder(pointer.trace_id) || !pointer.trace_id) {
    // No real trace attribution — do NOT synthesize a usage row. Synthetic
    // autonomous_backfill_* rows inflated concept relevance (usage credit must
    // come only from a real execution trace that loaded the concept).
    return {
      shape: "conceptUsageRecorded",
      body: {
        skipped: true,
        recorded: false,
        reason: "unbound/placeholder trace_id — skipped usage write (no synthetic credit)",
      },
    };
  }
  const traceId = pointer.trace_id;
  const baseUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB_URL;
  // concept-db expects the concept_id URL-encoded into the path
  const url = `${baseUrl}/${encodeURIComponent(pointer.concept_id)}/usage`;
  const apiKey = process.env["METABOB_API_KEY"];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;

  const body: Record<string, unknown> = {
    trace_id: traceId,
    outcome: pointer.outcome,
  };
  if (typeof pointer.weight === "number") body["weight"] = pointer.weight;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return {
        shape: "structuredError",
        body: {
          resolver: "concept_usage_record",
          detail: `concept-db usage POST returned ${resp.status}: ${detail}`,
        },
      };
    }
    const json = (await resp.json()) as Record<string, unknown>;
    return {
      shape: "conceptUsageRecorded",
      body: {
        concept_id: pointer.concept_id,
        trace_id: traceId,
        outcome: pointer.outcome,
        usage_record_id: typeof json["id"] === "string" ? json["id"] : null,
        recorded_at:
          typeof json["recorded_at"] === "string"
            ? json["recorded_at"]
            : new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "concept_usage_record",
        detail: `concept-db usage POST failed: ${(err as Error).message}`,
      },
    };
  }
}
