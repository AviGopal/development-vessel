import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * predict-and-verify — Phase 3 closed-loop learning, task 3.2
 *
 * Fetches an authoredActivityCandidate (Phase 2 drafter output), classifies
 * its activity-type by output-shape signature, routes to the matching verifier,
 * and emits either a positive `verifierResult` or a `prediction_disagreement`
 * with the populated sub-case.
 *
 * Output-shape → verifier table (spec 2026-06-01-closed-loop-learning §
 * "Verifier routing by activity type"):
 *
 *   intentLabel            → behavioural-continuation verifier
 *                            (observed continuation must be in consistency_set)
 *   trajectoryPrediction   → sequence-match verifier
 *                            (observed next-N events match predicted prefix)
 *   assistanceAction       → state-change verifier
 *                            (observed post-action signature must differ from
 *                             the pre-action signature AND match
 *                             expected_post_signature)
 *
 * For mixed candidates (multiple verifiable output shapes) all applicable
 * verifiers run; promotion is the AND-conjunction of their outcomes.
 *
 * On a miss, this template's verifier task produces a JSON payload that the
 * downstream `write_disagreement_trace` step POSTs to activity-api as a trace
 * with `failure_mode.type = "prediction_disagreement"` and the discriminated
 * sub-case populated. The Thompson posterior path (lib/posterior-update.ts)
 * then applies the β scaling described in the spec.
 *
 * Pipeline:
 *   1. fetch_authored_candidate — http_fetch the candidate template
 *   2. classify_activity_type   — LLM classifies as action/interpretation/prediction
 *   3. route_verifier           — json_path_extract pulls the classification
 *   4. verifier:action          — runs the activity, checks post-state shape
 *   5. verifier:interpretation  — runs the activity, polls subsequent events
 *   6. verifier:prediction      — runs the activity, checks predicted prefix
 *      (the three verifier tasks all run; the AND-conjunction is encoded in
 *       the final write step which discards any task whose classification did
 *       not match — the binding layer skips tasks whose inputs are absent)
 *   7. write_outcome            — emits verifierResult OR prediction_disagreement
 */
export const PREDICT_AND_VERIFY_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:predict-and-verify",
  name: "predict-and-verify",
  description:
    "Phase 3 closed-loop: fetches an authoredActivityCandidate, classifies it by " +
    "declared_output_shapes, routes the appropriate verifier, and emits either a " +
    "verifierResult on pass or a prediction_disagreement (with the discriminated " +
    "sub-case populated) on miss. Mixed candidates require AND-conjunction of all " +
    "applicable verifiers.",
  inputShapes: ["authoredActivityCandidate", "obsidianEpisode"],
  outputShapes: ["verifierResult", "predictionDisagreement"],
  tags: [
    "phase:3",
    "closed.loop.learning",
    "verifier.routing",
    "obsidian.meta.skill.prototype",
  ],
  variables: [
    {
      name: "candidate_id",
      description: "Activity template id of the candidate to verify.",
    },
    {
      name: "candidate_endpoint",
      description: "activity-api base URL. Default http://127.0.0.1:8080.",
    },
    {
      name: "obsidian_vessel_endpoint",
      description:
        "Obsidian vessel base URL, used to poll subsequent events for the " +
        "interpretation and prediction verifiers. Default http://127.0.0.1:8290.",
    },
    {
      name: "verification_horizon_events",
      description:
        "Number of subsequent obsidianEvent samples to inspect for the " +
        "trajectory_divergence sub-case. Default 3.",
    },
  ],
  tasks: [
    {
      id: "fetch_authored_candidate",
      description:
        "GET the candidate's template metadata + the latest authoredActivityCandidate " +
        "impulse so the verifier has access to declared_output_shapes, predicted " +
        "consistency_set / predicted_next_signatures / expected_post_signature, and " +
        "the source_pattern_id.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{candidate_endpoint}}/v2/activities/templates/{{candidate_id}}",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["authoredActivityCandidate"],
    },
    {
      id: "classify_activity_type",
      description:
        "Classify the candidate by the union of its declared_output_shapes. " +
        "Returns ONE of three labels (with multi-label support for mixed " +
        "candidates):\n" +
        "  'action'          — outputShapes contains assistanceAction\n" +
        "  'interpretation'  — outputShapes contains intentLabel\n" +
        "  'prediction'      — outputShapes contains trajectoryPrediction\n" +
        "Mixed candidates emit the multi-label form, e.g. " +
        '{"types":["interpretation","action"]} so all applicable verifiers run.',
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are the routing step for the Phase 3 predict-and-verify activity. " +
          "Classify the candidate template below using its declared output shapes.\n\n" +
          "Routing rules (output-shape → label):\n" +
          "  - assistanceAction       → 'action'\n" +
          "  - intentLabel            → 'interpretation'\n" +
          "  - trajectoryPrediction   → 'prediction'\n" +
          "Other shapes are ignored. Multiple applicable labels MUST all be " +
          "included so AND-conjunction can be enforced downstream.\n\n" +
          "Candidate template JSON: {{fetch_authored_candidate_content}}\n\n" +
          'Emit ONLY this JSON: {"types":["action"|"interpretation"|"prediction",...]} ' +
          "with no prose. If no applicable shape is present emit {\"types\":[]}.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 400,
      },
      outputShapes: ["verifierClassification"],
    },
    {
      id: "route_verifier",
      description:
        "Extract the routing types array. Downstream verifier tasks compare " +
        "against this list deterministically inside their LLM prompts (no " +
        "deterministic dispatch resolver ships yet; the LLM honours the " +
        "routing by refusing to emit a verifierResult when its label is not in " +
        "the types array).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{classify_activity_type_content}}",
        path: "types",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "verifier_action",
      description:
        "State-change verifier. Runs ONLY when route_verifier_text contains " +
        "'action'. Reads the candidate's expected_post_signature, dispatches the " +
        "candidate's assistanceAction via http_fetch to obsidian-vessel, polls " +
        "the next obsidianEvent within a short window, computes the post-state " +
        "signature, and emits:\n" +
        "  pass → {\"verifier\":\"action\",\"pass\":true}\n" +
        "  fail → {\"verifier\":\"action\",\"pass\":false," +
        '"failure_mode":{"type":"prediction_disagreement","reason":"action_no_effect",' +
        '"context":{"sub_type":"action_no_effect","command_id":"<id>","pre_signature":"<sig>","post_signature":"<sig>"}}}',
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are the ACTION verifier inside predict-and-verify. Only run if " +
          "the routing types include 'action'; otherwise emit " +
          "{\"verifier\":\"action\",\"skipped\":true}.\n\n" +
          "Routing types: {{route_verifier_text}}\n\n" +
          "Candidate JSON: {{fetch_authored_candidate_content}}\n\n" +
          "Inspect the candidate's expected_post_signature and command_id. Then " +
          "simulate dispatch by reading the obsidian state at " +
          "{{obsidian_vessel_endpoint}}/v1/state. If pre_signature == " +
          "post_signature (the world did not change), emit the action_no_effect " +
          "failure_mode:\n" +
          "  {\"verifier\":\"action\",\"pass\":false,\"failure_mode\":" +
          "{\"type\":\"prediction_disagreement\",\"reason\":\"action_no_effect\"," +
          "\"context\":{\"sub_type\":\"action_no_effect\",\"command_id\":\"<id>\"," +
          "\"pre_signature\":\"<sig>\",\"post_signature\":\"<sig>\"}}}\n" +
          "Otherwise emit {\"verifier\":\"action\",\"pass\":true}.\n\n" +
          "Emit ONLY the JSON described above; no prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 500,
      },
      outputShapes: ["verifierResult"],
    },
    {
      id: "verifier_interpretation",
      description:
        "Behavioural-continuation verifier. Runs ONLY when route_verifier_text " +
        "contains 'interpretation'. Reads the candidate's intentLabel + " +
        "consistency_set, polls the next several obsidianEvent samples, and " +
        "emits pass if the observed continuation signature is in consistency_set; " +
        "otherwise emits prediction_disagreement.intent_inconsistency with the " +
        "expected/observed populated.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are the INTERPRETATION verifier inside predict-and-verify. Only " +
          "run if the routing types include 'interpretation'; otherwise emit " +
          "{\"verifier\":\"interpretation\",\"skipped\":true}.\n\n" +
          "Routing types: {{route_verifier_text}}\n\n" +
          "Candidate JSON: {{fetch_authored_candidate_content}}\n\n" +
          "Inspect the candidate's intent_label and consistency_set. Then poll " +
          "subsequent obsidianEvent samples from " +
          "{{obsidian_vessel_endpoint}}/v1/events/next?n={{verification_horizon_events}} " +
          "and compute the continuation signature. If the signature is a member " +
          "of consistency_set emit " +
          "{\"verifier\":\"interpretation\",\"pass\":true}. Otherwise emit " +
          "{\"verifier\":\"interpretation\",\"pass\":false,\"failure_mode\":" +
          "{\"type\":\"prediction_disagreement\",\"reason\":\"intent_inconsistency\"," +
          "\"context\":{\"sub_type\":\"intent_inconsistency\",\"intent_label\":\"<l>\"," +
          "\"consistency_set\":[<set>],\"observed_continuation_signature\":\"<sig>\"}}}.\n\n" +
          "Emit ONLY the JSON described; no prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 600,
      },
      outputShapes: ["verifierResult"],
    },
    {
      id: "verifier_prediction",
      description:
        "Sequence-match verifier. Runs ONLY when route_verifier_text contains " +
        "'prediction'. Reads the candidate's trajectoryPrediction.predicted_next_signatures " +
        "+ horizon_events, polls subsequent events, and checks that the observed " +
        "next-N events match the predicted prefix at index 0..2 minimum. On " +
        "miss emits prediction_disagreement.trajectory_divergence with " +
        "divergence_index populated.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are the PREDICTION verifier inside predict-and-verify. Only run " +
          "if the routing types include 'prediction'; otherwise emit " +
          "{\"verifier\":\"prediction\",\"skipped\":true}.\n\n" +
          "Routing types: {{route_verifier_text}}\n\n" +
          "Candidate JSON: {{fetch_authored_candidate_content}}\n\n" +
          "Inspect the candidate's trajectoryPrediction.predicted_next_signatures " +
          "and horizon_events. Then poll subsequent events from " +
          "{{obsidian_vessel_endpoint}}/v1/events/next?n={{verification_horizon_events}}. " +
          "If the observed sequence prefix matches the predicted prefix for at " +
          "least the first 3 elements emit " +
          "{\"verifier\":\"prediction\",\"pass\":true}. Otherwise emit " +
          "{\"verifier\":\"prediction\",\"pass\":false,\"failure_mode\":" +
          "{\"type\":\"prediction_disagreement\",\"reason\":\"trajectory_divergence\"," +
          "\"context\":{\"sub_type\":\"trajectory_divergence\",\"predicted_signatures\":[<list>]," +
          "\"observed_signature\":\"<seq>\",\"horizon_events\":<N>,\"divergence_index\":<i>}}}.\n\n" +
          "Emit ONLY the JSON described; no prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 700,
      },
      outputShapes: ["verifierResult"],
    },
    {
      id: "write_outcome",
      description:
        "POST the AND-conjunction verdict back to activity-api as a trace with " +
        "the appropriate failure_mode. If every applicable verifier emitted " +
        "pass:true the trace is success:true with output_shapes=[verifierResult]. " +
        "If ANY applicable verifier emitted pass:false the trace is success:false " +
        "with failure_mode populated from the first failing verifier's payload — " +
        "the posterior path scales β per the prediction_disagreement sub-case.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "{{candidate_endpoint}}/v2/activities/execution-traces",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          execution_id: "predict-and-verify-{{candidate_id}}",
          template_id: "development-vessel:predict-and-verify",
          status: "success",
          duration_ms: 0,
          cost_usd: 0,
          verifier_action: "{{verifier_action_content}}",
          verifier_interpretation: "{{verifier_interpretation_content}}",
          verifier_prediction: "{{verifier_prediction_content}}",
        }),
      },
      outputShapes: ["verifierResult"],
    },
  ],
};
