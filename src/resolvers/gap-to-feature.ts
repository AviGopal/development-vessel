import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose } from "./feature-compose.js";
import { resolveSubstrateGap } from "./substrate-gap.js";

// Mirror feature-compose's path model: repos/<vessel>/... maps to the writable
// runtime ${RUNTIME_ROOT}/<vessel>/..., and the drafter writes proposal reports
// to <workspace>/proposals/<gapId>-report.json.
const RUNTIME_ROOT = process.env.MITOSIS_RUNTIME_DIR ?? "/vessels";
const PROPOSALS_DIR = process.env.PROPOSALS_DIR ?? "/workspace/proposals";

/** A repos/<vessel>/... path maps to an EXISTING file under the runtime root. */
function repoPathExists(repoRelative: string): boolean {
  try {
    return existsSync(join(RUNTIME_ROOT, repoRelative.replace(/^repos\//, "")));
  } catch {
    return false;
  }
}

/**
 * The unserved-quadrant fix (2026-06-23): a gap's drafter often writes a
 * patch_proposal naming the EXISTING file(s) that should change
 * (required_code_modifications[].file). Without surfacing those into the spec,
 * the composer's LLM freelances a NEW vessel (create_file ops) that has no
 * cutover clone and PHANTOM-lands. Reading the proposal and naming the concrete
 * existing targets in the spec steers the composer to `edit` ops on existing
 * source — which actually land. Only EXISTING files are returned; a proposal
 * naming a genuinely-new path is left for the composer to scaffold legitimately.
 */
function existingEditTargets(gapId: string): Array<{ file: string; description: string }> {
  try {
    const path = join(PROPOSALS_DIR, `${gapId}-report.json`);
    if (!existsSync(path)) return [];
    let raw = readFileSync(path, "utf8").trim();
    // Tolerant parse: drafters wrap JSON in ```json fences (sometimes multiple
    // concatenated objects — take the first balanced object).
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const end = raw.indexOf("}\n{");
    const firstObj = end > 0 ? raw.slice(0, end + 1) : raw;
    const parsed = JSON.parse(firstObj) as { required_code_modifications?: Array<{ file?: unknown; description?: unknown }> };
    const mods = Array.isArray(parsed.required_code_modifications) ? parsed.required_code_modifications : [];
    const out: Array<{ file: string; description: string }> = [];
    for (const m of mods) {
      const file = typeof m.file === "string" ? m.file : "";
      if (!file || !/^repos\/[^/]+\//.test(file)) continue;
      if (!repoPathExists(file)) continue; // only steer toward files that actually exist
      out.push({ file, description: typeof m.description === "string" ? m.description : "" });
    }
    return out;
  } catch {
    return [];
  }
}

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

function specFromGap(gap: Record<string, unknown>, editTargets: Array<{ file: string; description: string }> = []): string {
  const summary = String(gap.summary ?? gap.title ?? "");
  const meta = gap.classification_metadata ?? gap.metadata ?? null;
  const metaStr = meta ? `\n\nDetector evidence:\n${JSON.stringify(meta, null, 2)}` : "";
  // When a prior analysis named concrete EXISTING files as the change site, make
  // them the mandated edit targets — this is what keeps the composer producing
  // `edit` ops that land instead of scaffolding a new vessel that phantom-lands.
  const targetStr = editTargets.length
    ? [
        "",
        "REQUIRED: this gap has a known change site in EXISTING source. EDIT these files IN PLACE.",
        "Do NOT create a new vessel, package.json, or any new file — emit `edit` ops on these exact paths only:",
        ...editTargets.map((t) => `  - ${t.file}${t.description ? ` — ${t.description}` : ""}`),
      ].join("\n")
    : "";
  return [
    "Address the following substrate gap with the SMALLEST concrete, verifiable code change that resolves it.",
    "Prefer a minimal surgical edit to EXISTING vessel source. Only author a new file/vessel if the gap genuinely requires a capability no existing resolver provides, and then make it complete and dependency-free (Bun built-ins only).",
    "The change MUST typecheck. Name real files under repos/<vessel>/src/.",
    targetStr,
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

  // 2. Build a spec and route THROUGH the composer. If the gap's drafter
  // already named EXISTING change sites, inject them so the composer edits
  // existing source (lands) instead of scaffolding a new vessel (phantom).
  const editTargets = existingEditTargets(String(gap.id ?? ""));
  const spec = specFromGap(gap, editTargets);
  const compose = await resolveFeatureCompose({
    type: "feature_compose",
    spec,
    model: pointer.model,
    dry_run: pointer.dry_run ?? false,
    keep_on_fail: false,
    // Autonomous LAND: on FAVORABLE, push through vessel-mitosis-cutover (its
    // evidence+freshness gates are the self-verification; self-recovery is the
    // backstop). Suppressed in dry_run.
    land: !(pointer.dry_run ?? false),
  });

  const cb = compose.body as Record<string, unknown>;
  return {
    shape: "gapToFeatureReport",
    body: {
      ok: cb?.ok ?? cb?.verdict === "FAVORABLE",
      gap_id: gap.id,
      gap_category: gap.category,
      gap_summary: gap.summary,
      edit_targets: editTargets.map((t) => t.file),
      verdict: cb?.verdict ?? cb?.stage,
      compose: cb,
      note: cb?.verdict === "FAVORABLE"
        ? "LANDED autonomously via cutover (or staged if push gated); self-recovery is the backstop"
        : "composer could not produce a verified change for this gap (see compose.applied/verify)",
    },
  };
}
