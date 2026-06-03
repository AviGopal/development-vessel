import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-concept-db-drift — detects concept-db hygiene gaps:
 * duplicate clusters and cold-start (never-used) concepts.
 *
 * Both openspecs that reference this need:
 *   - openspec/changes/2026-06-01-concept-db-supersession-and-chunker-hygiene/
 *   - openspec/changes/2026-06-01-concept-db-upkeep-loop/
 * note that `detect-concept-db-upkeep-gaps` should exist but doesn't.
 * This template fills that gap.
 *
 * Two drift patterns are detected:
 *
 *   1. **Duplicate clusters** (trivial_gap): concepts that share identical
 *      shape + content. Accumulate when ribosome or ingest-doc-as-concepts
 *      runs without supersession checks, producing semantically identical
 *      nodes that split Thompson posteriors and inflate the corpus.
 *
 *   2. **Cold-start concepts** (never_used): concepts with times_loaded=0
 *      AND times_succeeded=0 across all source types. These were created
 *      (by extraction, seeding, or human input) but have never influenced
 *      any execution. They consume embedding slots and bias search recall
 *      without contributing to learning.
 *
 * Three tasks:
 *   Task 1 (detect-duplicates): broad GET sample → LLM identifies clusters
 *   Task 2 (detect-cold-start): filtered GET by source_type → count cold
 *   Task 3 (emit-drift-report): LLM synthesizes findings into
 *             conceptDbDriftReport impulse
 *
 * Constitutional principle (concept_9ldsmRgqSTd5,
 * substrate_self_detection_principle): every observed bug class becomes a
 * detection template, not just a patched instance.
 */

export const DETECT_CONCEPT_DB_DRIFT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-concept-db-drift",
  name: "detect-concept-db-drift",
  description:
    "Detects two concept-db hygiene gaps: (1) duplicate clusters — concepts " +
    "sharing identical shape+content that split Thompson posteriors (trivial_gap " +
    "pattern); (2) cold-start concepts — concepts with times_loaded=0 AND " +
    "times_succeeded=0 that were created but have never influenced an execution. " +
    "Samples concept-db via HTTP, classifies with LLM, and synthesizes findings " +
    "into a conceptDbDriftReport impulse. No writes — detection only.",
  inputShapes: [],
  outputShapes: ["conceptDbDriftReport"],
  tags: ["concept-db", "upkeep", "detection", "substrate-health"],
  variables: [],
  tasks: [
    {
      id: "detect_duplicates",
      description:
        "GET a broad sample of concepts from concept-db (limit=50, min_relevance=0.0) " +
        "to collect shape+content pairs. The LLM sub-step identifies clusters where " +
        "two or more concepts share identical or near-identical shape AND content " +
        "(the trivial_gap pattern). Returns a raw JSON list for the synthesizer.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "http://127.0.0.1:8260/concepts/search?limit=50&min_relevance=0.0",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["conceptSample"],
    },
    {
      id: "detect_cold_start",
      description:
        "GET concepts filtered by the most common creation source_types " +
        "(memo, extracted, human_input, vessel_construction_pattern, limit=30). " +
        "Count how many have times_loaded=0 AND times_succeeded=0. Report the " +
        "count and percentage as a cold_start_summary for the synthesizer.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "http://127.0.0.1:8260/concepts/search?source_type=memo,extracted,human_input,vessel_construction_pattern&limit=30",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["conceptSourceSample"],
    },
    {
      id: "emit_drift_report",
      description:
        "Synthesize findings from detect_duplicates and detect_cold_start into a " +
        "single conceptDbDriftReport. The report includes: duplicate_clusters (list " +
        "of {ids, shape, content_hash}), cold_start_count, cold_start_pct, " +
        "total_sampled, and a drift_severity of 'none' | 'low' | 'medium' | 'high' " +
        "based on the findings. Output only the JSON report object.",
      resolver: "llm",
      prompt: {
        template:
          "You are a substrate health auditor. Analyse the two concept-db samples below " +
          "and produce a conceptDbDriftReport JSON object. Output ONLY the JSON — no fences, no prose.\n\n" +
          "## Sample A — broad concept sample (limit=50, min_relevance=0.0)\n\n" +
          "{{detect_duplicates_content}}\n\n" +
          "## Sample B — source-type-filtered sample (memo/extracted/human_input/vessel_construction_pattern, limit=30)\n\n" +
          "{{detect_cold_start_content}}\n\n" +
          "## Output contract\n\n" +
          "{\n" +
          "  \"total_sampled\": <number of unique concepts across both samples>,\n" +
          "  \"duplicate_clusters\": [\n" +
          "    { \"ids\": [\"<id1>\", \"<id2>\"], \"shape\": \"<shared shape>\", \"content_preview\": \"<first 80 chars of shared content>\" }\n" +
          "  ],\n" +
          "  \"cold_start_count\": <count of concepts with times_loaded=0 AND times_succeeded=0 in Sample B>,\n" +
          "  \"cold_start_pct\": <cold_start_count / total in Sample B * 100, rounded to 1 decimal>,\n" +
          "  \"drift_severity\": \"none\" | \"low\" | \"medium\" | \"high\",\n" +
          "  \"notes\": \"<one sentence summary of the most significant finding, or 'no drift detected'>\"\n" +
          "}\n\n" +
          "Severity guide: none=0 duplicates AND cold_start_pct<10%; " +
          "low=1-2 duplicate pairs OR cold_start_pct 10-25%; " +
          "medium=3-5 pairs OR cold_start_pct 25-50%; " +
          "high=>5 pairs OR cold_start_pct>50%.",
      },
      outputShapes: ["conceptDbDriftReport"],
    },
  ],
};
