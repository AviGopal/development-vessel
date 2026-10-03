import { existsSync } from "node:fs";
import { selfAuthHeaders } from "../lib/self-auth.js";
import type { ResolverResult } from "./types.js";
const DEFAULT_CONCEPT_SEARCH_URL = "http://127.0.0.1:8260/concepts/search";

export interface ConceptTruthProbePointer {
  type: "concept_truth_probe";
  query?: string;
  limit?: number;
  conceptDbUrl?: string;
}

export async function resolveConceptTruthProbe(pointer: ConceptTruthProbePointer): Promise<ResolverResult> {
  const baseUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_SEARCH_URL;
  const url = `${baseUrl}?q=${encodeURIComponent(pointer.query ?? "")}&limit=${pointer.limit ?? 8}`;
  // The key goes only to the configured concept-db (lib/self-auth.ts): none to a URL the pointer overrides.
  const headers: Record<string, string> = selfAuthHeaders(baseUrl, DEFAULT_CONCEPT_SEARCH_URL);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      return { shape: "structuredError", body: { resolver: "concept_truth_probe", detail: `concept-db search returned ${res.status}` } };
    }
    const json = (await res.json()) as { concepts?: unknown };
    const concepts = Array.isArray(json.concepts) ? json.concepts : [];
    const probeRe = /repos\/[\w.-]+\/[\w.\/-]+\.\w+/g;
    const probed = concepts.map((c: any) => {
      const content: string = c.content ?? "";
      const anchors = content.match(probeRe) ?? [];
      const verifiable = anchors.length > 0;
      let verified: boolean | null = null;
      let note = "no path anchors";
      if (verifiable) {
        const allExist = anchors.every((pth: string) => existsSync(`/workspace/${pth}`));
        verified = allExist;
        note = allExist ? "all paths exist" : "missing path";
      }
      const staleness_days = c.updated_at ? Math.floor((Date.now() - Date.parse(c.updated_at)) / 86400000) : null;
      return { concept_id: c.id, staleness_days, verifiable, verified, note };
    });
    const refuted_count = probed.filter((p) => p.verified === false).length;
    return { shape: "conceptTruthProbeReport", body: { probed, probed_count: probed.length, refuted_count, completed_at: new Date().toISOString() } };
  } catch (e: any) {
    return { shape: "structuredError", body: { resolver: "concept_truth_probe", detail: e?.message ?? String(e) } };
  }
}
