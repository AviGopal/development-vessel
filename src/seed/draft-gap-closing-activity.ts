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

### RESOLVER RULES (violations cause runtime failures — follow exactly)

1. Use ONLY these resolver names: fs_read, fs_write, llm_completion_dispatch, json_path_extract, http_fetch.

2. fs_read config: { "type": "fs_read", "path": "<ABSOLUTE path to a file that EXISTS>" }
   ONLY read these paths — they are guaranteed to exist:
   - /workspace/validation/failure-modes/scenarios/<scenario_id>.json  (the scenario file)
   - /workspace/validation/results/latest-failure-mode-report.json     (harness results)
   - /workspace/proposals/<any-file>.json                               (output dir)
   DO NOT invent paths like /var/traces/ or /analytics/ — they do not exist.
   DO NOT use fs_read to read directories — only read files with known full paths.

3. fs_write config: { "type": "fs_write", "path": "/workspace/proposals/<filename>.json", "content": "<content>" }
   Only write to /workspace/proposals/ or /workspace/gaps/.

4. llm_completion_dispatch config MUST use EXACTLY these fields:
   { "type": "llm_completion_dispatch", "prompt": "<prompt text>",
     "model": "anthropic/claude-haiku-4-5-20251001", "max_tokens": 1000 }
   NO other fields. "prompt_template", "system_prompt", "system" are NOT valid.

5. json_path_extract: DO NOT USE in your template. It is too fragile. Use llm_completion_dispatch to process any JSON data instead.

6. http_fetch config: { "type": "http_fetch", "url": "http://127.0.0.1:8080/...", "method": "GET" }
   Use to query activity-api for execution trace data (DO NOT read traces from files):
   - GET http://127.0.0.1:8080/v2/activities/execution-traces?limit=20
   - POST http://127.0.0.1:8080/v2/activities/discover-by-shapes with body

   For substrate writes, use http_fetch to POST to:
   - concept_create_write: POST http://127.0.0.1:8260/v2/impulses/resolve
     body: {"impulse":{"pointer":{"type":"concept_create_write","conceptData":{"shape":"<name>","source_type":"extracted","summary":"<text>","content":"<text>","priority":0.5,"budget":2000}}}}
   - substrateGap_write: POST http://127.0.0.1:8270/v2/impulses/resolve
     body: {"impulse":{"pointer":{"type":"substrateGap_write","gap":{"id":"<key>","category":"missing_concept","source":"substrate_detected","summary":"<text>","detected_at":"<ISO>","status":"open"}}}}

### TEMPLATE STRUCTURE RULES

7. The template must have: id, name, description, tags (array of strings), outputShapes, tasks[].
8. Each task must have: id, description, resolver, config.
9. Output ONLY valid JSON — no markdown fences, no prose before or after.
10. Template id must start with "gap-closing:" followed by the scenario id.
11. outputShapes must include the shapes from expected_emergence.activity_signature.output_shapes_must_include.

### MANDATORY TEMPLATE STRUCTURE — use EXACTLY 4 tasks in this order

Your template MUST have exactly these 4 tasks and no others:

TASK 1 - read_scenario (fs_read):
  config: { "type": "fs_read", "path": "/workspace/validation/failure-modes/scenarios/<scenario_id>.json" }
  Replace <scenario_id> with the actual scenario_id from the failure-mode scenario above.

TASK 2 - fetch_traces (http_fetch):
  config: { "type": "http_fetch", "url": "http://127.0.0.1:8080/v2/activities/execution-traces?limit=20", "method": "GET" }
  This is the ONLY valid URL for execution traces. Do NOT invent other URLs.

TASK 3 - analyze (llm_completion_dispatch):
  config: {
    "type": "llm_completion_dispatch",
    "prompt": "Scenario: {{read_scenario_content}}\n\nRecent traces: {{fetch_traces_content}}\n\nAnalyze the failure mode described in the scenario against the recent traces. Produce a JSON report addressing the gap: {\"<output_shape_name>\": \"<your analysis>\"}",
    "model": "anthropic/claude-haiku-4-5-20251001",
    "max_tokens": 1000
  }
  Replace <output_shape_name> with the first shape from expected_emergence.activity_signature.output_shapes_must_include.

TASK 4 - write_report (fs_write):
  config: { "type": "fs_write", "path": "/workspace/proposals/<scenario_id>-report.json", "content": "{{analyze_text}}" }
  Replace <scenario_id> with the actual scenario id.

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
        "Query concept-db for the substrate's accumulated concepts ranked by Bayesian " +
        "relevance — both bridge-auto-minted impulse_signature concepts AND " +
        "hand-minted operator/audit/skill concepts (memo for findings + " +
        "vessel_construction_pattern + impulse_activity_pattern for constitutional knowledge). " +
        "The drafted template's LLM call uses these as priors. " +
        "Failure is non-fatal — concept-db being empty or unreachable just means the LLM " +
        "drafts without the substrate's memory as context. " +
        "F26 (2026-05-30): source_type filter expanded from impulse_signature-only to " +
        "comma-separated multi-source-type, closing the gap where operator-minted concepts " +
        "(source_type=memo) were structurally invisible to the substrate's autonomous loop.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url:
          "http://127.0.0.1:8260/concepts/search" +
          "?source_type=impulse_signature,memo,vessel_construction_pattern,impulse_activity_pattern" +
          "&min_relevance=0.3&limit=15",
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
    {
      id: "verify_outputs",
      description:
        "Convergent validity check: cross-reference the produced shapes " +
        "(activityTemplateProposal + activityTemplateVariant) against concept-db's " +
        "learned co-occurrence priors. If concept-db expects shapes that are absent, " +
        "records a divergence verdict in convergentValidityResult. Non-fatal " +
        "(strict=false) while concept-db edges are still accumulating — the verdict " +
        "is recorded for observability and Thompson learning without blocking registration.",
      resolver: "convergent_validity_check",
      config: {
        type: "convergent_validity_check",
        produced_shapes: ["activityTemplateProposal", "activityTemplateVariant"],
        task_id: "register_variant",
        strict: false,
      },
      outputShapes: ["convergentValidityResult"],
    },
  ],
};
