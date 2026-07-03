// concept_credit_integrity_scan v0 skeleton: flags concepts whose usage posterior is degenerate
// (all-success with high volume — the blanket-credit / synthetic-backfill signature) so credit-signal
// corruption is caught by the substrate, not an operator audit.
import type { ResolverResult } from "./types.js";

export interface ConceptCreditIntegrityScanPointer {
  type: "concept_credit_integrity_scan";
  conceptDbBase?: string;
  min_loads?: number;
  limit?: number;
}

interface ConceptRow { id?: string; summary?: string; times_loaded?: number; times_succeeded?: number; loaded?: number; succeeded?: number }

export async function resolveConceptCreditIntegrityScan(pointer: ConceptCreditIntegrityScanPointer): Promise<ResolverResult> {
  const base = pointer.conceptDbBase ?? "http://127.0.0.1:8260";
  const minLoads = typeof pointer.min_loads === "number" ? pointer.min_loads : 100;
  const limit = typeof pointer.limit === "number" ? pointer.limit : 50;
  const offenders: Array<{ id: string; summary: string; loaded: number; succeeded: number }> = [];
  let scanned = 0;
  // Org-scoped read: without ApiKey auth the search resolves under org 'default'
  // and the org-scoped high-usage concepts are invisible (blind-window defect).
  const apiKey = process.env["METABOB_API_KEY"] ?? "";
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
  try {
    const res = await fetch(`${base}/concepts/search?limit=${limit}`, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
    const json = (await res.json()) as { concepts?: ConceptRow[] };
    for (const c of json.concepts ?? []) {
      scanned += 1;
      const loaded = c.times_loaded ?? c.loaded ?? 0;
      const succeeded = c.times_succeeded ?? c.succeeded ?? 0;
      // Degenerate posterior: high-volume, zero-failure credit — carries no information
      // and monopolizes relevance-ranked priming (rich-get-richer).
      if (loaded >= minLoads && succeeded >= loaded) {
        offenders.push({ id: String(c.id ?? ""), summary: String(c.summary ?? "").slice(0, 100), loaded, succeeded });
      }
    }
  } catch (err) {
    return { shape: "conceptCreditIntegrityReport", body: { scanned, offenders, error: err instanceof Error ? err.message.slice(0, 200) : String(err) } };
  }
  return { shape: "conceptCreditIntegrityReport", body: { scanned, degenerate_count: offenders.length, offenders, min_loads: minLoads } };
}
