import type { ResolverResult } from "./types.js";

/**
 * concept_write — substrate-side wrapper around concept-db POST /concepts.
 *
 * Closes the WRITE side of the substrate's learning loop. After a successful
 * substrate-authored activity (e.g. scaffold-and-publish-vessel produced a
 * working vessel + merged PR), extract the pattern and POST it to concept-db
 * with an appropriate source_type so future drafts can consult it.
 *
 * Valid source_type values (concept-db schema, 2026-06-03):
 *   goal | memo | human_input | search | llm | metabob_annotation
 *   write | read | cpg_embedding | extracted | impulse_signature
 *   vessel_construction_pattern | impulse_activity_pattern
 *
 * The two most relevant for substrate-authored learning:
 *   - vessel_construction_pattern: how to build/structure a vessel
 *   - impulse_activity_pattern: how an activity uses impulses to achieve a goal
 *
 * Immunity-pattern compliant: single resolver, no LLM, no iteration, no
 * variables. Returns conceptCreateResult with the assigned concept id.
 */

export interface ConceptWritePointer {
  type: "concept_write";
  name: string;
  content: string;
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
  pointer_memo?: string;
  conceptDbUrl?: string;
}

const DEFAULT_CONCEPT_DB_URL = "http://127.0.0.1:8260/concepts";

export async function resolveConceptWrite(
  pointer: ConceptWritePointer,
): Promise<ResolverResult> {
  const url = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB_URL;
  const apiKey = process.env["METABOB_API_KEY"];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;

  const body = {
    name: pointer.name,
    content: pointer.content,
    source_type: pointer.source_type,
    pointer: {
      type: "memo",
      content: pointer.pointer_memo ?? pointer.name,
    },
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return {
        shape: "structuredError",
        body: {
          resolver: "concept_write",
          detail: `concept-db POST returned ${resp.status}: ${detail}`,
        },
      };
    }
    const json = (await resp.json()) as Record<string, unknown>;
    return {
      shape: "conceptCreateResult",
      body: {
        concept_id: typeof json["id"] === "string" ? json["id"] : null,
        source_type: pointer.source_type,
        token_estimate:
          typeof json["token_estimate"] === "number" ? json["token_estimate"] : null,
        summary: typeof json["summary"] === "string" ? json["summary"] : null,
        completed_at: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "concept_write",
        detail: `concept-db POST failed: ${(err as Error).message}`,
      },
    };
  }
}
