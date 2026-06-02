import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * observe-orthogonal-patterns — substrate-side cross-template synthesis.
 *
 * Composes existing aggregators (resolver_pattern_report,
 * trace_failure_pattern_report) and asks the LLM to surface ORTHOGONAL
 * learning signals across the activity catalogue:
 *
 *   1. MODIFY        — resolvers/templates whose recent success rate trails
 *                      the overall mean (rank candidates for variant work).
 *   2. CREATE_DETECTOR — failure_mode clusters with ≥3 occurrences that no
 *                      existing detection template covers (gap class).
 *   3. CREATE_CONSUMER — output_shapes produced but not consumed downstream
 *                      (orphan output shapes — wiring opportunity).
 *
 * Output is a JSON array of decisions written to /workspace/observations/
 * orthogonal-<timestamp>.json so the operator (and future substrate
 * activities) can compare iterations.
 *
 * This template is compose-only — it adds no resolver code. The LLM call is
 * dispatched via llm_completion_dispatch, keeping the LLM at the activity
 * layer per the three-layer discipline.
 *
 * Variables:
 *   out_path — absolute workspace path for the JSON observations file
 *              (default supplied at dispatch time).
 */
export const OBSERVE_ORTHOGONAL_PATTERNS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:observe-orthogonal-patterns",
  name: "observe-orthogonal-patterns",
  description:
    "Compose resolver_pattern_report + trace_failure_pattern_report, then " +
    "ask the LLM to classify orthogonal learning signals (MODIFY, " +
    "CREATE_DETECTOR, CREATE_CONSUMER) across the activity catalogue. " +
    "Writes a structured decision array to a workspace file for downstream " +
    "comparison and operator review. Compose-only — adds no resolver code.",
  inputShapes: [],
  outputShapes: ["fileWriteResult"],
  tags: [
    "substrate.self.observation",
    "orthogonal.learning",
    "modify.vs.create.decision",
    "cross.template.synthesis",
  ],
  variables: [
    {
      name: "out_path",
      description:
        "Absolute workspace path to write the orthogonal-decisions JSON " +
        "array (e.g. /workspace/observations/orthogonal-<timestamp>.json).",
    },
  ],
  tasks: [
    {
      id: "read_resolver_patterns",
      description:
        "Aggregate (resolver_id, output_shape) success rates across the " +
        "recent 24h trace window. Output drives MODIFY classification: " +
        "rows with low success_rate relative to total observations are " +
        "candidates for variant authoring.",
      resolver: "resolver_pattern_report",
      config: {
        type: "resolver_pattern_report",
        lookback_window_seconds: 86400,
        limit: 200,
        min_count: 1,
      },
      outputShapes: ["resolverPatternReport"],
    },
    {
      id: "read_failure_patterns",
      description:
        "Cluster recent failure traces by (activity_id, first_failed_task_id). " +
        "Clusters with high frequency that DO NOT match an existing detection " +
        "template name are CREATE_DETECTOR candidates.",
      resolver: "trace_failure_pattern_report",
      config: {
        type: "trace_failure_pattern_report",
        lookback_window_seconds: 86400,
        limit: 100,
        min_count: 1,
      },
      outputShapes: ["failurePatternReport"],
    },
    {
      id: "synthesize_decisions",
      description:
        "LLM synthesis across the two prior aggregator outputs. Asked to " +
        "produce a JSON array of decisions classified as MODIFY, " +
        "CREATE_DETECTOR, or CREATE_CONSUMER. Each decision carries target, " +
        "rationale, and evidence_trace_ids. Truncate aggregator outputs to " +
        "the top 10 entries each if interpolation would exceed token limits — " +
        "the prompt instructs the model to focus on top-ranked rows.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are the substrate's orthogonal-pattern observer. You have two " +
          "aggregations of the recent 24h trace window. Your job: emit a JSON " +
          "array of catalogue-change decisions, classified by KIND.\n\n" +
          "## resolverPatternReport (per resolver+output_shape success rate)\n\n" +
          "{{read_resolver_patterns_content}}\n\n" +
          "## failurePatternReport (failure clusters by template + first failed task)\n\n" +
          "{{read_failure_patterns_content}}\n\n" +
          "## Existing detection templates (do NOT propose CREATE_DETECTOR for these)\n\n" +
          "- detect-phantom-success-trace (status=success, task_count=0)\n" +
          "- detect-precondition-rejection (status=failure, task_count=0, duration<500ms)\n" +
          "- detect-stale-pointer\n" +
          "- detect-service-oom-cascade\n" +
          "- detect-recurring-pattern\n" +
          "- audit-dispatch-target-drift\n\n" +
          "## Task\n\n" +
          "Reply with ONLY a JSON array (no fences, no prose). Each element:\n\n" +
          "{\n" +
          '  "kind": "MODIFY" | "CREATE_DETECTOR" | "CREATE_CONSUMER",\n' +
          '  "target": "<resolver_id, template_id, failure_mode_signature, or output_shape>",\n' +
          '  "rationale": "<one sentence, cites the relevant aggregator row>",\n' +
          '  "evidence_trace_ids": ["<trace id or aggregator row key>", "..."]\n' +
          "}\n\n" +
          "Classification rubric:\n" +
          "- MODIFY: a (resolver_id, output_shape) row whose success_rate is " +
          "noticeably below the overall_success_rate, or any resolver whose " +
          "share of failures dominates. Target is the resolver_id or template " +
          "implicated.\n" +
          "- CREATE_DETECTOR: a failure cluster (≥3 occurrences) whose " +
          "(activity_id, first_failed_task_id) signature is NOT plausibly " +
          "covered by an existing detector listed above. Target is a short " +
          "failure-mode signature like '<template>:<task>'.\n" +
          "- CREATE_CONSUMER: an output_shape that appears in the resolver " +
          "report but has no obvious downstream consumer (most current " +
          "templates have inputShapes: []; treat any high-frequency output " +
          "shape with no matching downstream-input as orphan). Target is the " +
          "output_shape name.\n\n" +
          "If aggregator rows are sparse or empty, return [] — do NOT fabricate " +
          "decisions. Focus on the top 10 rows of each aggregator if there are " +
          "more.",
        max_tokens: 2000,
      },
      outputShapes: ["orthogonalDecisions"],
    },
    {
      id: "write_observations",
      description:
        "Persist the synthesized decisions to the workspace for operator " +
        "review and cross-iteration diffing. The path is supplied as a " +
        "variable so the dispatcher controls the timestamp suffix.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{out_path}}",
        content: "{{synthesize_decisions_content}}",
      },
      outputShapes: ["fileWriteResult"],
    },
  ],
};
