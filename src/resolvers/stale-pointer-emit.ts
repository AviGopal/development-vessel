import type { ResolverResult } from "./types.js";

/**
 * stale_pointer_emit — deterministic stale-concept-pointer detector + emitter.
 *
 * Reads concept-db `/concepts/search`, stats each concept's `pointer.path`
 * inside the substrate filesystem, and for every concept whose pointer.path
 * is non-empty AND missing on disk, POSTs a `substrateGap_write` impulse
 * to development-vessel.
 *
 * Why one resolver does the whole thing: the prior template chained
 * iteration → fs_read → iteration → http_fetch, but iteration has no
 * conditional-execution mode, so the gap-emission iteration would POST a
 * gap for every concept (including ones whose path resolved fine). Doing
 * the filtering server-side is simpler, cheaper, and avoids the multi-
 * iteration plumbing entirely.
 *
 * The detect-stale-pointer seed template wraps this resolver in a single
 * task; no LLM call is needed.
 */

export interface StalePointerEmitPointer {
  type: "stale_pointer_emit";
  /** Override concept-db search URL. Default: http://127.0.0.1:8260/concepts/search?limit=500 */
  conceptSearchUrl?: string;
  /** Override dev-vessel impulses URL. Default: http://127.0.0.1:8090/v2/impulses/resolve */
  devVesselImpulsesUrl?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation. Default 50. */
  maxEmits?: number;
}

const DEFAULT_SEARCH_URL = "http://127.0.0.1:8260/concepts/search?limit=500";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_MAX_EMITS = 50;

interface ConceptLike {
  id?: unknown;
  pointer?: { path?: unknown } | unknown;
  metadata?: { doc_path?: unknown } | unknown;
}

interface StaleEntry {
  concept_id: string;
  suspected_path: string;
  reason: string;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
  post_error?: string;
}

function extractPath(c: ConceptLike): string | null {
  const pointer = c.pointer as { path?: unknown } | undefined;
  if (pointer && typeof pointer.path === "string" && pointer.path.length > 0) {
    return pointer.path;
  }
  const metadata = c.metadata as { doc_path?: unknown } | undefined;
  if (metadata && typeof metadata.doc_path === "string" && metadata.doc_path.length > 0) {
    return metadata.doc_path;
  }
  return null;
}

export async function resolveStalePointerEmit(
  pointer: StalePointerEmitPointer,
): Promise<ResolverResult> {
  const searchUrl = pointer.conceptSearchUrl ?? DEFAULT_SEARCH_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey
    ? { Authorization: `ApiKey ${apiKey}` }
    : {};

  // 1. Fetch concepts.
  let concepts: ConceptLike[] = [];
  let scanned = 0;
  try {
    const resp = await fetch(searchUrl, {
      method: "GET",
      headers: { ...authHeader },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return {
        shape: "structuredError",
        body: {
          resolver: "stale_pointer_emit",
          detail: `concept-db search returned ${resp.status}`,
        },
      };
    }
    const json = (await resp.json()) as { concepts?: unknown };
    if (Array.isArray(json.concepts)) {
      concepts = json.concepts as ConceptLike[];
    }
    scanned = concepts.length;
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "stale_pointer_emit",
        detail: `concept-db fetch failed: ${(err as Error).message}`,
      },
    };
  }

  // 2. Stat each pointer.path; collect stale entries.
  const stale: StaleEntry[] = [];
  let withPointerPath = 0;
  let readable = 0;
  for (const c of concepts) {
    const path = extractPath(c);
    if (path === null) continue;
    withPointerPath += 1;
    let exists = false;
    try {
      exists = await Bun.file(path).exists();
    } catch {
      exists = false;
    }
    if (exists) {
      readable += 1;
      continue;
    }
    const conceptId = typeof c.id === "string" ? c.id : `unknown-${stale.length}`;
    stale.push({
      concept_id: conceptId,
      suspected_path: path,
      reason: "pointer.path does not exist in substrate filesystem",
      gap_id: `stale-pointer-${conceptId}`,
      posted: false,
    });
    if (stale.length >= maxEmits) break;
  }

  // 3. Emit gaps (unless dry_run).
  if (!dryRun) {
    for (const entry of stale) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: entry.gap_id,
              category: "missing_concept",
              source: "substrate_detected",
              summary: `Concept ${entry.concept_id} pointer.path may be stale: ${entry.suspected_path}`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "stale_concept_pointer",
                concept_id: entry.concept_id,
                suspected_path: entry.suspected_path,
                detection_reason: entry.reason,
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeader,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        entry.post_status = resp.status;
        entry.posted = resp.ok;
        if (!resp.ok) {
          entry.post_error = (await resp.text()).slice(0, 200);
        }
      } catch (err) {
        entry.post_status = "error";
        entry.post_error = (err as Error).message;
      }
    }
  }

  return {
    shape: "stalePointerReport",
    body: {
      scanned,
      with_pointer_path: withPointerPath,
      readable,
      stale_count: stale.length,
      stale_entries: stale,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
