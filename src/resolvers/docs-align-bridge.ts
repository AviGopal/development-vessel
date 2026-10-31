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

/** One gap write the store ACCEPTED: the row it landed on, and its updated_at only when the answer carries one. */
export interface DocsAlignAcceptedWrite { gap_id: string; source: string; action: string; updated_at?: string }
/** One gap write the store did not accept (or whose answer does not say it saved), with what the answer said. */
export interface DocsAlignUnacceptedWrite { gap_id: string; source: string; reason: string }

/**
 * WHAT THE GAP WRITE'S ANSWER SAYS HAPPENED. The bridge used to discard the answer and count every source as an
 * emitted gap, so a refused write (consumption-gated, held row, unreadable holder, a write still queued for replay)
 * read as a gap filed. Only an answer that says the row was saved counts:
 *   - substrateGapWriteResult with action created or updated (the row it names is the one written);
 *   - compose_nudge_triggered naming this gap: the write saved, then nudged the compose lane.
 * A gap_service_start_failed error comes AFTER the save (the nudge's start failed), so it is "saved_unconfirmed":
 * listed apart, never counted. Every other answer is a refusal. An id in the answer is never acceptance: refusals
 * name the id too.
 */
export function classifyGapWriteAnswer(gapId: string, answer: ResolverResult | null | undefined):
  { kind: "accepted"; gap_id: string; action: string; updated_at?: string } | { kind: "saved_unconfirmed" | "refused"; reason: string } {
  const body = (answer?.body && typeof answer.body === "object" ? answer.body : {}) as Record<string, unknown>;
  const updatedAt = typeof body["updated_at"] === "string" && body["updated_at"] ? { updated_at: body["updated_at"] as string } : {};
  if (answer?.shape === "substrateGapWriteResult" && (body["action"] === "created" || body["action"] === "updated") && typeof body["id"] === "string" && body["id"]) {
    return { kind: "accepted", gap_id: body["id"] as string, action: body["action"] as string, ...updatedAt };
  }
  if (answer?.shape === "compose_nudge_triggered" && body["gapId"] === gapId) {
    return { kind: "accepted", gap_id: gapId, action: typeof body["action"] === "string" ? (body["action"] as string) : "saved", ...updatedAt };
  }
  if (answer?.shape === "structuredError" && body["error"] === "gap_service_start_failed") {
    return { kind: "saved_unconfirmed", reason: "gap_service_start_failed" };
  }
  const why = [body["failure_mode"], body["error"], body["skip_reason"], body["action"]].find((v) => typeof v === "string" && v) as string | undefined;
  return { kind: "refused", reason: `${answer?.shape ?? "no answer"}${why ? `:${why}` : ""}${body["queued"] === true ? " (queued, not applied)" : ""}` };
}

export async function resolveDocsAlignBridge(
  pointer: DocsAlignBridgePointer,
  // The gap write, injectable for tests; production always writes through resolveSubstrateGapWrite.
  writeGap: typeof resolveSubstrateGapWrite = resolveSubstrateGapWrite,
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
  const writes: DocsAlignAcceptedWrite[] = [];
  const saved_unconfirmed: DocsAlignUnacceptedWrite[] = [];
  const refused: DocsAlignUnacceptedWrite[] = [];

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

    // A dry run writes nothing: its sources are the ones a real run would write, and nothing is counted.
    if (pointer.dry_run) {
      sources.push(source);
      continue;
    }
    let answer: ResolverResult | null = null;
    try {
      answer = await writeGap({ type: "substrateGap_write", gap });
    } catch (err) {
      refused.push({ gap_id: gapId, source, reason: `threw: ${String((err as Error)?.message ?? err).slice(0, 200)}` });
      continue;
    }
    const v = classifyGapWriteAnswer(gapId, answer);
    if (v.kind === "accepted") {
      writes.push({ gap_id: v.gap_id, source, action: v.action, ...(v.updated_at ? { updated_at: v.updated_at } : {}) });
      sources.push(source);
    } else {
      (v.kind === "saved_unconfirmed" ? saved_unconfirmed : refused).push({ gap_id: gapId, source, reason: v.reason });
    }
  }

  return {
    shape: "docsAlignBridgeReport",
    body: {
      // ONLY writes the store accepted (none on a dry run); sources lists their sources (on a dry run, the would-be ones).
      gaps_emitted: writes.length,
      skipped,
      sources,
      writes,
      saved_unconfirmed,
      refused,
      dry_run: pointer.dry_run ?? false,
    },
  };
}
