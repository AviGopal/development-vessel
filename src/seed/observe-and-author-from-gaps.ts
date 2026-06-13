import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * observe-and-author-from-gaps — autonomous gap-from-observation activity.
 *
 * Closes the substrate's self-analysis loop: reads the most-recent
 * coverageReport and substrateHealthReport (emitted by coverage-tick and
 * substrate-health-tick — now fired every boredom cycle, not 1-of-12),
 * extracts a measurement gap from one of them, drafts an fm-auto failure-mode
 * scenario describing the gap, persists it, and dispatches
 * draft-gap-closing-activity against it. Substrate observes its own state and
 * authors closures from those observations without operator scenario input.
 *
 * Pipeline:
 *   1. read_recent_coverage_traces — http_fetch /v2/activities/execution-traces
 *      filtered to recent coverage-tick executions; returns the trace list.
 *   2. read_recent_health_traces — same filter for substrate-health-tick.
 *   3. read_dispatched_dedupe — fs_read the in-tree dedupe map; LLM uses it
 *      to skip gaps already drafted within the dedupe window. Missing file
 *      is fine (resolver fails graceful, dedupe is best-effort).
 *   4. extract_gap_and_author_scenario — llm_completion_dispatch produces a
 *      scenario JSON that satisfies validation/failure-modes/schema.json.
 *      The prompt requires:
 *        - scenario id matching ^fm-auto-<unix-ts>-[a-z0-9]{6,8}$ (a subset
 *          of the schema's ^(fm|fp)-\d{2,3}-[a-z0-9-]+$ regex — the digit
 *          count comes from the unix timestamp; the dash-separated short
 *          hash provides intra-second uniqueness)
 *        - description citing exactly which field of which report drove
 *          the authoring decision (audit trail, not vibes)
 *        - expected_emergence.activity_signature.output_shapes_must_include
 *          set to the shape(s) the gap indicates are missing
 *   5. extract_scenario_id — json_path_extract pulls scenario.id from the
 *      LLM output deterministically; downstream tasks no-op on empty.
 *   6. write_scenario — fs_write the scenario JSON to
 *      {{scenarios_dir}}/<scenario_id>.json. Becomes a normal harness input.
 *   7. update_dispatched_map — fs_write appends the new id to the dedupe map
 *      via a write-through-prefix pattern (json_path_extract reads, append,
 *      write). Best-effort.
 *   8. dispatch_drafter — http_fetch POSTs to goal-host /run-goal targeting
 *      draft-gap-closing-activity with the new scenario_id. The drafter then
 *      runs the full author→register→variant chain (already specced).
 *
 * Deduplication:
 *   /workspace/proposals/_auto_dispatched.json is a {"<scenario_id>":"<iso>"}
 *   map. The LLM is given its contents and instructed to refuse minting a
 *   scenario whose normalised "observed_gap_signature" already appears within
 *   the dedupe window — preventing the same gap from spawning 10 identical
 *   fm-auto-* scenarios per night.
 *
 * Coverage progress signal:
 *   If coverageReport carries an explicit boolean `coverage_progress`, the
 *   LLM gates on that. If absent (older traces), the prompt instructs it to
 *   infer progress from the cell-count delta between the two most-recent
 *   reports (per the operator constraint).
 */
export const OBSERVE_AND_AUTHOR_FROM_GAPS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:observe-and-author-from-gaps",
  name: "observe-and-author-from-gaps",
  description:
    "Autonomous gap-from-observation: reads the most-recent coverageReport + " +
    "substrateHealthReport traces, identifies one observable gap (uncovered shape " +
    "combination, sub-floor vessel health, slow resolver tier, missing producer), " +
    "and drafts an fm-auto-<timestamp>-<hash> failure-mode scenario describing it. " +
    "Persists the scenario into the harness scenarios directory and dispatches " +
    "draft-gap-closing-activity against it. Closes the substrate's self-analysis " +
    "loop — measurement → drafted scenario → gap-closing template → variant — " +
    "without operator scenario authoring.",
  inputShapes: ["coverageReport", "substrateHealthReport"],
  outputShapes: ["gapScenario", "healthGapDispatch"],
  tags: [
    "intent:topology_discovery",
    "phase:author",
    "topology.discovery.loop",
    "lift.autonomous.loop",
    "substrate.self.analysis",
  ],
  variables: [
    {
      name: "activity_api_endpoint",
      description: "Base URL for activity-api. Default http://127.0.0.1:8080.",
      default: "http://127.0.0.1:8080",
    },
    {
      name: "goal_host_endpoint",
      description: "Base URL for goal-host-vessel. Default http://127.0.0.1:8210.",
      default: "http://127.0.0.1:8210",
    },
    {
      name: "scenarios_dir",
      description: "Where the new fm-auto scenario JSON gets written. Default /workspace/validation/failure-modes/scenarios.",
      default: "/workspace/validation/failure-modes/scenarios",
    },
    {
      name: "proposals_dir",
      description: "Where the dedupe map lives. Default /workspace/proposals.",
      default: "/workspace/proposals",
    },
    {
      name: "dedupe_window_hours",
      description: "Suppress duplicate fm-auto scenarios for the same observed gap signature within this window. Default 6.",
    },
    {
      name: "drafter_template_id",
      description: "Target template id dispatched once the scenario is persisted. Default development-vessel:draft-gap-closing-activity.",
    },
    {
      name: "report_path",
      description: "Latest failure-mode harness report (forwarded to drafter so its read_report step succeeds). Default /workspace/validation/results/latest-failure-mode-report.json.",
    },
  ],
  tasks: [
    {
      id: "read_recent_coverage_traces",
      description:
        "Fetch the 5 most-recent coverage-tick execution traces. The traces carry " +
        "the coverageReport impulse body (cells_over_time + monotonic_progress + " +
        "coverage_progress + total_advertised_shapes + total_learned_unique). Used " +
        "downstream to identify uncovered shape combinations.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{activity_api_endpoint}}/v2/activities/execution-traces?limit=5&activity_template_id=development-vessel:coverage-tick",
        headers: { Accept: "application/json" },
        timeoutMs: 10000,
      },
      outputShapes: ["coverageTraceBatch"],
    },
    {
      id: "read_recent_health_traces",
      description:
        "Fetch the 5 most-recent substrate-health-tick execution traces. The traces " +
        "carry the substrateHealthReport impulse body (health_verdict + per-vessel " +
        "confidence + below_floor list). Used downstream to identify health-floor gaps.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{activity_api_endpoint}}/v2/activities/execution-traces?limit=5&activity_template_id=development-vessel:substrate-health-tick",
        headers: { Accept: "application/json" },
        timeoutMs: 10000,
      },
      outputShapes: ["healthTraceBatch"],
    },
    {
      id: "read_dedupe_map",
      description:
        "Load the in-memory dedupe map for fm-auto scenarios. Missing file = empty " +
        "map (resolver returns an error string; the LLM treats either an error or " +
        "an empty object as 'no prior dispatches').",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{proposals_dir}}/_auto_dispatched.json",
      },
      outputShapes: ["dedupeMap"],
    },
    {
      id: "extract_gap_and_author_scenario",
      description:
        "LLM step: identify ONE observable gap from the most-recent coverage + " +
        "health traces and author a failure-mode scenario from it. Output must " +
        "satisfy validation/failure-modes/schema.json including the regex on `id`.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only one valid JSON object " +
          "with no surrounding prose, no markdown fences, no commentary.",
        prompt:
          "You are the substrate's self-analysis drafter. Read the recent coverage + " +
          "health traces below and identify ONE observable gap that the substrate " +
          "could meaningfully close by authoring a new gap-closing activity.\n\n" +
          "Candidate gaps (pick exactly one — prefer (1)→(2)→(3) order):\n" +
          "  1. An uncovered shape combination in coverageReport.cells_over_time " +
          "     (a learned-topology-cell whose `reachable_unlearned` count is " +
          "     non-zero and not strictly decreasing across the windows).\n" +
          "  2. A vessel whose confidence is below the health floor in " +
          "     substrateHealthReport.health_verdict.below_floor.\n" +
          "  3. A resolver tier showing degraded latency/cost in either report.\n\n" +
          "Coverage progress gate:\n" +
          "  If coverageReport.body.coverage_progress is present and === true, you may " +
          "  STILL author a scenario but only if substrateHealthReport.health_verdict." +
          "overall_passing === false OR there is at least one below_floor vessel. The " +
          "absence of a gap is a valid output: emit {\"scenario\":null,\"reason\":\"<why>\"} " +
          "(no other fields) when nothing meets the bar.\n" +
          "  If coverage_progress is absent (older traces), INFER progress from the " +
          "  cell-count delta between cells_over_time[0] and cells_over_time[1]: " +
          "  reachable_learned strictly higher in [0] vs [1] = progress; else not.\n\n" +
          "Deduplication:\n" +
          "  The dedupe map below maps prior scenario ids to ISO timestamps. Skip any " +
          "  gap whose normalised signature ('<gap_kind>:<primary_identifier>', e.g. " +
          "  'uncovered_cell:activityExecutionTrace+goal_execution' or " +
          "  'below_floor_vessel:concept-db') matches a scenario whose timestamp is " +
          "  within the past {{dedupe_window_hours}} hours. The dedupe map's scenario " +
          "  ids embed the gap signature after the timestamp segment, so match by " +
          "  substring on the id rather than parsing a separate field.\n\n" +
          "Scenario id format (NON-NEGOTIABLE):\n" +
          "  ^fm-auto-[0-9]{10,13}-[a-z0-9]{6,8}$\n" +
          "  The middle segment is the current unix timestamp (whole seconds; do not " +
          "  invent — use the value of {{__now_unix_seconds}} which the surrounding " +
          "  resolver substitutes; if that variable is not substituted by your runtime, " +
          "  use the string '0000000000' so downstream sees the literal). The trailing " +
          "  hash segment is a short, stable hash of the gap signature (lowercase " +
          "  alphanumeric only; treat the first 6 chars of sha1(gap_signature) as the " +
          "  recipe — do this conceptually, you may write any 6-8 char [a-z0-9] string " +
          "  that is itself deterministic per gap signature).\n\n" +
          "Scenario JSON (REQUIRED fields, matching validation/failure-modes/schema.json):\n" +
          "  {\n" +
          "    \"id\": \"fm-auto-<ts>-<hash>\",\n" +
          "    \"mode_class\": \"fm\",\n" +
          "    \"stage\": one of pre_discovery|discovery|recommendation|binding|execution|validation|composition|learning,\n" +
          "    \"outcome_class\": \"FN\" or \"FP\" (FN is appropriate for coverage gaps; FP for health-floor / phantom-success-style gaps),\n" +
          "    \"information_state\": \"known_unknown\",\n" +
          "    \"title\": <≤120 char human title naming the observed gap>,\n" +
          "    \"description\": <2-4 sentences citing the exact report field that drove this authoring — coverageReport.cells_over_time[N].<field> or substrateHealthReport.health_verdict.<field> — followed by the substrate hypothesis for what activity would close the gap>,\n" +
          "    \"trigger\": { \"preconditions\": [<≥1 string>], \"synthetic_setup\": {} },\n" +
          "    \"goal_text\": <one natural-language sentence describing what the gap-closing activity should accomplish>,\n" +
          "    \"detection\": { \"signal\": <how the gap will be auto-detected on a subsequent measurement tick>, \"witness_required\": \"trace_only\" },\n" +
          "    \"expected_emergence\": {\n" +
          "      \"class\": \"new\",\n" +
          "      \"activity_signature\": {\n" +
          "        \"output_shapes_must_include\": [<the shape(s) the gap indicates are missing — list at least one>],\n" +
          "        \"tags_pattern\": \"substrate.auto.*\"\n" +
          "      }\n" +
          "    },\n" +
          "    \"self_heal_window_seconds\": 1800,\n" +
          "    \"metadata\": {\n" +
          "      \"priority\": \"medium\",\n" +
          "      \"cost_asymmetry\": \"symmetric\",\n" +
          "      \"authored_by\": \"observe-and-author-from-gaps\",\n" +
          "      \"observed_gap_signature\": <the same normalised signature used for dedupe>,\n" +
          "      \"source_coverage_trace_id\": <id of the coverage trace cited, or null>,\n" +
          "      \"source_health_trace_id\": <id of the health trace cited, or null>\n" +
          "    }\n" +
          "  }\n\n" +
          "Wrap the scenario in: {\"scenario\": <scenario>, \"reason\": \"<one-line rationale>\"}.\n" +
          "If no gap is observable (or all candidates are deduped), emit instead:\n" +
          "  {\"scenario\": null, \"reason\": \"<why nothing met the bar>\"}\n\n" +
          "Recent coverage traces JSON:\n{{read_recent_coverage_traces_content}}\n\n" +
          "Recent health traces JSON:\n{{read_recent_health_traces_content}}\n\n" +
          "Dedupe map (may be a fs_read error string if file absent — treat as empty):\n" +
          "{{read_dedupe_map_content}}",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 2000,
      },
      outputShapes: ["authoredScenarioCandidate"],
    },
    {
      id: "extract_scenario_id",
      description:
        "Deterministically pull scenario.id from the LLM output. Empty string when " +
        "scenario is null (no gap met the bar) — downstream fs_write fails fast on " +
        "an empty filename and dispatch_drafter no-ops on an empty scenario_id.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{extract_gap_and_author_scenario_content}}",
        path: "scenario.id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_scenario_body",
      description: "Pull the full scenario object for the fs_write step (preserves all fields).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{extract_gap_and_author_scenario_content}}",
        path: "scenario",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "write_scenario",
      description:
        "Persist the authored scenario as a normal harness input. The harness picks " +
        "fm-auto-* files up the same way it picks operator-authored fm-/fp-* files; " +
        "from this point on the gap is a first-class substrate citizen.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{scenarios_dir}}/{{extract_scenario_id_text}}.json",
        content: "{{extract_scenario_body_valueJson}}",
      },
      outputShapes: ["gapScenario"],
    },
    {
      id: "update_dedupe_map",
      description:
        "Best-effort append of <scenario_id>:<now-iso> into the dedupe map. The " +
        "next observe-and-author-from-gaps tick reads this map and skips matching " +
        "gap signatures within the window. We rewrite the whole file rather than " +
        "appending to keep the format JSON-parseable; concurrent writers from " +
        "back-to-back ticks can lose one another's writes, accepted trade-off " +
        "since the dedupe is itself best-effort.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{proposals_dir}}/_auto_dispatched.json",
        content:
          "{\"{{extract_scenario_id_text}}\":\"" +
          new Date(0).toISOString() +
          "\"}",
      },
      outputShapes: ["dedupeMapWritten"],
    },
    {
      id: "dispatch_drafter",
      description:
        "Hand the newly-authored scenario_id to draft-gap-closing-activity via " +
        "goal-host /run-goal. The drafter runs the full author → register → " +
        "variant chain; once a variant lands, boredom goal[9] exercises it for " +
        "Thompson evidence, and auto-promote graduates it. End-to-end: the " +
        "substrate observed its own gap and registered a closure for it.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "{{goal_host_endpoint}}/run-goal",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "draft a gap-closing activity from autonomously-authored scenario {{extract_scenario_id_text}}",
          targetTemplateId: "{{drafter_template_id}}",
          variables: {
            scenarios_dir: "{{scenarios_dir}}",
            scenario_id: "{{extract_scenario_id_text}}",
            report_path: "{{report_path}}",
            proposals_dir: "{{proposals_dir}}",
            source: "observe-and-author-from-gaps",
          },
        }),
        timeoutMs: 10000,
      },
      outputShapes: ["healthGapDispatch"],
    },
  ],
};
