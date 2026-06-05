import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * goal-execution-with-retry — orchestrated goal execution with failure-informed retries.
 *
 * Executes a goal against goal-host-vessel with up to N attempts. Each failure informs
 * the next attempt: the evaluate_outcome task extracts a failure_mode verdict and the
 * exclude_template_id to carry forward; dispatch_recovery_if_needed re-dispatches via
 * recover-from-goal-failure when should_retry=true.
 *
 * Key design decisions:
 *
 *   1. autoDraft is NOT triggered. The retry loop exhausts Thompson Sampling picks
 *      first (via exclude list accumulation). If all picks fail, recover-from-goal-failure
 *      may eventually dispatch draft-gap-closing-activity as a create_variant action —
 *      but that is a deferred, measured decision, not an eager fallback.
 *
 *   2. recommend_template uses /v2/activities/recommend with impulse_state_space=[goal]
 *      so Thompson Sampling governs template selection. The exclude_activities_csv
 *      variable accumulates across retries to prevent re-selecting the same failing
 *      template.
 *
 *   3. evaluate_outcome is a lightweight LLM judgement (Haiku-class model, 400 tokens)
 *      that checks shape match without loading full trace content. If the execution
 *      succeeded but produced the wrong shapes, that is still a failure for the purposes
 *      of this orchestrator.
 *
 *   4. dispatch_recovery_if_needed is a conditional dispatch: it only POSTs to
 *      goal-host-vessel when should_retry=true. The LLM task skips the POST and
 *      emits a skipped sentinel when should_retry=false, keeping the task non-fatal
 *      in the success path.
 *
 *   5. compile_result aggregates across all attempts into a single goalExecutionResult
 *      with the winning template, attempt count, and a learning summary for downstream
 *      Thompson feedback.
 *
 * Variables:
 *   - goal: the goal text to execute (required)
 *   - expected_output_shapes: JSON array of required shapes, or '' (optional)
 *   - exclude_activities_csv: comma-separated template IDs to exclude from recommend
 *     (starts empty, accumulates on retries from an outer loop or operator)
 *
 * Composes with:
 *   - goal-shape-pre-check: call before dispatching to verify template shape contract
 *   - recover-from-goal-failure: called internally on should_retry=true
 */
export const GOAL_EXECUTION_WITH_RETRY_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:goal-execution-with-retry",
  name: "goal-execution-with-retry",
  description:
    "Executes a goal against goal-host-vessel with Thompson-Sampling-driven template " +
    "selection and failure-informed retries. Step 1: recommend_template queries " +
    "/v2/activities/recommend with the goal text and exclude list. Step 2: execute_goal " +
    "dispatches to goal-host-vessel with the recommended template. Step 3: " +
    "evaluate_outcome checks shape match and sets should_retry. Step 4: " +
    "dispatch_recovery_if_needed re-dispatches via recover-from-goal-failure if needed. " +
    "Step 5: compile_result produces a final goalExecutionResult with attempt stats and " +
    "learning summary. autoDraft is never triggered — exploration via exclude list " +
    "accumulation exhausts Thompson picks before escalating to variant creation.",
  inputShapes: [],
  outputShapes: ["goalExecutionResult"],
  tags: ["goal-execution", "retry", "recovery", "composable"],
  variables: [
    {
      name: "goal",
      description: "The goal text to execute (e.g. 'fix the failing tests in activity-api')",
    },
    {
      name: "expected_output_shapes",
      description:
        "JSON array of shape names the goal must produce (e.g. '[\"commitSha\",\"fileChange\"]'). " +
        "Pass empty string or '[]' to accept any output.",
    },
    {
      name: "exclude_activities_csv",
      description:
        "Comma-separated list of activity template IDs to exclude from recommendation. " +
        "Starts empty on first attempt; accumulate failed template IDs across retries " +
        "to prevent Thompson Sampling from re-selecting them.",
    },
  ],
  tasks: [
    {
      id: "recommend_template",
      description:
        "Query activity-api's Thompson Sampling recommendation endpoint for the best " +
        "template match for the goal. Excludes any templates in exclude_activities_csv " +
        "so failed variants are not re-selected. Returns up to 3 candidates; the first " +
        "is used for execution.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8080/v2/activities/recommend",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          task_description: "{{goal}}",
          limit: 3,
          exclude_activities: "{{exclude_activities_csv}}",
          impulse_state_space: [{ shape: "goal" }],
        }),
        timeoutMs: 10000,
      },
      outputShapes: ["templateRecommendation"],
    },
    {
      id: "execute_goal",
      description:
        "Dispatch the goal to goal-host-vessel using the top-ranked template from " +
        "recommend_template. The LLM extracts the selectedTemplateId from the " +
        "recommendation JSON and constructs the run-goal request body. Returns the " +
        "execution result including executionId, status, and produced output shapes.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are a goal dispatcher. Extract the top template recommendation and " +
          "POST the goal to goal-host-vessel.\n\n" +
          "## Template recommendation (from activity-api)\n\n" +
          "{{recommend_template_content}}\n\n" +
          "## Goal to execute\n\n" +
          "{{goal}}\n\n" +
          "Extract the first recommended template's id (field may be 'id', 'template_id', " +
          "or 'activity_id' — check all). Then POST to http://127.0.0.1:8210/run-goal " +
          "with body: {\"goal\": \"{{goal}}\", \"targetTemplateId\": \"<extracted template id>\"}\n\n" +
          "If the recommendation is empty or has no templates, POST without targetTemplateId: " +
          "{\"goal\": \"{{goal}}\"}\n\n" +
          "Output ONLY the JSON response from the POST — no fences, no prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 600,
      },
      outputShapes: ["goalExecutionAttempt"],
      // Allow up to 2 retries on execution itself before considering it a task failure.
      retry: {
        max_attempts: 2,
        strategy: "fixed",
      },
    },
    {
      id: "evaluate_outcome",
      description:
        "Evaluate the execution attempt: check whether the execution succeeded and " +
        "whether the produced shapes match the expected_output_shapes. Returns a " +
        "structured evaluation including should_retry flag, failure_mode if present, " +
        "and the template ID to add to the exclude list on the next attempt.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "Evaluate this goal execution attempt.\n\n" +
          "## Execution result\n\n" +
          "{{execute_goal_content}}\n\n" +
          "## Expected output shapes\n\n" +
          "{{expected_output_shapes}}\n\n" +
          "## Evaluation rules\n\n" +
          "1. Check execution status: 'success' or 'completed' = succeeded; anything else = failed.\n" +
          "2. Extract produced_shapes from the result (field may be 'outputShapes', " +
          "   'produced_shapes', or infer from task outputs).\n" +
          "3. If expected_output_shapes is non-empty, check whether produced shapes satisfy " +
          "   the requirement (intersection non-empty). If not satisfied, set shape_match=false.\n" +
          "4. Set should_retry=true when: execution failed OR shape_match=false. " +
          "   Set should_retry=false when: execution succeeded AND (expected empty OR shape_match=true).\n" +
          "5. Extract the template ID that was used (field: 'selectedTemplateId' or " +
          "   'targetTemplateId' in the result). Set exclude_template_id to this value if " +
          "   should_retry=true (so the next attempt excludes it), null if should_retry=false.\n\n" +
          "Output ONLY the JSON object below — no fences, no prose:\n\n" +
          "{\n" +
          '  "succeeded": <boolean>,\n' +
          '  "produced_shapes": ["<shape>", "..."],\n' +
          '  "expected_shapes": ["<shape>", "..."],\n' +
          '  "shape_match": <boolean>,\n' +
          '  "should_retry": <boolean>,\n' +
          '  "failure_mode": "<string describing failure, or null>",\n' +
          '  "execution_id": "<executionId from result, or null>",\n' +
          '  "exclude_template_id": "<template id to exclude, or null>"\n' +
          "}",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 400,
      },
      outputShapes: ["executionEvaluation"],
    },
    {
      id: "dispatch_recovery_if_needed",
      description:
        "Conditionally dispatch recover-from-goal-failure when should_retry=true from " +
        "evaluate_outcome. Extracts the execution_id and passes it along with the original " +
        "goal to recover-from-goal-failure. When should_retry=false, emits a skipped " +
        "sentinel so this task completes cleanly without a network call.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "Check whether recovery should be dispatched based on the evaluation below.\n\n" +
          "## Execution evaluation\n\n" +
          "{{evaluate_outcome_content}}\n\n" +
          "## Original goal\n\n" +
          "{{goal}}\n\n" +
          "If should_retry = false: output ONLY this JSON:\n" +
          "{\"skipped\": true, \"reason\": \"execution succeeded or no retry needed\"}\n\n" +
          "If should_retry = true: POST to http://127.0.0.1:8210/run-goal with body:\n" +
          "{\n" +
          "  \"goal\": \"{{goal}}\",\n" +
          "  \"targetTemplateId\": \"development-vessel:recover-from-goal-failure\",\n" +
          "  \"variables\": {\n" +
          "    \"failed_execution_id\": \"<execution_id from evaluation>\",\n" +
          "    \"original_goal\": \"{{goal}}\",\n" +
          "    \"expected_output_shapes\": \"{{expected_output_shapes}}\"\n" +
          "  }\n" +
          "}\n\n" +
          "Output ONLY the JSON response from the POST (or the skipped sentinel) — no fences, " +
          "no prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 600,
      },
      outputShapes: ["recoveryAttempt"],
    },
    {
      id: "compile_result",
      description:
        "Compile the final execution result across all attempted steps into a " +
        "goalExecutionResult summary. Records whether the goal ultimately succeeded, " +
        "the winning template, attempt statistics, and a learning summary for downstream " +
        "Thompson feedback and human observability.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "Compile the final goal execution result from the steps below.\n\n" +
          "## Goal\n\n" +
          "{{goal}}\n\n" +
          "## Template recommendation\n\n" +
          "{{recommend_template_content}}\n\n" +
          "## Execution evaluation\n\n" +
          "{{evaluate_outcome_content}}\n\n" +
          "## Recovery attempt\n\n" +
          "{{dispatch_recovery_if_needed_content}}\n\n" +
          "Output ONLY the JSON object below — no fences, no prose:\n\n" +
          "{\n" +
          '  "goal": "{{goal}}",\n' +
          '  "succeeded": <boolean — true if execution succeeded and shape_match>,\n' +
          '  "attempts": <integer — 1 if no retry, 2 if recovery was dispatched>,\n' +
          '  "winning_template": "<templateId used in the successful attempt, or null>",\n' +
          '  "recovery_dispatched": <boolean>,\n' +
          '  "recovery_execution_id": "<executionId from recovery dispatch, or null>",\n' +
          '  "total_cost_usd": <number — sum of known costs, or 0 if unknown>,\n' +
          '  "learning_summary": "<one sentence: what this execution reveals about template quality or goal specificity>"\n' +
          "}",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 500,
      },
      outputShapes: ["goalExecutionResult"],
    },
  ],
};
