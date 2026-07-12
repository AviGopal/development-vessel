import type { ResolverResult } from "./types.js";
import { resolveSubstrateGap } from "./substrate-gap.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";
import { resolveUiWritePassthrough } from "./ui-write-passthrough.js";

export interface DocsDecisionSolicitPointer {
  type: "docs_decision_solicit";
  dry_run?: boolean;
  limit?: number;
}

interface DriftClaim {
  quote?: string;
  contradicted_by?: string;
  correction_hint?: string;
}

interface DocFix {
  status?: string;
  reason?: string;
}

interface ClassificationMetadata {
  doc_fix?: DocFix;
  awaiting_human?: boolean;
  solicited_at?: string;
  [key: string]: unknown;
}

interface DriftReport {
  claims?: DriftClaim[];
}

interface SubstrateGap {
  id: string;
  category: string;
  source?: string;
  summary?: string;
  detected_at?: string;
  status?: string;
  classification_metadata?: ClassificationMetadata;
  drift_report?: DriftReport;
  doc_path?: string;
  [key: string]: unknown;
}

const DECISION_STATUSES = new Set(["reach_unfavorable", "draft_failed", "no_anchor"]);
const METABOB_RE = /metabob/i;

function needsHumanDecision(gap: SubstrateGap): boolean {
  const cm = gap.classification_metadata;
  const docFixStatus = cm?.doc_fix?.status;
  if (docFixStatus && DECISION_STATUSES.has(docFixStatus)) {
    return true;
  }
  const claims = gap.drift_report?.claims ?? [];
  for (const claim of claims) {
    if (
      (claim.quote && METABOB_RE.test(claim.quote)) ||
      (claim.correction_hint && METABOB_RE.test(claim.correction_hint))
    ) {
      return true;
    }
  }
  return false;
}

function buildBody(gap: SubstrateGap): string {
  const claims = gap.drift_report?.claims ?? [];
  const cm = gap.classification_metadata;
  const docFix = cm?.doc_fix;

  const claimLines = claims
    .map((c, i) => {
      const parts: string[] = [`Claim ${i + 1}:`];
      if (c.quote) parts.push(`  Quote: "${c.quote}"`);
      if (c.contradicted_by) parts.push(`  Contradicted by: ${c.contradicted_by}`);
      if (c.correction_hint) parts.push(`  Correction hint: ${c.correction_hint}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const autoFixSection = docFix
    ? `Auto-fix outcome:\n  Status: ${docFix.status ?? "unknown"}\n  Reason: ${docFix.reason ?? "none"}`
    : "Auto-fix outcome: no doc_fix metadata recorded";

  return [
    `Documentation alignment issue detected for: ${gap.doc_path ?? gap.source ?? gap.id}`,
    "",
    claimLines || "(no claims recorded)",
    "",
    autoFixSection,
    "",
    "The substrate could not resolve this automatically. A human decision is needed: please review the claims above and decide the correct documentation text or whether the project name/identity should be updated.",
  ].join("\n");
}

export async function resolveDocsDecisionSolicit(
  pointer: DocsDecisionSolicitPointer,
): Promise<ResolverResult> {
  const dry_run = pointer.dry_run ?? false;
  const limit = pointer.limit ?? 50;

  const gapResult = await resolveSubstrateGap({
    type: "substrateGap",
    category: "documentation_drift",
    status: "open",
    limit,
  });

  const rawGaps: SubstrateGap[] =
    Array.isArray((gapResult.body as { gaps?: unknown }).gaps)
      ? ((gapResult.body as { gaps: SubstrateGap[] }).gaps)
      : [];

  let gaps_considered = rawGaps.length;
  let solicited = 0;
  let skipped_awaiting = 0;

  for (const gap of rawGaps) {
    try {
      if (gap.classification_metadata?.awaiting_human === true) {
        skipped_awaiting++;
        continue;
      }

      if (!needsHumanDecision(gap)) {
        continue;
      }

      const docPath: string = typeof gap.doc_path === "string" ? gap.doc_path : (gap.source ?? gap.id);
      const claims = gap.drift_report?.claims ?? [];

      await resolveUiWritePassthrough({
        type: "uiQuestion_write",
        id: `docs-decision-${gap.id}`,
        kind: "docs_alignment_decision",
        importance: "high",
        title: `Docs decision needed: ${docPath}`,
        body: buildBody(gap),
        asks: claims.map((c) => ({
          claim: c.quote ?? "",
          hint: c.correction_hint ?? "",
        })),
      });

      if (!dry_run) {
        const existingMeta: ClassificationMetadata = gap.classification_metadata ?? {};
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: gap.id,
            category: gap.category,
            source: gap.source ?? "",
            summary: gap.summary ?? "",
            detected_at: gap.detected_at ?? new Date().toISOString(),
            classification_metadata: {
              ...existingMeta,
              awaiting_human: true,
              solicited_at: new Date().toISOString(),
            },
            status: "open",
          },
        });
      }

      solicited++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[docs-decision-solicit] best-effort gap=${gap.id} error: ${msg}`);
    }
  }

  return {
    shape: "docsDecisionSolicitReport",
    body: {
      gaps_considered,
      solicited,
      skipped_awaiting,
      dry_run,
    },
  };
}
