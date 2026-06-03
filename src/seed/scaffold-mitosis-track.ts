import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * scaffold-mitosis-track — substrate-authored vessel self-modification.
 *
 * Composes the four primitives needed to spawn a parallel-track copy of an
 * existing vessel with an LLM-authored source patch, without operator
 * intervention:
 *
 *   1. concept_select_for_prompt — pull vessel_construction_pattern priors
 *      so the LLM rewrite respects observed scaffold idioms.
 *   2. fs_read — load the current target file from the base vessel tree.
 *   3. llm_completion_dispatch — generate the modified source content.
 *   4. vessel_mitosis_start — copy the vessel tree, overlay the new source,
 *      write a systemd unit on the mitosis port, return
 *      vesselMitosisInitiated.
 *
 * Triggered by boredom goal[13] when the highest-priority MODIFY decision
 * from code_needs_report names a substrate-resident template/resolver. The
 * substrate observes the need, dispatches the fix, and produces a
 * parallel-track artifact as a side effect of normal operation.
 *
 * Constraints (inherits from vessel_mitosis_start resolver):
 *   - vessel_name MUST NOT be discovery-vessel or identity-vessel (H4 baseline).
 *   - mitosis_root never overlaps base source_root.
 *   - source_changes apply only within mitosis_root.
 *
 * v0.1 limitation: llm_completion_dispatch is not constrained to emit
 * fence-less source. If the LLM wraps output in ``` fences, the
 * vessel_mitosis_start writeFile receives the fenced text verbatim. That is
 * a chain-truncation pattern the next iteration must catch (e.g. a
 * code-fence-strip post-processor, or LLM prompt strengthening). For this
 * shipping iteration we document the failure mode rather than paper over
 * it — substrate self-detection principle (feedback_substrate_self_detection_recursive.md).
 */

const PROMPT_TEMPLATE = `You are the substrate's self-modification drafter.

## Goal
{{intent_summary}}

## Vessel & target file
- Vessel: {{vessel_name}}
- File path within vessel: {{target_file_path}}

## Concept priors (vessel_construction_pattern)
These are vessel-authoring patterns the substrate has observed succeed. Respect them.

{{pull_priors_text}}

## Current file content
The file at /vessels/{{vessel_name}}/{{target_file_path}} currently contains:

\`\`\`
{{read_current_source_content}}
\`\`\`

## Your task
Generate the FULL modified file content that addresses the goal above.

CRITICAL OUTPUT RULES:
1. Return ONLY the source code — no commentary, no markdown fence (no \`\`\`), no prose before or after.
2. Preserve all existing imports, exports, and type declarations unless the goal explicitly requires changing them.
3. The output replaces the file verbatim; the substrate's vessel_mitosis_start resolver writes your output directly to disk.
4. If you cannot determine a safe modification, return the original file unchanged rather than guessing.`;

export const SCAFFOLD_MITOSIS_TRACK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:scaffold-mitosis-track",
  name: "scaffold-mitosis-track",
  description:
    "Substrate-authored self-modification: pulls vessel_construction_pattern concept priors, " +
    "reads the current target source file, dispatches an LLM to draft a modified version, and " +
    "spawns a parallel-track copy of the vessel via vessel_mitosis_start so the two tracks run " +
    "simultaneously and can be evaluated empirically. Closes the autonomous self-improvement " +
    "loop: substrate observes need → dispatches fix → produces parallel-track artifact.",
  inputShapes: [],
  outputShapes: ["vesselMitosisInitiated"],
  tags: [
    "intent:self_modification",
    "phase:author",
    "lift.autonomous.loop",
    "boredom_target_template",
  ],
  variables: [
    {
      name: "vessel_name",
      description:
        "Vessel to mitose. MUST NOT be discovery-vessel or identity-vessel (H4 baseline guard).",
    },
    {
      name: "target_file_path",
      description:
        "Relative path of the file to modify within the vessel (e.g. src/seed/draft-gap-closing-activity.ts).",
    },
    {
      name: "intent_summary",
      description:
        "Why the modification is being made — fed to the LLM as the goal and to vessel_mitosis_start as the mitosis label.",
    },
  ],
  tasks: [
    {
      id: "pull_priors",
      description:
        "Pull substrate-observed vessel_construction_pattern concepts so the LLM's source rewrite " +
        "respects accumulated scaffold idioms. Failure is non-fatal — empty priors degrade quality " +
        "but the chain proceeds.",
      resolver: "concept_select_for_prompt",
      config: {
        type: "concept_select_for_prompt",
        query: "{{intent_summary}}",
        prior_source_types: ["vessel_construction_pattern"],
        budget_tokens: 3000,
      },
      outputShapes: ["conceptPromptPriors"],
    },
    {
      id: "read_current_source",
      description:
        "Load the current contents of the target file from the base vessel tree at " +
        "/vessels/{{vessel_name}}/{{target_file_path}}. Used by the LLM as the editing baseline.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/vessels/{{vessel_name}}/{{target_file_path}}",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "generate_modified_source",
      description:
        "Dispatch llm_completion to draft the modified source. Output is consumed verbatim by " +
        "vessel_mitosis_start — fence-stripping and idempotence enforcement are NOT yet wired " +
        "(documented as a v0.1 failure mode in this template's source comment).",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise source-code generator. Output only the raw source file content with no markdown fences and no commentary.",
        prompt: PROMPT_TEMPLATE,
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 8000,
      },
      outputShapes: ["llmCompletionResult"],
    },
    {
      id: "spawn_parallel_track",
      description:
        "Invoke vessel_mitosis_start with the LLM-authored source overlay. Copies the base vessel " +
        "tree to mitosis_root, applies source_changes, rewrites src/config.ts PORT default, writes " +
        "a systemd unit on mitosis_port carrying MITOSIS_VERSION_ID + MITOSIS_BASE_VESSEL into the " +
        "child process environment. Emits vesselMitosisInitiated.",
      resolver: "vessel_mitosis_start",
      config: {
        type: "vessel_mitosis_start",
        vessel_name: "{{vessel_name}}",
        intent_summary: "{{intent_summary}}",
        source_changes: [
          {
            target_path: "{{target_file_path}}",
            new_content: "{{generate_modified_source_text}}",
          },
        ],
        base_port: 8090,
        mitosis_port: 8091,
      },
      outputShapes: ["vesselMitosisInitiated"],
    },
  ],
};
