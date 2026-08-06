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
    | "impulse_activity_pattern"
    | "architectural_pattern_principle";
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
    // FALL BACK TO THE ROUTE THAT ALREADY WORKS. DEFAULT_CONCEPT_DB_URL pins
    // http://127.0.0.1:8260, and concept-db is MASKED on a spoke because it lives on the hub
    // where its data lives (law 11) — so this POST fails for EVERY caller here, not just some.
    // Measured 2026-08-06: resolving concept_write through discovery returned
    // structuredError "concept-db POST failed: Unable to connect", and the concept-usage
    // observer logged 49 "usage record failed" per hour. Concept usage credit — the mechanism
    // that assigns utility to a resolver from how impulses actually thread through it — was
    // writing nowhere.
    //
    // The repair is REUSE, not a new pin and not a new proxy hop. The `concept_create_write`
    // shape is advertised by exactly one producer, `concept-db-local@syzygy-hub` over libp2p,
    // with no local squatter to shadow it — and it demonstrably works: a live probe through
    // ${DISCOVERY_ENDPOINT}/resolve created concept:⟨concept_FiS-lPLncAkQ⟩ on the hub. This is
    // the same route feature-compose's compose-lesson mirror uses successfully today.
    // Discovery is the fixed point; ask it rather than guessing a port.
    try {
      const discovery = process.env["DISCOVERY_ENDPOINT"] ?? process.env["DISCOVERY_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8100";
      const fbRes = await fetch(`${discovery.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pointer: {
            type: "concept_create_write",
            conceptData: {
              source_type: pointer.source_type,
              shape: pointer.source_type,
              content: pointer.content,
              summary: pointer.pointer_memo ?? pointer.name,
            },
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (fbRes.ok) {
        const fbJson = (await fbRes.json()) as { success?: boolean; content?: unknown; body?: unknown };
        if (fbJson?.success !== false) {
          return {
            shape: "conceptCreateResult",
            body: {
              concept_id: null,
              routed_via: "discovery:concept_create_write",
              raw: typeof fbJson.content === "string" ? fbJson.content.slice(0, 2000) : (fbJson.body ?? null),
              completed_at: new Date().toISOString(),
            },
          };
        }
      }
    } catch { /* fall through to the honest error below — never swallow into a false success */ }
    return {
      shape: "structuredError",
      body: {
        resolver: "concept_write",
        detail: `concept-db POST failed: ${(err as Error).message}`,
      },
    };
  }
}
