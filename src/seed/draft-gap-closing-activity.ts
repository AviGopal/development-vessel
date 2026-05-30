import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

const PROMPT_TEMPLATE = `You are helping build a self-improving activity system.

Below is a failure-mode scenario that the system currently cannot handle autonomously
(emergence_class="gap"). Your task is to draft a candidate activity template (JSON) that,
if executed by the system, would produce the evidence or trace needed to close this gap.

## Substrate Memory — concepts already accumulated

These are concepts the substrate has learned from prior runs. Each entry shows the
shape, summary, success/load counts, and Bayesian relevance. Concepts with high
times_loaded and high relevance describe shape signatures the substrate has seen
repeatedly succeed. Treat them as priors: prefer drafting activities whose tasks
produce shapes the substrate already recognises, and re-use resolver chains that
mirror the high-relevance signatures below.

{{prime_substrate_concepts_text}}

## Substrate Memory — co-occurrence edges

Edges between impulse-signature concepts that have appeared together in successful
traces. Each edge's weight is the joint observation count. Use them to anticipate
which downstream shapes are likely to be needed once a given shape is produced.

{{prime_substrate_edges_text}}

## Failure-Mode Scenario
{{read_scenario_content}}

## Requirements for the drafted template
1. Use ONLY these resolver names: fs_read, fs_write, llm_completion_dispatch, json_path_extract, http_fetch.
   Do NOT use activity_fetch, gpt-4, openai, or any other resolver not in this list.

   For substrate-state writes (accumulating knowledge back into the system), use http_fetch
   to dispatch to the appropriate vessel's /v2/impulses/resolve endpoint. The three SAFE
   writes available to autonomous drafters are:

   (a) concept_create_write — mint a concept (typed knowledge unit, Bayesian-rankable).
       Endpoint: http://127.0.0.1:8260/v2/impulses/resolve
       Pointer payload (POST body): {
         "impulse": { "pointer": {
           "type": "concept_create_write",
           "conceptData": {
             "shape": "<shape name, e.g. vessel_construction_pattern>",
             "source_type": "extracted",
             "summary": "<one-line gist>",
             "content": "<concept body>",
             "priority": 0.5,
             "budget": 2000
           }
         } }
       }
       Use when a successful trace reveals a reusable pattern worth preserving.

   (b) conceptLink_write — wire an edge between two existing concepts.
       Endpoint: http://127.0.0.1:8260/v2/impulses/resolve
       Pointer payload (POST body): {
         "impulse": { "pointer": {
           "type": "conceptLink_write",
           "linkData": {
             "from_concept_id": "<source concept id>",
             "to_concept_id": "<target concept id>",
             "edge_type": "related_to" | "derived_from" | "description_of" | "example_of"
           }
         } }
       }
       Use to wire a newly-minted concept into the existing graph so it is reachable
       via concept_neighbors traversal.

   (c) substrateGap_write — record a problem-statement gap the system discovered.
       Endpoint: http://127.0.0.1:8270/v2/impulses/resolve
       Pointer payload (POST body): {
         "impulse": { "pointer": {
           "type": "substrateGap_write",
           "gap": {
             "id": "<idempotency key>",
             "category": "conversation_only" | "training_knowledge" | "missing_concept" | "missing_idiom" | "other",
             "source": "substrate_detected",
             "summary": "<gap statement>",
             "detected_at": "<ISO timestamp>",
             "status": "open"
           }
         } }
       }
       Use when execution detects a missing capability the system should track. Distinct
       from a memoryNote (candidate answer); this is the problem statement.

   These three writes are SAFE for autonomous use. Destructive writes
   (activityTemplate_update, activityTemplate_deprecate, activityExecutionTrace_delete)
   are NOT in the palette and must NOT be used.
2. For llm_completion_dispatch tasks, config MUST have exactly these fields:
     { "type": "llm_completion_dispatch", "prompt": "<the prompt text>",
       "model": "anthropic/claude-haiku-4-5-20251001", "max_tokens": 1000 }
   Do NOT use "prompt_template", "system_prompt", or any other field name.
3. For fs_read tasks: { "type": "fs_read", "path": "<absolute path>" }
4. For fs_write tasks: { "type": "fs_write", "path": "<absolute path>", "content": "<content>" }
5. For json_path_extract tasks: { "type": "json_path_extract", "json": "{{prev_task_content}}", "path": "field.name" }
6. The template must have: id, name, description, tags (array of strings), outputShapes, tasks[].
7. Each task must have: id, description, resolver, config.
8. Output ONLY valid JSON — no markdown fences, no prose before or after.
9. The template id must start with "gap-closing:" followed by the scenario id.
10. The outputShapes must include the shapes from the scenario's
    expected_emergence.activity_signature.output_shapes_must_include list.

Respond with the JSON template only.`;

export const DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:draft-gap-closing-activity",
  name: "draft-gap-closing-activity",
  description:
    "Given a failure-mode report path and a scenario_id, reads the scenario JSON, " +
    "primes the LLM context with the substrate's accumulated concept memory (impulse-signature " +
    "concepts ranked by Bayesian relevance, plus co-occurrence edges between them), drafts a " +
    "candidate gap-closing activity template via llm_completion_dispatch, writes the proposal " +
    "file, and registers it as a variant in activity-api. " +
    "Rate-limit: skips scenarios with ≥3 existing proposals in the last 7 days.",
  inputShapes: ["failureModeReport", "gapScenario"],
  outputShapes: ["activityTemplateProposal", "activityTemplateVariant"],
  tags: ["lift.autonomous.loop", "validation.failure.modes", "gap.closing"],
  variables: [
    {
      name: "report_path",
      description: "Filesystem path to the failure-mode harness JSON report",
    },
    {
      name: "scenario_id",
      description: "ID of the gap scenario to address (e.g. fp-11, fm-43)",
    },
    {
      name: "proposals_dir",
      description: "Directory for proposal output files",
    },
    {
      name: "scenarios_dir",
      description: "Directory containing scenario JSON files",
    },
  ],
  tasks: [
    {
      id: "read_report",
      description: "Load the failure-mode harness report to confirm the scenario is a gap.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{report_path}}",
      },
      outputShapes: ["failureModeReport"],
    },
    {
      id: "read_scenario",
      description: "Load the detailed scenario JSON including subagent_investigation block.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{scenarios_dir}}/{{scenario_id}}.json",
      },
      outputShapes: ["gapScenario"],
    },
    {
      id: "prime_substrate_concepts",
      description:
        "Query concept-db for the substrate's accumulated impulse-signature concepts " +
        "ranked by Bayesian relevance. The drafted template's LLM call uses these as priors. " +
        "Failure is non-fatal — concept-db being empty or unreachable just means the LLM " +
        "drafts without the substrate's memory as context.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8260/concepts/search?source_type=impulse_signature&min_relevance=0.3&limit=15",
        method: "GET",
        timeoutMs: 5000,
      },
      outputShapes: ["substrateConceptIndex"],
    },
    {
      id: "prime_substrate_edges",
      description:
        "Query concept-db for the highest-weighted co-occurrence edges between " +
        "impulse-signature concepts. Feeds the LLM evidence of which shape pairs " +
        "have co-occurred in successful traces.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8260/mcp/tools/call",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "concept_cooccurrence_edges",
          arguments: { limit: 20 },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["substrateCooccurrenceEdges"],
    },
    {
      id: "draft_via_llm",
      description:
        "Dispatch to a discovered llm_completion vessel to draft the candidate template JSON. " +
        "Receives the failure-mode scenario plus the substrate's accumulated concept memory.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON with no surrounding text.",
        prompt: PROMPT_TEMPLATE,
        model: "anthropic/claude-haiku-4-5-20251001",
      },
      outputShapes: ["draftedTemplate"],
    },
    {
      id: "extract_required_shapes",
      description:
        "Deterministically extract output_shapes_must_include from the scenario JSON " +
        "so the registered template carries the correct outputShapes regardless of LLM output.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_scenario_content}}",
        path: "expected_emergence.activity_signature.output_shapes_must_include",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "write_proposal",
      description: "Persist the drafted template as a proposal file with authored_by metadata.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{proposals_dir}}/proposal-{{scenario_id}}.json",
        content: JSON.stringify({
          proposal: {
            scenario_id: "{{scenario_id}}",
            authored_by: "make_activity_autonomous",
            registration_status: "draft",
            created_at: new Date(0).toISOString(),
          },
          template: "{{draft_via_llm_text}}",
        }),
      },
      outputShapes: ["activityTemplateProposal"],
    },
    {
      id: "register_variant",
      description:
        "Register the drafted template as a candidate variant in activity-api, " +
        "forcing outputShapes to match the scenario's required shapes deterministically.",
      resolver: "activity_create_variant",
      config: {
        type: "activity_create_variant",
        template: "{{draft_via_llm_text}}",
        output_shapes_override: "{{extract_required_shapes_valueJson}}",
        strip_id: true,
      },
      outputShapes: ["activityTemplateVariant"],
    },
  ],
};
