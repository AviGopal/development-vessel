import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-stale-pointer — deterministic stale-pointer detector + gap emitter.
 *
 * History: the prior version chained an http_fetch over the full concept
 * corpus into an LLM heuristic scan, which both (a) overflowed Anthropic's
 * 200K prompt cap on large corpora and (b) used the LLM for what is
 * fundamentally a deterministic yes/no filesystem check.
 *
 * The rewrite drops the LLM entirely. A single resolver
 * (`stale_pointer_emit`) does the whole flow in one server-side step:
 *
 *   1. GET concept-db /concepts/search?limit=500 (auto-attached ApiKey).
 *   2. For each concept with a non-empty pointer.path (or
 *      metadata.doc_path fallback), stat the file on the substrate
 *      filesystem.
 *   3. For each missing path, POST a substrateGap_write to development-
 *      vessel /v2/impulses/resolve. classification_metadata carries
 *      gap_subtype=stale_concept_pointer.
 *   4. Return a stalePointerReport summary.
 *
 * Single-task template — the resolver collapses the prior pipeline. If
 * concept count grows beyond 500, the resolver gains a pagination loop
 * (it does NOT propagate up to this template).
 *
 * Spec: openspec/changes/2026-05-30-doc-ingestion-and-concept-management/
 */

export const DETECT_STALE_POINTER_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-stale-pointer",
  name: "detect-stale-pointer",
  description:
    "Scans concept-db for concepts whose pointer.path no longer resolves on " +
    "disk. Deterministic check (Bun.file stat per concept; no LLM). Emits a " +
    "substrateGap impulse per stale concept with " +
    "classification_metadata.gap_subtype='stale_concept_pointer'. Drops the " +
    "prior LLM-heuristic path, which overflowed the prompt cap on large " +
    "corpora and was unsound for what is a yes/no filesystem check.",
  inputShapes: [],
  outputShapes: ["substrateGap", "stalePointerReport"],
  tags: [
    "lift.autonomous.loop",
    "concept.management",
    "substrate.knowledge.curation",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Run the stale-pointer scan + gap-emission in one server-side step. " +
        "Returns a stalePointerReport with scanned/with_pointer_path/readable/" +
        "stale_count and the list of stale entries (each carrying post_status).",
      resolver: "stale_pointer_emit",
      config: {
        type: "stale_pointer_emit",
        dry_run: false,
        maxEmits: 50,
      },
      outputShapes: ["stalePointerReport"],
    },
  ],
};
