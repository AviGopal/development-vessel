import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * recover-from-goal-failure — structured recovery orchestrator for failed goal executions.
 *
 * Given a failed execution trace ID, fetches the trace, extracts the failure_mode
 * context deterministically via LLM, and dispatches the appropriate recovery action
 * to goal-host-vessel:
 *
 *   - create_shape_provider → dispatch a sub-goal to produce the missing input shape
 *     (wires to goal-host's /run-goal with targetTemplateId pointing to
 *     create-shape-provider-goal if it exists in the registry, otherwise open-ended)
 *   - retry_with_different_template → re-dispatch the original goal with the failed
 *     template in the exclude list so Thompson picks a different candidate
 *   - create_variant → dispatch draft-gap-closing-activity for a structural gap
 *   - reduce_scope → re-dispatch with a narrowed goal description
 *   - give_up → emit a goalRecoveryAction with recovery_attempted=false
 *
 * The final summarize_recovery task compiles the recovery context into a
 * goalRecoveryAction impulse that the calling orchestrator (goal-execution-with-retry)
 * can use for Thompson feedback and human observability.
 *
 * Composable standalone: can be dispatched directly by boredom-vessel on any
 * failed execution trace, or as a sub-activity of goal-execution-with-retry.
 */
export const RECOVER_FROM_GOAL_FAILURE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:recover-from-goal-failure",
  name: "recover-from-goal-failure",
  description:
    "Given a failed execution trace ID (failed_execution_id), fetches the trace, " +
    "extracts the failure context (failure_type, missing shapes, recommended_action, " +
    "exclude_template_ids), and dispatches the appropriate recovery to goal-host-vessel. " +
    "Recovery actions: create_shape_provider (sub-goal), retry_with_different_template " +
    "(exclude failed template), create_variant (draft-gap-closing-activity), " +
    "reduce_scope (narrowed re-dispatch), give_up (emit non-retry result). Emits a " +
    "goalRecoveryAction summary for Thompson feedback. Composes with " +
    "goal-execution-with-retry or runs standalone.",
  inputShapes: [],
  outputShapes: ["goalRecoveryAction"],
  tags: ["goal-execution", "recovery", "failure-mode", "composable"],
  variables: [
    {
      name: "failed_execution_id",
      description: "Execution trace ID of the failed goal execution to recover from",
    },
    {
      name: "original_goal",
      description: "The original goal text that was being executed when the failure occurred",
    },
    {
      name: "expected_output_shapes",
      description:
        "JSON array of shapes the goal was expected to produce (may be empty string if unknown)",
    },
  ],
  tasks: [
    {
      id: "fetch_failed_trace",
      description:
        "Fetch the full execution trace for the failed execution from activity-api. " +
        "Returns the trace JSON including failure_mode, tasks, input/output impulse ids, " +
        "and the template that was executing when the failure occurred.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8080/v2/activities/execution-traces/{{failed_execution_id}}",
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: 5000,
      },
      outputShapes: ["failedExecutionTrace"],
    },
    {
      id: "extract_failure_context",
      description:
        "Extract structured failure context from the trace JSON: the failure_mode type, " +
        "the template that failed, shapes produced vs expected, any missing input shapes, " +
        "a recommended recovery action, and template IDs to exclude from future retries. " +
        "Returns a failureContext JSON object.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are a goal execution recovery planner. Analyze this failed execution trace " +
          "and determine the best recovery action.\n\n" +
          "## Failed execution trace\n\n" +
          "{{fetch_failed_trace_content}}\n\n" +
          "## Original goal\n\n" +
          "{{original_goal}}\n\n" +
          "## Expected output shapes (caller constraint)\n\n" +
          "{{expected_output_shapes}}\n\n" +
          "## Recovery action definitions\n\n" +
          "- retry_with_different_template: The template structure is likely fine but this " +
          "  specific variant failed — exclude it and let Thompson pick the next best match.\n" +
          "- create_shape_provider: The template is missing a required input shape — dispatch " +
          "  a sub-goal to produce that shape first, then retry.\n" +
          "- create_variant: The failure_mode suggests a structural gap in the activity " +
          "  registry — draft a new variant via draft-gap-closing-activity.\n" +
          "- reduce_scope: The goal is too broad for available templates — narrow it.\n" +
          "- give_up: Retries are unlikely to help (e.g. permanent infrastructure failure, " +
          "  safety_breach, or budget exhausted with no alternative).\n\n" +
          "Output ONLY the JSON object below — no fences, no prose:\n\n" +
          "{\n" +
          '  "failure_type": "<verifier_negative|budget_exhausted|safety_breach|cascading|user_abort|unknown>",\n' +
          '  "failed_template_id": "<template id from trace, or null>",\n' +
          '  "output_shapes_produced": ["<shape>", "..."],\n' +
          '  "output_shapes_expected": ["<shape>", "..."],\n' +
          '  "missing_input_shapes": ["<shape>", "..."],\n' +
          '  "recommended_action": "retry_with_different_template|create_shape_provider|create_variant|reduce_scope|give_up",\n' +
          '  "exclude_template_ids": ["<id>", "..."]\n' +
          "}",
        model: "auto",
        max_tokens: 600,
      },
      outputShapes: ["failureContext"],
    },
    {
      id: "dispatch_recovery",
      description:
        "Dispatch the recovery action to goal-host-vessel based on the recommended_action " +
        "from extract_failure_context. For create_shape_provider: dispatch a sub-goal to " +
        "produce the first missing input shape. For all other actions (including " +
        "retry_with_different_template, create_variant, reduce_scope): re-dispatch the " +
        "original goal with the failed template excluded so Thompson Sampling picks a " +
        "different candidate. For give_up: dispatch a no-op probe goal that will complete " +
        "quickly. The LLM constructs the correct POST body from the failure context and " +
        "POSTs it to goal-host-vessel.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are a recovery dispatcher. Based on the failure context below, you need to " +
          "construct and POST the correct recovery request to goal-host-vessel.\n\n" +
          "## Failure context\n\n" +
          "{{extract_failure_context_content}}\n\n" +
          "## Original goal\n\n" +
          "{{original_goal}}\n\n" +
          "## POST endpoint\n\n" +
          "http://127.0.0.1:8210/run-goal\n\n" +
          "## Dispatch rules\n\n" +
          "If recommended_action = 'create_shape_provider' and missing_input_shapes is non-empty:\n" +
          "  POST body: {\"goal\": \"produce shape: <first missing shape>\", " +
          "\"targetTemplateId\": \"development-vessel:create-shape-provider-goal\"}\n\n" +
          "If recommended_action = 'create_variant':\n" +
          "  POST body: {\"goal\": \"draft gap-closing activity for failed template " +
          "<failed_template_id>\", \"targetTemplateId\": " +
          "\"development-vessel:draft-gap-closing-activity\"}\n\n" +
          "If recommended_action = 'give_up':\n" +
          "  Do NOT dispatch. Return: {\"skipped\": true, \"reason\": \"give_up\"}\n\n" +
          "Otherwise (retry_with_different_template, reduce_scope, unknown):\n" +
          "  POST body: {\"goal\": \"{{original_goal}}\", \"variables\": " +
          "{\"excludeActivities\": \"<comma-separated exclude_template_ids>\", " +
          "\"expectedOutputShapes\": \"{{expected_output_shapes}}\"}}\n\n" +
          "Output ONLY the JSON object that was returned from the POST (or the " +
          "skipped object) — no fences, no prose.",
        model: "auto",
        max_tokens: 800,
      },
      outputShapes: ["recoveryDispatch"],
    },
    {
      id: "summarize_recovery",
      description:
        "Compile the failure context and dispatch result into a structured goalRecoveryAction " +
        "summary for Thompson feedback and human observability. Records whether recovery was " +
        "attempted, the dispatch execution ID, the failure type, and a learning note.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "Compile a recovery summary from the information below.\n\n" +
          "## Failure context\n\n" +
          "{{extract_failure_context_content}}\n\n" +
          "## Recovery dispatch result\n\n" +
          "{{dispatch_recovery_content}}\n\n" +
          "Output ONLY the JSON object below — no fences, no prose:\n\n" +
          "{\n" +
          '  "recovery_attempted": <boolean — false if give_up, true otherwise>,\n' +
          '  "recovery_dispatch_id": "<executionId from dispatch result, or null>",\n' +
          '  "failure_type": "<from failure context>",\n' +
          '  "recommended_action": "<from failure context>",\n' +
          '  "exclude_template_ids": ["<id>", "..."],\n' +
          '  "learning": "<one-sentence note about what this failure reveals about the template or goal>"\n' +
          "}",
        model: "auto",
        max_tokens: 400,
      },
      outputShapes: ["goalRecoveryAction"],
    },
  ],
};
