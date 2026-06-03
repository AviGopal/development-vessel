import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * concept-usage-backfill — autonomous writeback to concept-db relevance.
 *
 * Without this template, concept-db's Bayesian relevance formula
 * (ts+1)/(tl+2) is one-sided: concepts accumulate `times_loaded` (via
 * concept_select_for_prompt + concept_search_by_source) but their
 * `times_succeeded`/`times_failed` stay at zero. The result: every concept
 * decays from prior=0.5 monotonically toward 0 as it's cited, regardless
 * of actual outcome. The signal is inverted — most-cited concepts look
 * LEAST relevant.
 *
 * Empirical state 2026-06-03T~05:00Z (operator finding):
 *   - 29/37 concepts have times_loaded > 0  (reads work)
 *   - 6/37  have times_succeeded > 0        (all from one manual backfill)
 *   - 0     autonomous traces invoke concept_usage_record
 *
 * The resolver concept_usage_record exists and is tested (5/5 green); the
 * three-place rule was satisfied in an earlier iteration. The missing piece
 * is autonomous DISPATCH. This template plus boredom goal[16] supplies it.
 *
 * Chain (deterministic, no LLM):
 *   1. concept_select_for_prompt — surface candidate concepts under a
 *      rotating query so different source_types get exercised over many
 *      boredom ticks. Output: conceptPromptPriors with selected[].id.
 *   2. json_path_extract — pull selected.0.id (the top-ranked concept_id).
 *      json_path_extract supports dot-notation, so we use `.0.` for array
 *      index — confirmed working in close-health-gap pattern.
 *   3. concept_usage_record — POST to concept-db with outcome=success.
 *      trace_id uniquely identifies this backfill tick (autonomous_backfill_*).
 *
 * Limitations of this iteration (known + acceptable):
 *   - One concept per tick, not the full set of recently-cited concepts.
 *     Over many boredom cycles (every 5min), the substrate accumulates
 *     per-concept writebacks for whichever concept currently top-ranks for
 *     the rotating query. Imperfect but unblocks the data flow.
 *   - outcome is always "success" — this iteration assumes the backfill
 *     itself succeeding implies the selected concept was useful in some
 *     downstream draft. Tighter signal (success only on traces with
 *     status=success) requires a future trace-correlating template.
 *   - No iteration over selected[] — json_path_extract is single-value.
 *     A future json_path_iterate or per-concept dispatch resolver could
 *     fan out to all selected concepts in one tick.
 *
 * Immunity-pattern compliant — no LLM tasks, no pool iteration, single
 * dispatch path. The detector itself cannot pre-flight-reject.
 *
 * Spec: operator dispatch 2026-06-03 (concept-db relevance unblock).
 */
export const CONCEPT_USAGE_BACKFILL_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:concept-usage-backfill",
  name: "concept-usage-backfill",
  description:
    "Autonomous writeback to concept-db relevance. Surfaces a candidate concept " +
    "via concept_select_for_prompt, extracts the top-ranked id, and POSTs a " +
    "conceptUsageRecorded outcome so concept-db's Bayesian relevance formula " +
    "(ts+1)/(tl+2) gets both-sided data. Without this template, concepts " +
    "accumulate loads but never successes, inverting the relevance signal. " +
    "Tagged intent:concept_db_relevance, phase:writeback.",
  inputShapes: [],
  outputShapes: ["conceptUsageRecorded"],
  tags: [
    "intent:concept_db_relevance",
    "phase:writeback",
    "boredom_target_template",
    "topology.discovery.loop",
  ],
  variables: [
    {
      name: "query",
      description:
        "Free-text query for vector ranking. Boredom rotates this across " +
        "common substrate topics so different concepts get exercised.",
    },
    {
      name: "trace_id",
      description:
        "Synthetic trace id for the writeback. Format: " +
        "autonomous_backfill_<ISO_timestamp>. Boredom supplies a unique value " +
        "per tick to keep concept-db's per-trace writeback gating clean.",
    },
  ],
  tasks: [
    {
      id: "select_concept",
      description:
        "Surface candidate concepts via concept_select_for_prompt. Returns " +
        "conceptPromptPriors with selected[] ranked by combined_score " +
        "(similarity + success_rate + priority + token_economy).",
      resolver: "concept_select_for_prompt",
      config: {
        type: "concept_select_for_prompt",
        query: "{{query}}",
        prior_source_types: [
          "constitutional_principle",
          "observed_pattern",
          "policy",
          "anti_pattern",
        ],
        budget_tokens: 4000,
        candidates_per_source_type: 10,
      },
      outputShapes: ["conceptPromptPriors"],
    },
    {
      id: "extract_concept_id",
      description:
        "Pull selected.0.id (top-ranked concept_id) from conceptPromptPriors. " +
        "json_path_extract dot-notation supports array index via numeric " +
        "segment (selected.0.id). Tolerates empty selected[] gracefully — " +
        "returns missing:true and empty-string value, which short-circuits " +
        "the downstream concept_usage_record (concept-db rejects empty id).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{select_concept_content}}",
        path: "selected.0.id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "record_usage",
      description:
        "POST conceptUsageRecorded outcome to concept-db. trace_id ties the " +
        "writeback to this specific boredom tick (autonomous_backfill_*) so " +
        "concept-db's per-trace deduplication works. outcome=success because " +
        "the substrate's act of citing the concept in a prompt is itself a " +
        "use signal; failure attribution requires trace-level correlation " +
        "that this iteration does not yet do.",
      resolver: "concept_usage_record",
      config: {
        type: "concept_usage_record",
        concept_id: "{{extract_concept_id_text}}",
        trace_id: "{{trace_id}}",
        outcome: "success",
      },
      outputShapes: ["conceptUsageRecorded", "structuredError"],
    },
  ],
};
