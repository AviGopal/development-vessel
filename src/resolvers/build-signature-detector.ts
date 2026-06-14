/**
 * build_signature_detector — the deterministic "draft" step of detector
 * authoring. Reads the highest-recurrence open detector_coverage_gap, binds the
 * generic signature_cluster_scan body to that gap's target_signature, and
 * registers a real `detect-<class>` activity through activity_create_variant
 * (the same registration path every authored activity uses). Marks the gap
 * status=closed with the authored variant id.
 *
 * Deterministic-by-design: the detector is mechanically determined by the
 * signature, so there is nothing for an LLM to hallucinate — this is MORE
 * semantically valid than a generated draft, not less. Semantic validity is
 * still gated downstream: the authored detector only earns Thompson weight if
 * the gaps it emits route to fixes that move metrics, and its registration
 * passes the I1..I6 permissive-scope invariants.
 *
 * Same loop as every other improvement: detect (detector_coverage_scan) →
 * draft (this) → register (activity_create_variant) → execute (the detector
 * fires) → validate (its emitted gaps route to fixes) → promote (template-
 * promote-tick) → select (Thompson). This is the substrate improving its
 * ability to improve, using the process it uses to improve everything.
 */

import { resolveActivityCreateVariant } from "./activity-create-variant.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";
import type { ResolverResult } from "./types.js";

export interface BuildSignatureDetectorPointer {
  type: "build_signature_detector";
  /** Optional: target a specific gap id; otherwise picks the top open one. */
  gap_id?: string;
}

interface TargetSignature {
  match: Record<string, unknown>;
  min_recurrence?: number;
  emit_gap_class: string;
  emit_summary?: string;
}

export async function resolveBuildSignatureDetector(pointer: BuildSignatureDetectorPointer): Promise<ResolverResult> {
  // 1. Find an open detector_coverage_gap.
  const read = await resolveSubstrateGap({ type: "substrateGap", category: "detector_coverage_gap", status: "open", limit: 50 } as never);
  const gaps = ((read.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? [])
    .filter((g) => !pointer.gap_id || g["id"] === pointer.gap_id);
  if (gaps.length === 0) {
    return { shape: "activityTemplateVariant", body: { authored: false, reason: "no_open_detector_coverage_gap", information_yield: "idle" } };
  }
  // Highest occurrence first.
  gaps.sort((a, b) => {
    const ca = Number((a["classification_metadata"] as Record<string, unknown>)?.["occurrence_count"] ?? 0);
    const cb = Number((b["classification_metadata"] as Record<string, unknown>)?.["occurrence_count"] ?? 0);
    return cb - ca;
  });
  const gap = gaps[0]!;
  const meta = (gap["classification_metadata"] as Record<string, unknown>) ?? {};
  const sig = meta["target_signature"] as TargetSignature | undefined;
  if (!sig || !sig.emit_gap_class) {
    return { shape: "activityTemplateVariant", body: { authored: false, reason: "gap_missing_target_signature", gap_id: gap["id"], information_yield: "idle" } };
  }

  const gapClass = sig.emit_gap_class;
  const detectorId = `development-vessel:detect-${gapClass}`;

  // 2. Build the detector activity — a one-task wrapper binding the generic body.
  const template = {
    id: detectorId,
    name: `detect-${gapClass}`,
    description:
      `Substrate-authored detector for problem class "${gapClass}". Binds the generic ` +
      `signature_cluster_scan body to a fixed match signature observed recurring without ` +
      `any existing detector covering it (authored from gap ${gap["id"]}). Emits a substrateGap ` +
      `of class ${gapClass} citing examples so the fix-drafter can act. Deterministic; no LLM.`,
    inputShapes: [] as string[],
    outputShapes: ["substrateGap"],
    tags: ["lift.autonomous.loop", "substrate.self.detection", "substrate.authored", "boredom_target_template"],
    variables: [] as unknown[],
    cited_concept_ids: ["concept_9ldsmRgqSTd5"],
    tasks: [
      {
        id: "scan_and_emit",
        description:
          `Run signature_cluster_scan bound to the observed signature and emit a ${gapClass} ` +
          `substrateGap when recurrence meets threshold. Deterministic detection + emission.`,
        resolver: "signature_cluster_scan",
        config: {
          type: "signature_cluster_scan",
          match: sig.match ?? {},
          min_recurrence: sig.min_recurrence ?? 3,
          emit_gap_class: gapClass,
          emit_summary: sig.emit_summary ?? `Observed {count}× occurrences of ${gapClass}.`,
        },
        outputShapes: ["substrateGap"],
      },
    ],
  };

  // 3. Register through the standard variant path (runs I1..I6 invariants).
  let variantId: string | null = null;
  let registerError: unknown = null;
  try {
    const res = await resolveActivityCreateVariant({ type: "activity_create_variant", template } as never);
    const b = res.body as { variantId?: string; structuredError?: unknown; error?: unknown };
    variantId = b.variantId ?? null;
    if (!variantId) registerError = b.structuredError ?? b.error ?? "no_variant_id";
  } catch (e) {
    registerError = e instanceof Error ? e.message : String(e);
  }

  // 4. Close the gap with provenance (only if authored).
  if (variantId) {
    try {
      await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: {
        ...gap,
        status: "closed",
        classification_metadata: { ...meta, authored_detector_id: detectorId, authored_variant_id: variantId, authored_at: new Date().toISOString() },
      } } as never);
    } catch { /* non-fatal */ }
  }

  return {
    shape: "activityTemplateVariant",
    body: {
      authored: !!variantId,
      detector_id: detectorId,
      variant_id: variantId,
      gap_id: gap["id"],
      gap_class: gapClass,
      register_error: registerError,
      information_yield: variantId ? "productive" : "error",
      completed_at: new Date().toISOString(),
    },
  };
}
