import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

const PROMPT_TEMPLATE = `You are helping build a self-improving activity system.

Below is a failure-mode scenario that the system currently cannot handle autonomously
(emergence_class="gap"). Your task is to draft a candidate activity template (JSON) that,
if executed by the system, would produce the evidence or trace needed to close this gap.

## Failure-Mode Scenario
{{read_scenario_content}}

## Requirements for the drafted template
1. Use only these resolver names: fs_read, fs_write, fs_edit, git_status, git_diff,
   git_log, activity_fetch, activity_create_variant, llm_completion_dispatch.
2. Do NOT add resolvers that are not in the list above.
3. The template must have: id, name, description, inputShapes, outputShapes, tasks[].
4. Output ONLY valid JSON — no markdown, no prose before or after.
5. The template id must start with "gap-closing:" followed by the scenario id.
6. The output shape must include the shape named in the scenario's
   expected_emergence.activity_signature.output_shapes_must_include list
   (or "gapClosingTrace" if none specified).

Respond with the JSON template only.`;

export const DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:draft-gap-closing-activity",
  name: "draft-gap-closing-activity",
  description:
    "Given a failure-mode report path and a scenario_id, reads the scenario JSON, " +
    "drafts a candidate gap-closing activity template via llm_completion_dispatch, " +
    "writes the proposal file, and registers it as a variant in activity-api. " +
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
      id: "draft_via_llm",
      description:
        "Dispatch to a discovered llm_completion vessel to draft the candidate template JSON.",
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
