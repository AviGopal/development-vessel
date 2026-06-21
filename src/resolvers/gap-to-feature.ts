import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose } from "./feature-compose.js";
import { resolveSubstrateGap } from "./substrate-gap.js";

/**
 * gap_to_feature (2026-06-21) — closes the autonomy loop: routes maintenance-
 * detector gaps THROUGH the feature composer.
 *
 * detect (detectors emit substrateGap) -> SPEC (this bridge) -> author
 * (feature_compose) -> verify (typecheck) -> stage. This is the piece that lets
 * the substrate maintain/upkeep what it writes: a gap a detector raises (incl.
 * the new db_contention gap, and the model-opportunity gaps that the surgical
 * gate used to REFUSE as non_surgical) now becomes an authored, verified change.
 *
 * SAFETY: FAVORABLE results are STAGED (left in the /vessels runtime), NOT
 * auto-pushed — landing flows through the existing cutover gate / operator.
 * UNFAVORABLE rolls back (feature_compose does this). So the loop is autonomous
 * up to a verified staged change; deploying AI-authored code stays gated.
 */
export interface GapToFeaturePointer {
  type: "gap_to_feature";
  /** Specific gap id to address; if absent, pick the first open gap (optionally filtered). */
  gap_id?: string;
  /** Filter open gaps by category when picking (e.g. "db_contention", "model-opportunity"). */
  category?: string;
  model?: string;
  /** Plan only (do not apply). */
  dry_run?: boolean;
  /** How many open gaps to consider when auto-picking. */
  limit?: number;
}

function specFromGap(gap: Record<string, unknown>): string {
  const summary = String(gap.summary ?? gap.title ?? "");
  const meta = gap.classification_metadata ?? gap.metadata ?? null;
  const metaStr = meta ? `\n\nDetector evidence:\n${JSON.stringify(meta, null, 2)}` : "";
  return [
    "Address the following substrate gap with the SMALLEST concrete, verifiable code change that resolves it.",
    "Prefer a minimal surgical edit to EXISTING vessel source. Only author a new file/vessel if the gap genuinely requires a capability no existing resolver provides, and then make it complete and dependency-free (Bun built-ins only).",
    "The change MUST typecheck. Name real files under repos/<vessel>/src/.",
    "",
    `GAP: ${summary}`,
    metaStr,
  ].join("\n");
}

export async function resolveGapToFeature(pointer: GapToFeaturePointer): Promise<ResolverResult> {
  // 1. Select a gap.
  let gap: Record<string, unknown> | null = null;
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      ...(pointer.category ? { category: pointer.category } : {}),
      status: "open",
      limit: pointer.limit ?? 25,
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    gap = pointer.gap_id
      ? gaps.find((g) => g.id === pointer.gap_id) ?? null
      : gaps[0] ?? null;
  } catch (e) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: (e as Error).message } };
  }
  if (!gap) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: "no matching open gap", category: pointer.category ?? null } };
  }

  // 2. Build a spec and route THROUGH the composer.
  const spec = specFromGap(gap);
  const compose = await resolveFeatureCompose({
    type: "feature_compose",
    spec,
    model: pointer.model,
    dry_run: pointer.dry_run ?? false,
    // STAGE on success (do not keep on fail — feature_compose rolls back UNFAVORABLE).
    keep_on_fail: false,
  });

  const cb = compose.body as Record<string, unknown>;
  return {
    shape: "gapToFeatureReport",
    body: {
      ok: cb?.ok ?? cb?.verdict === "FAVORABLE",
      gap_id: gap.id,
      gap_category: gap.category,
      gap_summary: gap.summary,
      verdict: cb?.verdict ?? cb?.stage,
      compose: cb,
      note: cb?.verdict === "FAVORABLE"
        ? "STAGED + typecheck-clean in the /vessels runtime — route to the cutover gate to land"
        : "composer could not produce a verified change for this gap (see compose.applied/verify)",
    },
  };
}
