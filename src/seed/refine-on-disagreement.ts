import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * refine-on-disagreement — Phase 3 closed-loop learning, task 3.3
 *
 * Lifecycle-driven refiner. Fires when a `prediction_disagreement` trace is
 * observed. Reads the disagreement sub-case + the originally-failed
 * candidate's `authored_from_pattern` metadata, builds a contrast pair
 * (passing traces + the failing trace), and dispatches the Phase 2 drafter
 * (`draft-activity-from-pattern`) requesting a refined variant addressing the
 * specific disagreement. The refined variant becomes a child template whose
 * parent posterior receives credit via `propagateCreditAlongChain`.
 *
 * Backoff: at most 3 refinements per (pattern_id, sub_type) in a rolling 24h
 * window. The dispatch map at /workspace/refinement/_dispatched.json keeps
 * a `{pattern_id::sub_type: [ISO ts, ISO ts, ...]}` counter. The drafter call
 * inspects this and no-ops when the cap is hit.
 *
 * Although the task description in 2026-06-01-closed-loop spec §3.3 calls this
 * a "lifecycle subscriber", the seeded-template form is preferred because it
 * ships as a registry artifact (same as detect-recurring-pattern and
 * predict-and-verify) and is invoked by the existing registry-change-observer
 * on prediction_disagreement traces. The lifecycle wiring lives in the
 * observer (registry-change-observer.ts in this vessel); this template is the
 * impulse-orchestration the observer dispatches against.
 *
 * Pipeline:
 *   1. fetch_disagreement_trace — http_fetch to activity-api to get the failed trace
 *   2. fetch_authored_metadata  — http_fetch the original candidate's authored_from_pattern
 *   3. fetch_passing_traces     — http_fetch to gather prior successful instances
 *      of the same template (for the contrast pair)
 *   4. read_dispatched_map      — fs_read the backoff map (best-effort; missing → empty)
 *   5. build_contrast_pair      — LLM merges the disagreement context + passing/failing
 *      traces into the contrast-pair JSON the Phase 2 drafter expects, AND enforces
 *      the 3-per-24h backoff by returning {"skipped": true} when the cap is hit
 *   6. write_dispatched_record  — fs_write appends the new dispatch into the map
 *   7. dispatch_drafter         — http_fetch POSTs to goal-host-vessel /run-goal
 *      with the contrast pair as scenario variables
 */
export const REFINE_ON_DISAGREEMENT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:refine-on-disagreement",
  name: "refine-on-disagreement",
  description:
    "Phase 3 closed-loop refiner: consumes a prediction_disagreement trace, " +
    "builds a contrast pair from prior passing traces of the same template, " +
    "and dispatches the Phase 2 drafter for a refined variant addressing the " +
    "specific sub_case. Refinement is capped at 3 per (pattern_id, sub_type) " +
    "in a 24h window via /workspace/refinement/_dispatched.json. The refined " +
    "candidate's parent receives chain credit through propagateCreditAlongChain.",
  inputShapes: ["predictionDisagreement", "recurringPatternCluster"],
  outputShapes: ["authoredActivityCandidate"],
  tags: [
    "phase:3",
    "closed.loop.learning",
    "refinement",
    "obsidian.meta.skill.prototype",
  ],
  variables: [
    {
      name: "disagreement_execution_id",
      description: "The execution_id of the trace carrying the prediction_disagreement.",
    },
    {
      name: "failed_activity_id",
      description: "Template id of the activity that produced the disagreement.",
    },
    {
      name: "candidate_endpoint",
      description: "activity-api base URL. Default http://127.0.0.1:8080.",
    },
    {
      name: "refinement_dir",
      description: "Directory holding the backoff dispatch map. Default /workspace/refinement.",
    },
    {
      name: "drafter_template_id",
      description:
        "Target template id dispatched on successful refinement. Default " +
        "'development-vessel:draft-activity-from-pattern' (Phase 2).",
    },
  ],
  tasks: [
    {
      id: "fetch_disagreement_trace",
      description:
        "Pull the trace carrying the prediction_disagreement so the refiner can " +
        "extract failure_mode.context.sub_type and the discriminated payload.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{candidate_endpoint}}/v2/activities/execution-traces/{{disagreement_execution_id}}",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["activityExecutionTrace"],
    },
    {
      id: "fetch_authored_metadata",
      description:
        "Read the failed activity template, in particular its authored_from_pattern " +
        "metadata. The metadata identifies which recurringPatternCluster produced " +
        "the original candidate — the refiner targets the same pattern for the " +
        "refined variant so chain credit flows up the parent activity.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{candidate_endpoint}}/v2/activities/templates/{{failed_activity_id}}",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["activityTemplate"],
    },
    {
      id: "fetch_passing_traces",
      description:
        "Pull recent SUCCESS traces of the failed activity so the contrast pair " +
        "has at least one positive example next to the failing trace.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{candidate_endpoint}}/v2/activities/execution-traces?activity_template_id={{failed_activity_id}}&success_only=true&limit=10",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["executionTraceList"],
    },
    {
      id: "read_dispatched_map",
      description:
        "Best-effort read of /workspace/refinement/_dispatched.json — the rolling " +
        "24h dispatch counter. When the file is missing fs_read fails fast; the " +
        "downstream contrast-building step treats that as an empty map.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{refinement_dir}}/_dispatched.json",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "build_contrast_pair",
      description:
        "Compose the contrast pair JSON the Phase 2 drafter expects. Enforces " +
        "the 3-per-(pattern_id,sub_type)-per-24h backoff: when the dispatch map " +
        "already records 3 or more dispatches for this (pattern_id, sub_type) " +
        "pair within the last 24h, emits {\"skipped\":true,\"reason\":\"backoff\"} " +
        "so dispatch_drafter no-ops. Otherwise emits " +
        "{\"contrast_pair\":{\"passing_traces\":[...],\"failing_trace\":{...}}," +
        "\"sub_type\":\"<sub>\",\"pattern_id\":\"<id>\"}.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You build the contrast-pair payload for the Phase 3 " +
          "refine-on-disagreement loop. Inputs:\n\n" +
          "FAILED TRACE: {{fetch_disagreement_trace_content}}\n\n" +
          "FAILED ACTIVITY METADATA: {{fetch_authored_metadata_content}}\n\n" +
          "RECENT PASSING TRACES (same template): {{fetch_passing_traces_content}}\n\n" +
          "DISPATCH MAP (may be missing or empty): {{read_dispatched_map_content}}\n\n" +
          "Step 1: Extract failure_mode.context.sub_type and " +
          "metadata.authored_from_pattern.pattern_id from the failed trace and " +
          "activity metadata.\n" +
          "Step 2: Inspect the dispatch map for key '<pattern_id>::<sub_type>'. " +
          "Count the timestamps newer than 24h ago. If count >= 3, emit:\n" +
          "  {\"skipped\":true,\"reason\":\"backoff\",\"pattern_id\":\"<id>\"," +
          "\"sub_type\":\"<sub>\"}\n" +
          "Step 3: Otherwise emit the contrast-pair JSON:\n" +
          "  {\"skipped\":false,\"pattern_id\":\"<id>\",\"sub_type\":\"<sub>\"," +
          "\"contrast_pair\":{\"passing_traces\":[<up to 3 most-recent success traces>]," +
          "\"failing_trace\":<failed trace summary>}}\n\n" +
          "Emit ONLY the JSON; no prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 2000,
      },
      outputShapes: ["refinementContrastPair"],
    },
    {
      id: "write_dispatched_record",
      description:
        "Append the new dispatch timestamp to /workspace/refinement/_dispatched.json. " +
        "Writes the merged map back atomically. When build_contrast_pair returned " +
        "skipped:true this write is harmless — it merely re-persists the same map.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{refinement_dir}}/_dispatched.json",
        content: "{{build_contrast_pair_content}}",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "dispatch_drafter",
      description:
        "POST to goal-host-vessel /run-goal targeting the Phase 2 drafter with " +
        "the contrast pair as scenario variables. The drafter inspects skipped:true " +
        "and no-ops without minting a candidate; otherwise it produces a refined " +
        "authoredActivityCandidate. The dispatched goal carries parent_execution_id = " +
        "disagreement_execution_id so the refined candidate's posterior credit " +
        "propagates back to the parent via propagateCreditAlongChain.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "refine activity {{failed_activity_id}} after prediction_disagreement",
          targetTemplateId: "{{drafter_template_id}}",
          parent_execution_id: "{{disagreement_execution_id}}",
          variables: {
            contrast_pair: "{{build_contrast_pair_content}}",
            failed_activity_id: "{{failed_activity_id}}",
            source: "refine-on-disagreement",
          },
        }),
      },
      outputShapes: ["authoredActivityCandidate"],
    },
  ],
};
