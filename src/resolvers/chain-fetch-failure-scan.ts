import type { ResolverResult } from "./types.js";

/**
 * chain_fetch_failure_scan — deterministic detector for authored chains whose
 * http_fetch tasks fail (non-2xx), surfaced via their observable EFFECT: the
 * degenerate concepts they mint.
 *
 * Meta-detector for the bug class where authored orphan-remediation chains GET
 * activity-api over raw http_fetch, hit 401 (http_fetch only auths mutations) or
 * an invented endpoint, and the downstream LLM — handed empty/error data —
 * mints a concept whose content is "I cannot access … 401 authentication error"
 * or "please provide the list". The chain "completes" (http_fetch swallows
 * non-2xx) and the concept write succeeds, so NOTHING fails — yet the mint is
 * garbage. The only signal is the failure-marker language in the minted content.
 *
 * Scans recently-minted concepts (concept-db) for fetch-failure markers and
 * emits ONE aggregated substrateGap when the count crosses a threshold (so a
 * single odd concept doesn't trigger). Routes the fix into the
 * gap → bridge → drafter loop so the next instance self-completes — the aligned
 * remediation being to re-author the chain over typed resolvers / correct
 * endpoints rather than raw http_fetch GETs to an auth-gated backend.
 *
 * Mirrors stale_pointer_emit: one server-side resolver, deterministic filter,
 * conditional emit, no LLM.
 */

export interface ChainFetchFailureScanPointer {
  type: "chain_fetch_failure_scan";
  /** Override concept-db search URL. Default: .../concepts/search?min_relevance=0&limit=200 */
  conceptSearchUrl?: string;
  /** Override dev-vessel impulses URL (self-POST). */
  devVesselImpulsesUrl?: string;
  /** Extended-regex of fetch/data-flow failure markers in minted content. */
  markerPattern?: string;
  /** Emit when degenerate-concept count >= this. Default 2. */
  threshold?: number;
  /** dry_run = true: scan + report but do not POST a gap. */
  dry_run?: boolean;
  /** Test hook: scan these concepts instead of fetching. */
  _concepts?: ConceptLike[];
}

interface ConceptLike {
  id?: unknown;
  shape?: unknown;
  source_type?: unknown;
  content?: unknown;
}

const DEFAULT_SEARCH_URL = "http://127.0.0.1:8260/concepts/search?min_relevance=0&limit=200";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_THRESHOLD = 2;
// Failure-marker language an LLM emits when handed empty/error fetch data.
const DEFAULT_MARKER_PATTERN =
  "401|authentication error|unauthor|" +
  "please (share|provide|paste)|" +
  "cannot (access|determine|complete|identify)|" +
  "I (don't|do not) (see|have)|I cannot (access|see|complete)|" +
  "no .{0,20}data .{0,20}(provided|available)|" +
  "Invalid JSON|endpoint .{0,20}(returned|error)";

interface DegenerateHit {
  concept_id: string;
  shape: string;
  snippet: string;
}

export async function resolveChainFetchFailureScan(
  pointer: ChainFetchFailureScanPointer,
): Promise<ResolverResult> {
  const searchUrl = pointer.conceptSearchUrl ?? DEFAULT_SEARCH_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const threshold = pointer.threshold ?? DEFAULT_THRESHOLD;
  const dryRun = pointer.dry_run === true;
  let markerRe: RegExp;
  try { markerRe = new RegExp(pointer.markerPattern ?? DEFAULT_MARKER_PATTERN, "i"); }
  catch { markerRe = new RegExp(DEFAULT_MARKER_PATTERN, "i"); }

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  // 1. Obtain recent concepts.
  let concepts: ConceptLike[] = [];
  if (pointer._concepts) {
    concepts = pointer._concepts;
  } else {
    try {
      const resp = await fetch(searchUrl, { method: "GET", headers: { ...authHeader }, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) return { shape: "structuredError", body: { resolver: "chain_fetch_failure_scan", detail: `concept-db search returned ${resp.status}` } };
      const json = (await resp.json()) as { concepts?: unknown; results?: unknown; data?: unknown };
      const arr = json.concepts ?? json.results ?? json.data;
      if (Array.isArray(arr)) concepts = arr as ConceptLike[];
    } catch (err) {
      return { shape: "structuredError", body: { resolver: "chain_fetch_failure_scan", detail: `concept-db fetch failed: ${(err as Error).message}` } };
    }
  }

  // 2. Flag concepts whose content carries fetch-failure markers.
  const hits: DegenerateHit[] = [];
  let scanned = 0;
  for (const c of concepts) {
    scanned += 1;
    const content = typeof c.content === "string" ? c.content : "";
    if (!content) continue;
    const m = markerRe.exec(content);
    if (!m) continue;
    const idx = Math.max(0, m.index - 20);
    hits.push({
      concept_id: typeof c.id === "string" ? c.id : `unknown-${hits.length}`,
      shape: typeof c.shape === "string" ? c.shape : "",
      snippet: content.slice(idx, idx + 120).replace(/\s+/g, " "),
    });
  }

  // 3. Emit ONE aggregated gap when the count crosses the threshold (unless dry_run).
  const triggered = hits.length >= threshold;
  let posted = false;
  let postStatus: number | "error" | undefined;
  if (triggered && !dryRun) {
    const body = {
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap: {
            // Single rolling id → idempotent: one open gap for the class, refreshed.
            id: "chain-fetch-failure-degenerate-mints",
            category: "trace_quality",
            source: "substrate_detected",
            summary:
              `${hits.length} recently-minted concepts carry fetch/data-flow failure markers ` +
              `(e.g. "401", "cannot access", "please provide the data") — authored chains whose ` +
              `http_fetch tasks failed (non-2xx) yet "completed", minting garbage. Sample shapes: ` +
              `${[...new Set(hits.map((h) => h.shape).filter(Boolean))].slice(0, 5).join(", ")}.`,
            detected_at: new Date().toISOString(),
            status: "open",
            classification_metadata: {
              gap_subtype: "chain_fetch_failure_degenerate_output",
              degenerate_count: hits.length,
              sample_concept_ids: hits.slice(0, 10).map((h) => h.concept_id),
              sample_snippets: hits.slice(0, 5).map((h) => h.snippet),
              remediation_hint:
                "Authored chains read substrate data over raw http_fetch GET, which 401s (http_fetch " +
                "auths only mutations) and violates 'resolvers live where data lives'. Re-author over " +
                "typed resolvers (e.g. resolver_pattern_report) or correct authenticated endpoints. " +
                "Mirrors the drafter typed-resolver / exact-endpoint guidance.",
            },
          },
        },
      },
    };
    try {
      const resp = await fetch(emitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      postStatus = resp.status;
      posted = resp.ok;
    } catch {
      postStatus = "error";
    }
  }

  return {
    shape: "chainFetchFailureReport",
    body: {
      scanned,
      degenerate_count: hits.length,
      threshold,
      triggered,
      posted,
      post_status: postStatus,
      hits: hits.slice(0, 20),
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
