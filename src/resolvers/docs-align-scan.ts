// docs_align_scan v0 stub: the dispatch case + shape registration landed without this
// resolver file (TS2307 broke dev-vessel typecheck, blocking all self-edit composes).
// Restored as an honest not-implemented skeleton so the shape is routable and verify
// passes; scan behavior iteration belongs to the loop (skeleton-then-behavior).
import type { ResolverResult } from "./types.js";

export interface DocsAlignScanPointer {
  type: "docs_align_scan";
  max_findings?: number;
}

export async function resolveDocsAlignScan(pointer: DocsAlignScanPointer): Promise<ResolverResult> {
  return {
    shape: "docsAlignReport",
    body: {
      implemented: false,
      findings: [],
      max_findings: typeof pointer.max_findings === "number" ? pointer.max_findings : 20,
      note: "v0 stub restored 2026-07-03 — dispatch case existed without resolver file; scan behavior not yet authored",
    },
  };
}
