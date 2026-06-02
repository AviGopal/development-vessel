import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * enact-orthogonal-decisions — closes the meta-loop between
 * `observe-orthogonal-patterns` (which writes a JSON array of MODIFY /
 * CREATE_DETECTOR / CREATE_CONSUMER decisions under
 * `/workspace/observations/orthogonal-<ts>.json`) and the drafter
 * (`draft-gap-closing-activity`).
 *
 * Without this activity the decisions sit unconsumed on disk. With it,
 * each boredom tick that lands on this template picks the highest-priority
 * CREATE_DETECTOR / CREATE_CONSUMER decision from the latest observation,
 * synthesizes a failure-mode-style scenario JSON (mirroring the
 * `auto-*.json` shape), writes it to the scenarios dir, and dispatches
 * `draft-gap-closing-activity` against the new scenario_id. MODIFY
 * decisions are explicitly NOT dispatched yet — a modify pathway doesn't
 * exist; instead the LLM is asked to mark them as pending so a future
 * modify-activity (or operator review) can pick them up.
 *
 * Pattern: compose-only. No resolver changes. Five tasks:
 *
 *   1. read_latest_observation     — fs_read the path passed via
 *                                    `observation_path`.
 *   2. extract_create_decisions    — llm_completion_dispatch filters the
 *                                    JSON array down to the highest-
 *                                    priority CREATE_DETECTOR or
 *                                    CREATE_CONSUMER entry and returns a
 *                                    single scenario-ready object (or a
 *                                    sentinel when none exist).
 *   3. synthesize_scenarios        — llm_completion_dispatch wraps the
 *                                    chosen decision in the
 *                                    auto-scenario JSON contract
 *                                    consumed by draft-gap-closing-
 *                                    activity (id, mode_class,
 *                                    expected_emergence, etc.).
 *   4. write_scenarios             — fs_write the synthesized scenario
 *                                    to /workspace/validation/failure-
 *                                    modes/scenarios/enacted-<ts>.json
 *                                    (single file per dispatch — the
 *                                    drafter only consumes one at a
 *                                    time; iterate via boredom cadence).
 *   5. dispatch_drafter            — http_fetch POST to goal-host
 *                                    /run-goal with
 *                                    targetTemplateId=draft-gap-closing-
 *                                    activity and the synthesized
 *                                    scenario_id in variables.
 *
 * Variables (all defaults documented; caller supplies concrete paths):
 *   observation_path  — absolute path to the orthogonal-<ts>.json file
 *                       (default-doc: /workspace/observations/).
 *   scenarios_dir     — directory where the synthesized scenario lands
 *                       (default-doc: /workspace/validation/failure-
 *                       modes/scenarios/).
 *   report_path       — pass-through for the drafter dispatch (defaults
 *                       to the latest harness report).
 *   proposals_dir     — pass-through for the drafter dispatch.
 *   dispatch_ts       — short timestamp suffix used in the scenario id
 *                       so each dispatch produces a fresh file.
 */
export const ENACT_ORTHOGONAL_DECISIONS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:enact-orthogonal-decisions",
  name: "enact-orthogonal-decisions",
  description:
    "Reads the latest /workspace/observations/orthogonal-<ts>.json " +
    "decision array, picks the highest-priority CREATE_DETECTOR or " +
    "CREATE_CONSUMER decision, synthesizes a failure-mode-style scenario " +
    "JSON, writes it to the scenarios dir, and dispatches " +
    "draft-gap-closing-activity against the new scenario id. Closes the " +
    "meta-loop between orthogonal observation and substrate authoring. " +
    "MODIFY decisions are deferred — they are surfaced as " +
    "pendingModifyDecision context inside the synthesizer prompt so a " +
    "future modify-activity (or operator) can pick them up. Compose-only " +
    "— adds no resolver code.",
  inputShapes: [],
  outputShapes: ["healthGapDispatch"],
  tags: [
    "lift.autonomous.loop",
    "orthogonal.learning",
    "observation.to.action",
    "substrate.self.authoring",
  ],
  variables: [
    {
      name: "observation_path",
      description:
        "Absolute path to the orthogonal-<timestamp>.json observation " +
        "file produced by observe-orthogonal-patterns. Default convention: " +
        "/workspace/observations/orthogonal-*.json — caller picks the most " +
        "recent file and passes the concrete path here.",
    },
    {
      name: "scenarios_dir",
      description:
        "Directory where the synthesized failure-mode-style scenario " +
        "JSON is written. Default: " +
        "/workspace/validation/failure-modes/scenarios/.",
    },
    {
      name: "report_path",
      description:
        "Path to the latest failure-mode harness report. Passed " +
        "through to draft-gap-closing-activity unchanged.",
    },
    {
      name: "proposals_dir",
      description:
        "Directory where the drafter writes proposal JSON. Pass-through " +
        "to draft-gap-closing-activity.",
    },
    {
      name: "dispatch_ts",
      description:
        "Short ISO-like timestamp suffix used in the synthesized " +
        "scenario id and filename so each dispatch produces a fresh file " +
        "(e.g. 20260602T030000Z).",
    },
  ],
  tasks: [
    {
      id: "read_latest_observation",
      description:
        "Load the orthogonal-decisions JSON array written by " +
        "observe-orthogonal-patterns. The path is supplied via " +
        "observation_path so the dispatcher picks the freshest file.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{observation_path}}",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "extract_create_decisions",
      description:
        "LLM filter pass: scan the observation array and pick the single " +
        "highest-priority decision with kind CREATE_DETECTOR or " +
        "CREATE_CONSUMER. Output is a strict JSON object with the " +
        "chosen decision plus a parallel list of any MODIFY decisions " +
        "so the synthesizer can surface them as pendingModifyDecision " +
        "context. Returns a sentinel { chosen: null } when no create-" +
        "kind decisions exist so downstream tasks short-circuit cleanly.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON " +
          "with no surrounding text.",
        prompt:
          "You receive a JSON array of catalogue-change decisions emitted " +
          "by observe-orthogonal-patterns. Each element has fields: " +
          "kind (MODIFY|CREATE_DETECTOR|CREATE_CONSUMER), target, " +
          "rationale, evidence_trace_ids.\n\n" +
          "## Observation array\n\n" +
          "{{read_latest_observation_content}}\n\n" +
          "## Task\n\n" +
          "1. Filter to decisions where kind == 'CREATE_DETECTOR' or " +
          "kind == 'CREATE_CONSUMER'.\n" +
          "2. Rank them: CREATE_DETECTOR with the largest " +
          "evidence_trace_ids count first; ties broken by length of " +
          "rationale (shorter = more confident); then CREATE_CONSUMER " +
          "with the same rule.\n" +
          "3. Output ONLY a JSON object with this exact shape:\n" +
          '{\n' +
          '  "chosen": { "kind": "...", "target": "...", "rationale": "...", "evidence_trace_ids": [...] } | null,\n' +
          '  "pending_modify": [ { "kind": "MODIFY", "target": "...", "rationale": "..." }, ... ]\n' +
          '}\n\n' +
          "If no CREATE_DETECTOR / CREATE_CONSUMER decisions exist, set " +
          "chosen to null. pending_modify carries every MODIFY entry as-" +
          "is so the synthesizer can include them as pendingModifyDecision " +
          "context. Output ONLY the JSON object — no fences, no prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 1500,
      },
      outputShapes: ["orthogonalDecisionSelection"],
    },
    {
      id: "synthesize_scenarios",
      description:
        "LLM wraps the chosen CREATE_DETECTOR / CREATE_CONSUMER decision " +
        "in a failure-mode-style scenario JSON matching the contract " +
        "consumed by draft-gap-closing-activity (id, mode_class, stage, " +
        "outcome_class, title, description, goal_text, " +
        "expected_input_shapes, expected_output_shapes, cited_concepts, " +
        "expected_emergence.activity_signature.output_shapes_must_include). " +
        "The synthesized scenario carries the original decision's " +
        "rationale and evidence_trace_ids verbatim plus a " +
        "pendingModifyDecision array for any MODIFY entries surfaced " +
        "by the previous task — context the drafter can use.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON " +
          "with no surrounding text.",
        prompt:
          "You receive a chosen orthogonal decision plus a list of pending " +
          "MODIFY decisions. Your job is to wrap the chosen decision in a " +
          "failure-mode-style scenario JSON that draft-gap-closing-activity " +
          "can consume.\n\n" +
          "## Chosen + pending\n\n" +
          "{{extract_create_decisions_content}}\n\n" +
          "## Dispatch timestamp\n\n" +
          "{{dispatch_ts}}\n\n" +
          "## Output contract\n\n" +
          "If the input has chosen == null, output exactly:\n" +
          '{ "id": "enacted-{{dispatch_ts}}-noop", "mode_class": "enacted_orthogonal", "stage": "noop", "outcome_class": "noop", "title": "No CREATE_DETECTOR or CREATE_CONSUMER decisions in latest observation", "description": "Synthesizer short-circuited; no enactment needed this tick.", "goal_text": "noop", "expected_input_shapes": [], "expected_output_shapes": [], "cited_concepts": [], "expected_emergence": { "activity_signature": { "output_shapes_must_include": [] } }, "pendingModifyDecision": [] }\n\n' +
          "Otherwise output:\n" +
          '{\n' +
          '  "id": "enacted-{{dispatch_ts}}-<short-slug>",\n' +
          '  "mode_class": "enacted_orthogonal",\n' +
          '  "stage": "synthesis",\n' +
          '  "outcome_class": "gap",\n' +
          '  "title": "Enacted orthogonal decision: <kind> for <target>",\n' +
          '  "description": "<combines the chosen rationale with what the drafter should produce. Quote the original rationale verbatim and cite evidence_trace_ids.>",\n' +
          '  "goal_text": "<CREATE_DETECTOR: \\"detect <signature>\\"; CREATE_CONSUMER: \\"consume <shape> downstream\\">",\n' +
          '  "expected_input_shapes": [],\n' +
          '  "expected_output_shapes": [],\n' +
          '  "cited_concepts": [],\n' +
          '  "expected_emergence": {\n' +
          '    "activity_signature": {\n' +
          '      "output_shapes_must_include": ["<CREATE_DETECTOR -> a sensible detector output shape like detectionReport; CREATE_CONSUMER -> a sensible consumer output shape based on the target name>"]\n' +
          '    }\n' +
          '  },\n' +
          '  "orthogonal_decision": { "kind": "...", "target": "...", "rationale": "...", "evidence_trace_ids": [...] },\n' +
          '  "pendingModifyDecision": [ ...the MODIFY entries verbatim... ]\n' +
          '}\n\n' +
          "Rules:\n" +
          "- The id must start with 'enacted-{{dispatch_ts}}-' and end " +
          "with a short kebab-case slug derived from the target (≤20 " +
          "chars, ASCII lowercase letters/digits/hyphen).\n" +
          "- Quote the original rationale verbatim inside description.\n" +
          "- evidence_trace_ids in orthogonal_decision MUST be copied " +
          "from the chosen decision verbatim.\n" +
          "- Output ONLY the JSON object. No fences. No prose.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 1500,
      },
      outputShapes: ["enactedOrthogonalScenario"],
    },
    {
      id: "extract_scenario_id",
      description:
        "Pull the synthesized scenario's id field so the dispatcher can " +
        "reference it. Deterministic — json_path_extract avoids LLM " +
        "round-trip drift on the id field.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{synthesize_scenarios_content}}",
        path: "id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "write_scenarios",
      description:
        "Persist the synthesized scenario to scenarios_dir as a single " +
        "file. The drafter consumes one scenario per dispatch; the " +
        "boredom cadence iterates through observations across ticks.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{scenarios_dir}}/enacted-{{dispatch_ts}}.json",
        content: "{{synthesize_scenarios_content}}",
      },
      outputShapes: ["fileWriteResult"],
    },
    {
      id: "dispatch_drafter",
      description:
        "POST to goal-host /run-goal with targetTemplateId=" +
        "draft-gap-closing-activity and the synthesized scenario_id. " +
        "The drafter's fs_read picks up the file just written by " +
        "write_scenarios. When the synthesizer chose the noop sentinel, " +
        "the drafter will fail fast on the noop scenario — a normal " +
        "trace, not an error.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "draft a gap-closing activity for enacted orthogonal " +
            "decision {{extract_scenario_id_text}}",
          targetTemplateId: "development-vessel:draft-gap-closing-activity",
          variables: {
            scenario_id: "{{extract_scenario_id_text}}",
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
