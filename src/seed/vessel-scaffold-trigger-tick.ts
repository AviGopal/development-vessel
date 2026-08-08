import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * vessel-scaffold-trigger-tick — the Loop-C dual of drafter-trigger-tick.
 *
 * THE GAP IT CLOSES (SUBSTRATE_AS_MDP §8.6, Loop C / vessel-addition):
 * `gap-to-scenario-bridge` already classifies `missing_capability` gaps and
 * routes them into `validation/failure-modes/vessel-scenarios/<id>.json`,
 * tagged `routing_class:"vessel_authoring"` + `target_template_id =
 * development-vessel:scaffold-and-publish-vessel`. But NOTHING deterministically
 * consumes that queue — the only consumer was the LLM-reuse boredom goal
 * (index.ts:~220), which Thompson can misroute. The bridge makes the routing
 * DECISION; this tick makes the routing DISPATCH. After this lands, a capability
 * horizon the recombination drafter structurally cannot close (§8.5: "no vessel
 * advertises shape X") drains into an actual vessel-scaffold PR.
 *
 * WHY IT MIRRORS drafter-trigger-tick (V18) BUT NEEDS ONE LLM TASK:
 * drafter-trigger-tick can be pure deterministic plumbing because its target
 * (draft-gap-closing-activity) is itself the LLM that designs from a scenario_id
 * + paths. scaffold-and-publish-vessel is the opposite — a DETERMINISTIC 7-file
 * git composition that needs ~15 pre-computed variables (clean lowercase
 * vesselName from a camelCase shape, port, advertised shapes, PR text). Deriving
 * a vessel IDENTITY + design from a capability demand is a genuine reasoning
 * step, so — exactly like enact-orthogonal-decisions — this tick reads
 * deterministically, runs ONE constrained llm_completion_dispatch to synthesize
 * the design, json_path_extracts each field, then dispatches. The LLM layer is
 * dispatched via an activity (per development-vessel CLAUDE.md three-layer
 * discipline), never inlined in vessel TS.
 *
 * SAFETY: scaffold-and-publish-vessel terminates in a PR against `dev`, not a
 * live deploy. Imperfect derived values (port collisions, naming) are caught at
 * PR review (evaluate-pr-via-internal-idioms). The dispatch is therefore safe to
 * run autonomously — the substrate proposes a vessel; the merge gate disposes.
 *
 * CHAIN AFTER THIS TICK FIRES:
 *   gap-to-scenario-bridge writes vessel-scenarios/<gap>.json (capability gap)
 *   → THIS TICK picks it, designs the vessel, dispatches scaffold-and-publish-vessel
 *   → scaffold writes 7 files + branch + commit + push + PR (substrate-authored/…)
 *   → evaluate-pr-via-internal-idioms gates the merge
 *   → the new vessel adds (ΔS, ΔA, ΔR) to the action space (§8.1 monotone capacity)
 *
 * WIRING (NOT done in this draft — deliberate, see notes):
 *   1. Export + push into SEED_TEMPLATES in src/seed/index.ts (mechanical).
 *   2. OPTIONAL boredom goal slot. NOTE: a name ending in `-tick` is auto-routed
 *      to light-dispatch (:8280) by boredom's isLightDispatchEligible regex.
 *      Light-dispatch DOES run LLM activities (it runs draft-gap-closing-activity
 *      today), so the `-tick` suffix is fine. Adding the goal increases
 *      autonomous LLM spend — left to the operator per the cost-control runbook.
 *   No resolver code is added — this is compose-only (all five resolvers exist).
 */

const DESIGN_VESSEL_PROMPT = `You are the substrate's vessel-design synthesizer. You are given ONE capability-gap scenario that the gap-to-scenario-bridge routed for vessel authoring. Design the smallest vessel that supplies the demanded capability shape, and output its scaffold parameters as STRICT JSON.

## The capability-gap scenario

{{read_scenario_content}}

## What you are designing

scaffold-and-publish-vessel will write a 7-file canonical vessel (package.json, tsconfig, src/config.ts, src/routes/impulses.ts, src/index.ts, src/discovery-registration.ts, systemd unit), open a branch, commit, push, and open a PR against dev. You supply the identity + design; the file contents are templated by scaffold-and-publish-vessel. The vessel will advertise exactly the demanded capability shape(s) and resolve them via /v2/impulses/resolve.

## Derivation rules

- **vessel_name**: a clean, npm-valid package name fragment — ASCII LOWERCASE letters, digits, and single hyphens only; MUST end in "-vessel"; <= 40 chars. Derive from the scenario's \`capability_shape\` by kebab-casing it and appending a role word + "-vessel". Examples: capability_shape "priceQuoteResult" -> "price-quote-vessel"; "creditRiskScore" -> "credit-risk-vessel"; "weatherForecast" -> "weather-forecast-vessel". NEVER emit camelCase or uppercase here (package.json names must be lowercase).
- **port**: a free HTTP port as a STRING in the 8300-8399 band (the substrate's substrate-authored-vessel range; 82xx is taken by the seed fleet). Pick deterministically from the shape (e.g. a stable hash mod 100 + 8300). Collisions are caught at PR review, so a best-effort pick is fine.
- **advertised_shapes_literal**: a STRING containing a TypeScript array literal of the advertised shapes — normally just the demanded capability shape. Example: "[\\"priceQuoteResult\\"]". MUST be valid JSON-string-escaped so it survives transport.
- **description**: one line, <= 100 chars. State what capability the vessel supplies and which/how-many templates demanded it (use demanding_template_count if present).
- **commit_message**: conventional-commit form, e.g. "feat(<vessel_name>): scaffold vessel supplying <capability_shape> (substrate-authored from <source_gap_id>)". Cite the source gap id.
- **pr_title**: short, e.g. "substrate-authored: scaffold <vessel_name> for <capability_shape>".
- **pr_body**: 2-4 sentences. State the demanded shape, the demanding template count, and that this closes a §8.5 capability horizon the recombination drafter cannot close. The body MUST contain a literal line starting with "Substrate-Authored-By:" (scaffold-and-publish-vessel's gh_pr_create REFUSES PRs without it). End with "Substrate-Authored-By: vessel-scaffold-trigger-tick".

## Output contract — output ONLY this JSON object, no prose, no markdown
{
  "vessel_name": "<vessel_name>",
  "port": "<port>",
  "advertised_shapes_literal": "[\\"<capability_shape>\\"]",
  "description": "<description>",
  "commit_message": "feat(<vessel_name>): scaffold vessel supplying <capability_shape> (substrate-authored from <source_gap_id>)",
  "pr_title": "substrate-authored: scaffold <vessel_name> for <capability_shape>",
  "pr_body": "Demanded shape: <capability_shape>. This closes a §8.5 capability horizon the recombination drafter cannot close. Substrate-Authored-By: vessel-scaffold-trigger-tick"
} fences

{
  "vessel_name": "...",
  "port": "...",
  "advertised_shapes_literal": "[\\"...\\"]",
  "description": "...",
  "commit_message": "...",
  "pr_title": "...",
  "pr_body": "...Substrate-Authored-By: vessel-scaffold-trigger-tick",
  "derivation_notes": "1 sentence: which capability_shape drove the name + port, and the demanding_template_count you read."
}`;

export const VESSEL_SCAFFOLD_TRIGGER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:vessel-scaffold-trigger-tick",
  name: "vessel-scaffold-trigger-tick",
  description:
    "Loop-C dispatch closer (SUBSTRATE_AS_MDP §8.6): picks the oldest vessel-authoring " +
    "scenario from validation/failure-modes/vessel-scenarios/, synthesizes a vessel design " +
    "from the demanded capability shape via one constrained LLM task, and dispatches " +
    "scaffold-and-publish-vessel with the derived variables. Closes the gap where " +
    "gap-to-scenario-bridge routes missing_capability gaps to a queue that nothing " +
    "deterministically consumed. Dual of drafter-trigger-tick. Idempotent: a scaffolded " +
    "vessel's PR is the dedup point; re-picking the same scenario re-opens the same branch " +
    "(git_branch_create refuses the duplicate). Compose-only — adds no resolver code.",
  inputShapes: ["directoryListing", "fileContent"],
  outputShapes: ["vesselScaffoldDispatchResult"],
  tags: [
    "lift.autonomous.loop",
    "vessel.addition",
    "capability.horizon",
    "boredom_target_template",
    "producer-chain.bridge",
    "intent:scaffold",
  ],
  variables: [],
  tasks: [
    {
      id: "list_vessel_scenarios",
      description:
        "Enumerate vessel-authoring scenario JSON files written by gap-to-scenario-bridge. " +
        "Shuffle so the pick rotates across queued capability gaps rather than always " +
        "returning the alphabetic-first id (mirrors drafter-trigger-tick V26).",
      resolver: "fs_list",
      config: {
        type: "fs_list",
        path: "/workspace/validation/failure-modes/vessel-scenarios",
        glob: "*.json",
        max_depth: 0,
        shuffle: true,
      },
      outputShapes: ["directoryListing"],
    },
    {
      id: "extract_scenario_name",
      description:
        "Extract entries[0].name — the chosen vessel-authoring scenario filename. " +
        "If the queue is empty this resolves to empty and the design/dispatch tasks " +
        "no-op into a normal trace (β+=1 is fine — informative that there is no demand).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{list_vessel_scenarios_content}}",
        path: "entries.0.name",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "read_scenario",
      description:
        "Load the chosen vessel-authoring scenario JSON. Carries capability_shape, " +
        "demanding_template_count, sample_template_ids, title, source_gap_id — the inputs " +
        "the design step reasons over.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/workspace/validation/failure-modes/vessel-scenarios/{{extract_scenario_name_text}}",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "design_vessel",
      description:
        "Synthesize the vessel design (clean lowercase name, port, advertised shapes, " +
        "PR text) from the capability gap. ONE constrained LLM task — the only reasoning " +
        "step. Output is strict JSON whose fields the json_path_extract tasks read to " +
        "build the scaffold dispatch. Haiku tier (cheap); design from a single scenario " +
        "is not a hard reasoning task.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON with no surrounding text, no markdown fences, no prose.",
        prompt: DESIGN_VESSEL_PROMPT,
        model: "auto",
        max_tokens: 1200,
      },
      outputShapes: ["vesselScaffoldDesign"],
    },
    {
      id: "extract_vessel_name",
      description: "Pull vessel_name (lowercase, ends -vessel). Used as name + path stem.",
      resolver: "json_path_extract",
      config: { type: "json_path_extract", json: "{{design_vessel_content}}", path: "vessel_name" },
              validation: { requiredPatterns: ["-vessel"] },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_port",
      description: "Pull port (string in 8300-8399).",
      resolver: "json_path_extract",
      config: { type: "json_path_extract", json: "{{design_vessel_content}}", path: "port" },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_advertised_shapes",
      description:
        "Pull advertised_shapes_literal — a STRING holding a TS array literal. Injected as a " +
        "JSON string value below; scaffold-and-publish-vessel interpolates it into config.ts " +
        "as the DISCOVERY_SHAPES literal.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{design_vessel_content}}",
        path: "advertised_shapes_literal",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_description",
      description: "Pull description (one line).",
      resolver: "json_path_extract",
      config: { type: "json_path_extract", json: "{{design_vessel_content}}", path: "description" },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_commit_message",
      description: "Pull commit_message (cites source_gap_id).",
      resolver: "json_path_extract",
      config: { type: "json_path_extract", json: "{{design_vessel_content}}", path: "commit_message" },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_pr_title",
      description: "Pull pr_title.",
      resolver: "json_path_extract",
      config: { type: "json_path_extract", json: "{{design_vessel_content}}", path: "pr_title" },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_pr_body",
      description: "Pull pr_body (MUST contain the Substrate-Authored-By: trailer).",
      resolver: "json_path_extract",
      config: { type: "json_path_extract", json: "{{design_vessel_content}}", path: "pr_body" },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "dispatch_scaffold",
      description:
        "Dispatch scaffold-and-publish-vessel via goal-host /run-goal (async; returns a " +
        "dispatchId). cwd-derived paths (dirPath, unitDirPath, unitFilePath) are interpolated " +
        "from the derived vessel_name so the LLM doesn't have to compute them. owner/repo/cwd/" +
        "base_branch are the operator-tunable substrate-clone knobs (defaults below assume the " +
        "in-container /workspace clone of metabob-devbob). target_branch uses the " +
        "substrate-authored/ prefix the git_push + git_branch_create resolvers require.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "ApiKey ${METABOB_API_KEY}",
        },
        body: JSON.stringify({
          goal:
            "scaffold + publish vessel {{extract_vessel_name_text}} supplying capability shape from a routed vessel-authoring gap",
          targetTemplateId: "development-vessel:scaffold-and-publish-vessel",
          variables: {
            cwd: "/workspace",
            vesselName: "{{extract_vessel_name_text}}",
            dirPath: "/workspace/repos/{{extract_vessel_name_text}}",
            unitDirPath: "/workspace/scripts/substrate/units",
            unitFilePath: "/workspace/scripts/substrate/units/{{extract_vessel_name_text}}.service",
            advertisedShapes: "{{extract_advertised_shapes_text}}",
            description: "{{extract_description_text}}",
            port: "{{extract_port_text}}",
            target_branch: "substrate-authored/{{extract_vessel_name_text}}-scaffold",
            base_branch: "dev",
            commit_message: "{{extract_commit_message_text}}",
            owner: "metabob",
            repo: "metabob-devbob",
            pr_title: "{{extract_pr_title_text}}",
            pr_body: "{{extract_pr_body_text}}",
            source: "vessel-scaffold-trigger-tick",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["vesselScaffoldDispatchResult"],
    },
  ],
};
