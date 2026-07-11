import { resolveSubstrateGapWrite } from "./substrate-gap.js";
import type { ResolverResult } from "./types.js";

export interface DocsAlignFinding {
  doc_id: string;
  invariant: string;
  evidence: string;
  suggested_repair: string;
  source?: string;
  note?: string;
}

interface DocsAlignBridgePointer {
  type: "docs_align_bridge";
  report?: { findings?: DocsAlignFinding[] };
  findings?: DocsAlignFinding[];
  dry_run?: boolean;
}

export async function resolveDocsAlignBridge(
  pointer: DocsAlignBridgePointer,
): Promise<ResolverResult> {
  const allFindings: DocsAlignFinding[] =
    pointer.report?.findings ?? pointer.findings ?? [];

  const usable = allFindings.filter(
    (f) => f.evidence !== "" && f.source !== undefined && f.source !== "",
  );
  const skipped = allFindings.length - usable.length;

  // Group by source
  const bySource = new Map<string, DocsAlignFinding[]>();
  for (const f of usable) {
    const src = f.source as string;
    const bucket = bySource.get(src);
    if (bucket) {
      bucket.push(f);
    } else {
      bySource.set(src, [f]);
    }
  }

  const sources: string[] = [];
  let gaps_emitted = 0;

  for (const [source, claims] of bySource) {
    const uniqueInvariants = [...new Set(claims.map((f) => f.invariant))];
    const gapId =
      "docs-drift-" +
      source.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");

    const gap = {
      id: gapId,
      category: "documentation_drift",
      source: "substrate_detected",
      summary:
        "documentation drift in " +
        source +
        ": " +
        claims.length +
        " invariant violation(s) [" +
        uniqueInvariants.join(", ") +
        "]",
      detected_at: new Date().toISOString(),
      status: "open",
      classification_metadata: {
        doc_path: source,
        drift_report: {
          claims: claims.map((f) => ({
            quote: f.evidence,
            contradicted_by: f.invariant,
            correction_hint: f.suggested_repair,
          })),
        },
      },
    };

    if (!pointer.dry_run) {
      await resolveSubstrateGapWrite({ type: "substrateGap_write", gap });
    }

    sources.push(source);
    gaps_emitted += 1;
  }

  return {
    shape: "docsAlignBridgeReport",
    body: {
      gaps_emitted,
      skipped,
      sources,
      dry_run: pointer.dry_run ?? false,
    },
  };
}
