import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * enact-orthogonal-decisions — closes the meta-loop between the substrate's
 * observation surfaces and its self-authoring drafters.
 *
 * Two parallel observation sources feed the dispatch decision:
 *
 *   1. orthogonal-decisions JSON array written by `observe-orthogonal-patterns`
 *      under `/workspace/observations/orthogonal-<ts>.json`. Encodes
 *      CREATE_DETECTOR / CREATE_CONSUMER / MODIFY decisions surfaced by the
 *      pattern observer.
 *
 *   2. live `code_needs_report` (resolver call, no file read). Surfaces MODIFY
 *      decisions sourced from failure-pattern aggregation in execution traces
 *      (broken templates, chain-truncation patterns, etc.). This is the LIVE
 *      arm — when the substrate's drafter itself breaks (e.g.
 *      `draft-gap-closing-activity` chain truncation), it shows up here as a
 *      top MODIFY decision.
 *
 * The template synthesizes ONE dispatch decision from both inputs:
 *
 *   - If `code_needs_report.top_priority` is a MODIFY with priority_score ≥
 *     `modify_priority_floor` (default 0.4) → dispatch
 *     `development-vessel:scaffold-mitosis-track` with variables derived live
 *     from the broken target id (vessel_name + target_file_path +
 *     intent_summary). This is the autonomous self-modification path.
 *
 *   - Otherwise, if the orthogonal observation has a chosen CREATE_DETECTOR /
 *     CREATE_CONSUMER decision → synthesize a failure-mode-style scenario JSON
 *     and dispatch `development-vessel:draft-gap-closing-activity`. This is
 *     the autonomous detector/consumer authoring path.
 *
 *   - Otherwise, dispatch a noop scenario so the chain still completes with a
 *     normal trace (β+=1 in Thompson posteriors is fine — informative).
 *
 * Compose-only: no resolver changes. The synthesizer + dispatcher tasks
 * encode the branch logic in their LLM/json_path_extract config; no
 * conditional task graph required at the executor level.
 */

const SYNTHESIZE_DISPATCH_PROMPT = `You are the substrate's autonomous-dispatch decider. You receive TWO observation sources and must output a single dispatch decision in strict JSON.

## Source A: orthogonal observation (file-backed pattern decisions)

{{read_latest_observation_content}}

## Source B: live code_needs_report (trace-aggregation decisions)

{{read_code_needs_value_json}}

## Dispatch timestamp

{{dispatch_ts}}

## Decision rules (apply in order)

1. **MODIFY priority**: if Source B has a top_priority entry with action="MODIFY" and priority_score >= {{modify_priority_floor}}, emit dispatch_kind="mitosis":
   - target_template_id: "development-vessel:scaffold-mitosis-track"
   - Derive vessel_name from the broken template id (e.g. id "activity:⟨development-vessel:draft-gap-closing-activity⟩" → vessel_name "development-vessel"; id "development-vessel:foo" → "development-vessel"; id "gap-closing:auto-…" → "development-vessel" by convention since gap-closing variants live there).
   - Derive target_file_path: take the substring AFTER the first ":" (after stripping any "activity:⟨…⟩" wrapper); convert to "src/seed/<that>.ts" by convention. For an id like "development-vessel:draft-gap-closing-activity" the file is "src/seed/draft-gap-closing-activity.ts". For "gap-closing:auto-<slug>" the file is "src/seed/draft-gap-closing-activity.ts" (the drafter that authored it).
   - intent_summary: combine the top_priority reason + cited_evidence to describe what should change. Keep under 400 chars. Quote the reason verbatim where possible.

2. **CREATE_DETECTOR / CREATE_CONSUMER**: if Source A has CREATE_DETECTOR or CREATE_CONSUMER entries, pick the highest-evidence-count CREATE_DETECTOR (or fallback CREATE_CONSUMER). Emit dispatch_kind="drafter":
   - target_template_id: "development-vessel:draft-gap-closing-activity"
   - Synthesize a scenario JSON matching the auto-scenarios contract:
     { id, mode_class, stage, outcome_class, title, description, goal_text, expected_input_shapes, expected_output_shapes, cited_concepts, expected_emergence: { activity_signature: { output_shapes_must_include } }, orthogonal_decision: { kind, target, rationale, evidence_trace_ids } }
   - scenario_id MUST be "enacted-{{dispatch_ts}}-<short-slug>" derived from the target name (kebab-case, <=20 chars, ASCII lowercase letters/digits/hyphen).
   - For CREATE_DETECTOR: output_shapes_must_include should be a sensible detector shape like ["detectionReport"]. For CREATE_CONSUMER: derive from the target name (e.g. target "concept_usage_record" → ["conceptUsageOutcome"]).

3. **Noop**: otherwise emit dispatch_kind="noop":
   - target_template_id: "development-vessel:draft-gap-closing-activity"
   - scenario_id: "enacted-{{dispatch_ts}}-noop"
   - scenario_json: a minimal noop body (id, mode_class="enacted_orthogonal", stage="noop", outcome_class="noop", title, description, goal_text="noop", empty arrays for the shape fields, expected_emergence.activity_signature.output_shapes_must_include=[])

## Output contract — output ONLY this JSON, no fences, no prose

{
  "dispatch_kind": "mitosis" | "drafter" | "noop",
  "target_template_id": "development-vessel:scaffold-mitosis-track" | "development-vessel:draft-gap-closing-activity",
  "mitosis_vars": {
    "vessel_name": "...",
    "target_file_path": "...",
    "intent_summary": "..."
  },
  "drafter_vars": {
    "scenario_id": "enacted-{{dispatch_ts}}-<slug>",
    "scenario_json": { ...synthesized scenario object, or null if dispatch_kind != "drafter" and != "noop"... }
  },
  "derivation_notes": "1-2 sentences explaining which source + entry drove the choice and what was derived from it. Quote priority_score / evidence counts."
}

When dispatch_kind="mitosis", set drafter_vars.scenario_json to null (it is unused). When dispatch_kind="drafter" or "noop", set mitosis_vars to zero-strings ("") — the field is unused in those branches.`;

export const ENACT_ORTHOGONAL_DECISIONS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:enact-orthogonal-decisions",
  name: "enact-orthogonal-decisions",
  description:
    "Reads two observation sources — (1) the latest orthogonal-decisions file, (2) live code_needs_report — and synthesizes a single dispatch decision. " +
    "Routes MODIFY priorities from code_needs_report to scaffold-mitosis-track (substrate self-modification). " +
    "Routes CREATE_DETECTOR / CREATE_CONSUMER orthogonal decisions to draft-gap-closing-activity (substrate self-authoring). " +
    "Closes both meta-loops in one template. Compose-only — adds no resolver code. " +
    "Variables (vessel_name, target_file_path, intent_summary, scenario_id) are DERIVED LIVE from observation data, " +
    "not hardcoded by the caller.",
  inputShapes: [],
  outputShapes: ["healthGapDispatch"],
  tags: [
    "lift.autonomous.loop",
    "orthogonal.learning",
    "observation.to.action",
    "substrate.self.authoring",
    "substrate.self.modification",
  ],
  variables: [
    {
      name: "observation_path",
      description:
        "Absolute path to the orthogonal-<timestamp>.json observation file (Source A). " +
        "Pass-through to the file reader; if absent or unreachable, the reader produces an empty " +
        "fileContent which the LLM treats as 'no CREATE_* decisions'.",
    },
    {
      name: "scenarios_dir",
      description:
        "Directory where the synthesized scenario JSON is written (used only in the drafter branch).",
    },
    {
      name: "report_path",
      description:
        "Path to the latest failure-mode harness report. Pass-through to draft-gap-closing-activity.",
    },
    {
      name: "proposals_dir",
      description:
        "Directory where the drafter writes proposal JSON. Pass-through.",
    },
    {
      name: "dispatch_ts",
      description:
        "Short ISO-like timestamp suffix used in the synthesized scenario id and filename.",
    },
    {
      name: "modify_priority_floor",
      description:
        "Minimum priority_score (0..1) for a MODIFY decision from code_needs_report to trigger " +
        "mitosis dispatch. Default 0.4 — below this the orthogonal CREATE_* branch is preferred.",
    },
  ],
  tasks: [
    {
      id: "read_latest_observation",
      description:
        "Load the orthogonal-decisions JSON array written by observe-orthogonal-patterns. " +
        "Source A of the dispatch decision.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{observation_path}}",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "read_code_needs",
      description:
        "Source B of the dispatch decision: synthesizes recent traces + templates + advertised " +
        "shapes into MODIFY / CREATE_RESOLVER / etc. decisions. The substrate observes its own " +
        "failure patterns here — broken-template MODIFY entries originate from preflight + " +
        "chain-truncation aggregations. Deterministic resolver, no LLM.",
      resolver: "code_needs_report",
      config: {
        type: "code_needs_report",
        traceLimit: 100,
        brokenTemplateThreshold: 3,
        resolverDemandThreshold: 3,
      },
      outputShapes: ["codeNeedsReport"],
    },
    {
      id: "synthesize_dispatch",
      description:
        "LLM combines both observation sources and emits a single dispatch decision. " +
        "Branch logic (MODIFY → mitosis vs CREATE_* → drafter vs noop) lives in the prompt. " +
        "Output is a strict JSON object whose fields downstream json_path_extract tasks read " +
        "to construct the http_fetch body.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON with no surrounding text, no markdown fences, no prose.",
        prompt: SYNTHESIZE_DISPATCH_PROMPT,
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 2500,
      },
      outputShapes: ["enactedDispatchDecision"],
    },
    {
      id: "extract_dispatch_kind",
      description:
        "Pull dispatch_kind from the synthesized decision. Drives the http_fetch branch via the " +
        "extracted_target_template_id and extracted_scenario_json fields.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_dispatch_content}}",
        path: "dispatch_kind",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_target_template_id",
      description:
        "Pull target_template_id from the synthesized decision — same source used as the " +
        "scaffold-mitosis-track / draft-gap-closing-activity selector in the http_fetch body.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_dispatch_content}}",
        path: "target_template_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_mitosis_vessel_name",
      description:
        "Pull mitosis_vars.vessel_name. Empty string when dispatch_kind != mitosis.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_dispatch_content}}",
        path: "mitosis_vars.vessel_name",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_mitosis_target_file_path",
      description: "Pull mitosis_vars.target_file_path.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_dispatch_content}}",
        path: "mitosis_vars.target_file_path",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_mitosis_intent_summary",
      description: "Pull mitosis_vars.intent_summary.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_dispatch_content}}",
        path: "mitosis_vars.intent_summary",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_drafter_scenario_id",
      description: "Pull drafter_vars.scenario_id (used only when dispatch_kind != mitosis).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_dispatch_content}}",
        path: "drafter_vars.scenario_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_drafter_scenario_json",
      description: "Pull drafter_vars.scenario_json as a string for file persistence.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_dispatch_content}}",
        path: "drafter_vars.scenario_json",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "write_drafter_scenario",
      description:
        "Persist the synthesized scenario JSON for the drafter to pick up. When " +
        "dispatch_kind=mitosis the JSON value is null/empty-string; the write still happens " +
        "(harmless empty file) but the drafter isn't dispatched. Single file per tick.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{scenarios_dir}}/enacted-{{dispatch_ts}}.json",
        content: "{{extract_drafter_scenario_json_value_json}}",
      },
      outputShapes: ["fileWriteResult"],
    },
    {
      id: "dispatch_decision",
      description:
        "Single dispatch step. Routes to scaffold-mitosis-track or draft-gap-closing-activity " +
        "based on the extracted target_template_id. Variables come from the LIVE-derived " +
        "mitosis_vars or drafter_vars — no operator hardcoding. The unused branch's vars are " +
        "passed verbatim but ignored by the receiving template (extra variables are inert).",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "enact orthogonal decision: dispatch_kind={{extract_dispatch_kind_text}}, " +
            "target={{extract_target_template_id_text}}",
          targetTemplateId: "{{extract_target_template_id_text}}",
          variables: {
            // mitosis branch
            vessel_name: "{{extract_mitosis_vessel_name_text}}",
            target_file_path: "{{extract_mitosis_target_file_path_text}}",
            intent_summary: "{{extract_mitosis_intent_summary_text}}",
            // drafter branch
            scenario_id: "{{extract_drafter_scenario_id_text}}",
            scenarios_dir: "{{scenarios_dir}}",
            report_path: "{{report_path}}",
            proposals_dir: "{{proposals_dir}}",
            source: "enact-orthogonal-decisions",
          },
        }),
      },
      outputShapes: ["healthGapDispatch"],
    },
  ],
};
