// NOTE: TASK 3 (analyze) requires that the LLM emit a JSON object whose required_code_modifications[]
// entries each have a `file` field starting with `repos/` — apply-proposal-as-patch derives the target
// vessel from that prefix via deriveVesselFromPath(). Proposals lacking this field are skipped with
// reason="no_required_code_modifications".

// Schema reminder for future audits: drafter MUST emit the FLAT canonical schema
// that sanitizeProposalForPatcher (apply-proposal-as-patch.ts) actually reads —
// kind + summary + required_code_modifications[].{file,description}. No dynamic
// top-level key, no wrapper object. Canonical schema example:
// { kind: 'patch_proposal', summary: '<one-line>', required_code_modifications: [{ file: 'repos/<vessel>/src/<file>.ts', description: '<what changes + why>' }] }
// V37 (2026-06-12): removed the dynamic `<output_shape_name>` key from the emitted
// schema. That variable key was the root cause of the autoDraftedOutput_* wrapping
// (V14) and required_modifications.primary_target nesting (V13) the resolver had to
// tolerate — the LLM read "emit a key named <shape>" as "wrap everything under <shape>".
// The registered variant's outputShapes are set deterministically downstream via
// output_shapes_override, so the proposal JSON never needed to carry the shape name.
//

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

## Prior Failed Attempts (LEARN from these — do NOT repeat)

The system has attempted to close this gap before. The JSON report below lists prior
proposals that were drafted but did NOT land (e.g. they targeted a non-existent file,
or a symbol that is imported-not-declared so the patcher made no edit). Read its
'summary_text' field. If a prior approach targeted the wrong or non-existent file,
choose a DIFFERENT, REAL target file this time — do not re-emit a known-failing approach.

{{fetch_prior_failures_text}}

## Prior Successful Attempts (REUSE these winning shapes)

The system has also LANDED proposals before. The JSON report below lists prior
approaches that actually staged/landed — on this exact gap or on a SIMILAR trace
(another vessel/activity with a shared error class). Read its 'summary_text' field.
If a similar approach already LANDED, prefer the SAME shape here on the analogous
target — name the real existing file and the same kind of minimal anchored edit. If a
fix for THIS exact gap already landed, verify the current state before re-drafting
(it may already be resolved).

{{fetch_prior_successes_text}}

## Requirements for the drafted template

## Authoritative Target File (concrete-defect gaps)

If the value below is non-empty, the scenario already names the EXACT file that must
be edited (e.g. a typecheck/compile error carries its own file:line). In that case your
required_code_modifications[0].file MUST equal this value VERBATIM — do NOT pick a
different vessel or file, do NOT re-derive it. Describe the minimal change to THAT file.
If it is empty, fall back to choosing the most likely file yourself.

TARGET_FILE: {{extract_target_file_text}}

TARGET_FILE CURRENT CONTENTS (verbatim — the file you must edit):
{{read_target_file_text}}

MANDATORY for a concrete-defect gap: in required_code_modifications[0] include an "anchor" field whose value is a short UNIQUE substring copied character-for-character from the contents above (the exact existing line/condition/symbol you will edit). Do NOT paraphrase it — the downstream patcher fs_edits this anchor literally; prose with no quotable anchor is skipped.

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
11. outputShapes MUST be exactly ["patch_proposal"]. Your template's analyze task emits a patch_proposal — that is its honest output. Do NOT declare the scenario's expected_emergence output shape; the gap is closed downstream by apply-proposal-as-patch converting your patch_proposal into a source patch, not by this template claiming to render the gap shape directly.

### STRUCTURED LEARNING (mandatory side-effect — knowledge dies otherwise)

Drafting a template is the primary output. The substrate also needs you to
RECORD what you learned about WHY this gap exists, so the next drafter run
inherits your reasoning. Autonomous-authoring templates that don't mint
side-effect concepts let knowledge die at execution boundaries — every
future LLM hop has to re-derive the same insight from scratch.

This is separate from the template JSON above; a separate dispatch task
will ask you for a short JSON object with the schema:
  { "shape": "<snake_case_shape_name>",
    "summary": "<one-line gist (<= 120 chars)>",
    "content": "<2-4 sentence explanation citing the scenario_id and the
                substrate concept ids that informed your draft>" }
If the gap is trivial and there is no substantive pattern worth recording,
return: { "shape": "trivial_gap", "summary": "no substrate learning", "content": "trivial" }
NEVER return null or empty — always emit a valid object.

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
    "prompt": "Scenario: {{read_scenario_content}}\n\nRecent traces: {{fetch_traces_content}}\n\nAnalyze the failure mode described in the scenario against the recent traces, then produce a JSON proposal report with this EXACT schema (no other top-level keys):\n{\n  \"kind\": \"patch_proposal\",\n  \"summary\": \"<one-line analysis summary>\",\n  \"required_code_modifications\": [\n    {\n      \"file\": \"<relative-path-from-repo-root, e.g. repos/<vessel>/src/<file>.ts>\",\n      \"description\": \"<what changes and why>\"\n    }\n  ]\n}\n\nCONCRETE EXAMPLE (this is exactly the shape you must emit — replace strings with content specific to this scenario):\n{\n  \"kind\": \"patch_proposal\",\n  \"summary\": \"Resolver returns success:true with shape:structuredError, masking failure\",\n  \"required_code_modifications\": [\n    {\n      \"file\": \"repos/development-vessel/src/routes/impulses.ts\",\n      \"description\": \"In the resolveDispatch HTTP envelope, when result.shape === 'structuredError', return success:false instead of success:true\"\n    }\n  ]\n}\n\nDO NOT emit these alternative shapes (they will be rejected): gap_analysis, recommendation, evidence_from_traces, implementation_sketch, next_action, or any wrapper object like autoDraftedOutput_*. The TOP-LEVEL object you return MUST have exactly these three FIXED keys: kind, summary, required_code_modifications. 'summary' is a literal key named exactly \"summary\" — NOT the scenario's output shape name. Do NOT wrap this object under any dynamic or scenario-named key (e.g. autoDraftedOutput_*), and do NOT nest the target under required_modifications.primary_target — those forms force lossy downstream unwrapping and are rejected by the patcher. The required_code_modifications array MUST be present and non-empty for the downstream apply_proposal_as_patch resolver to convert this proposal into a staged source patch. The top-level 'kind' field MUST be the string \"patch_proposal\" — apply_proposal_as_patch uses it to distinguish patch proposals from legacy analytic reports (V4 discriminator, 2026-06-06). List the ONE specific file most likely to need editing to close this gap; do NOT list multiple files unless the gap genuinely spans them. SURGICAL SCOPE RULE (mandatory): the description MUST name a CONCRETE, MINIMAL edit to EXISTING code — a specific function, symbol, condition, or line — and state the exact change (add an early return, add a guard or null-check, change a comparison, add a field, fix a returned flag, etc.). Include at least one concrete code anchor: a backticked identifier, an explicit return/replace/rename, or an operator such as ===. Do NOT propose building a new subsystem, framework, pipeline, model, engine, predictor, or other new infrastructure — the downstream patcher applies ONE minimal anchored edit and will SKIP any feature-sized, anchor-less proposal (reason non_surgical_proposal). If the gap genuinely needs a large feature, propose ONLY the smallest first increment that is itself a concrete surgical edit. CRITICAL: every file path MUST start with the literal prefix 'repos/' followed by a real vessel name followed by '/src/' or another subdirectory — for example 'repos/development-vessel/src/resolvers/foo.ts' or 'repos/ias-executor-ts/src/engine.ts'. A bare path like 'impulses.ts' or 'src/foo.ts' will be REJECTED with 'cannot derive vessel from path'. The vessels available in this substrate (ALL self-editable) are: activity-api, analysis-vessel, boredom-vessel, concept-db, cpg-inference-ts, development-vessel, discovery-vessel, goal-host-vessel, ias-executor-ts, identity-vessel, light-dispatch-vessel, llm-resolver-vessel, local-tools-vessel, metric-collector-vessel, obsidian-vessel, ribosome-vessel, stateful-ui-vessel. Pick the vessel whose code is most likely to need the change based on the scenario, and use that vessel name in the path. If unsure, pick development-vessel as the default since it hosts the substrate's meta-cognition.",
    "model": "anthropic/claude-haiku-4-5-20251001",
    "max_tokens": 1500
  }
  The proposal's "summary" key is a FIXED literal — do NOT rename it to the scenario's output shape. The registered variant's outputShapes are set deterministically downstream to ["patch_proposal"] via output_shapes_override (its honest output); the proposal JSON does not carry them.

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
  // No template-level inputShapes: tasks 1-2 use fs_read to load the report
  // and scenario from disk paths supplied via variables. Declaring these as
  // pool-seeded inputs triggered F25 precondition-rejection (concept_pFSLV6s5s3lQ)
  // for the same reason as drain-pending-substrate-gaps — the autonomous
  // dispatch path can't seed `failureModeReport` or `gapScenario` impulses,
  // and the F25 filter at activity-api /recommend would skip the template.
  // The fs_read-from-variable-paths pattern is the actual data flow.
  inputShapes: [],
  outputShapes: ["activityTemplateProposal", "activityTemplateVariant"],
  // NOT a boredom_target_template (removed 2026-07-31). The V17 rationale
  // (tag it so boredom fires it on its own cadence) was WRONG: this drafter
  // REQUIRES report_path + scenario_id + dir variables, which boredom cannot
  // seed — a direct boredom dispatch runs with empty vars, so task read_report
  // does fs_read on the literal "{{report_path}}" and fails 100% (measured
  // 4,546 failed/0 success over 7d; 1,432 failed since 07-30). The correct
  // boredom entry point is development-vessel:drafter-trigger-tick (V18), which
  // has ZERO vars and dispatches THIS drafter via pick_priority_scenario with
  // the concrete variable values filled in (pick-priority-scenario.ts
  // dispatchDrafter). So the drafter must ONLY be reached WITH vars, never as a
  // bare boredom target.
  tags: [
    "lift.autonomous.loop",
    "validation.failure.modes",
    "gap.closing",
  ],
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
      id: "extract_target_file",
      description:
        "Deterministically extract the scenario target_file (concrete-defect gaps such " +
        "as typecheck errors carry the exact repos/<vessel>/... path). Pinning it bypasses " +
        "the LLM re-guessing the vessel/file — the dominant cause of file_path_hallucination " +
        "rejections that starve the funnel. Empty for gaps without a known location.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_scenario_content}}",
        path: "target_file",
        fallback_path: "target_file_paths.0",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "read_target_file",
      description:
        "Read the verbatim current contents of the scenario's target_file so the drafter " +
        "can quote an EXACT anchor substring into required_code_modifications[0]. Without " +
        "the file in the prompt the LLM paraphrases lines that don't exist and the " +
        "downstream patcher's fs_edit no-ops (patch_failed/patch_noop). Failure is " +
        "non-fatal — if target_file is empty or unreadable the drafter falls back to " +
        "prose-only mode.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{extract_target_file_text}}",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "prime_substrate_concepts",
      description:
        "Query concept-db for the substrate's accumulated concepts ranked by Bayesian " +
        "relevance. All source_types are eligible — bridge-auto-minted impulse_signatures, " +
        "memos, vessel_construction_patterns, impulse_activity_patterns, " +
        "architectural_pattern_principles, extracted codebase patterns, and human_input " +
        "operator corrections compete on the same relevance axis. The drafted template's " +
        "LLM call uses the top-ranked concepts as priors. Failure is non-fatal — " +
        "concept-db being empty or unreachable just means the LLM drafts without the " +
        "substrate's memory as context. " +
        "2026-06-04: source_type whitelist removed entirely. The prior whitelist was a " +
        "special case that encoded which categories of knowledge the drafter would see; " +
        "Bayesian relevance + the LLM's own filtering are sufficient and avoid pinning " +
        "the substrate's vocabulary to an enumerated allow-list.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8260/concepts/search?min_relevance=0.3&limit=15",
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
      id: "fetch_prior_failures",
      description:
        "Learn from FAILED prior proposals (2026-06-18): query dev-vessel prior_failed_attempts " +
        "for this scenario so the draft below avoids repeating approaches that did not land — " +
        "wrong/non-existent target file, imported-not-declared symbol, etc. Non-fatal.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8090/v2/impulses/resolve",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "prior_failed_attempts",
              scenario_id: "{{scenario_id}}",
              proposals_dir: "{{proposals_dir}}",
            },
          },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["priorFailedAttempts"],
    },
    {
      id: "fetch_prior_successes",
      description:
        "Learn from LANDED prior proposals (2026-06-18): query dev-vessel prior_successful_attempts "
        + "for this scenario so the draft below REUSES winning shapes that already staged/landed — "
        + "on this exact gap or on a similar trace (shared error class, other vessel). Symmetric to "
        + "fetch_prior_failures. Non-fatal.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8090/v2/impulses/resolve",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "prior_successful_attempts",
              scenario_id: "{{scenario_id}}",
              proposals_dir: "{{proposals_dir}}",
            },
          },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["priorSuccessfulAttempts"],
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
        model: "auto",
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
      id: "write_proposal_draft",
      description:
        "Mirror the raw drafted-template text to a .draft.txt sibling for human " +
        "audit. Kept OUT of the JSON envelope on purpose: the raw LLM output " +
        "carries markdown fences, newlines, and unescaped quotes that cannot be " +
        "embedded inside a JSON string without a JSON-escaping interpolation form " +
        "(the engine has none — {{x_valueJson}} is a misnomer identical to " +
        "{{x_text}}). The canonical, parsed template is persisted to activity-api " +
        "by register_variant; this .txt is the verbatim copy.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{proposals_dir}}/proposal-{{scenario_id}}.draft.txt",
        content: "{{draft_via_llm_text}}",
      },
      outputShapes: ["fileWriteResult"],
    },
    {
      id: "write_proposal",
      description:
        "Persist a strictly-VALID-JSON provenance envelope for the drafted " +
        "proposal. Only {{scenario_id}} (a filesystem-safe slug) is interpolated, " +
        "so the emitted file always parses. The prior revision embedded " +
        "{{draft_via_llm_text}} inside a JSON string slot, which made 100% of " +
        "proposal-*.json files unparseable — a ghost-success where fs_write " +
        "reported success while writing invalid JSON. The verbatim template lives " +
        "in the .draft.txt sibling; the canonical one is registered in activity-api.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{proposals_dir}}/proposal-{{scenario_id}}.json",
        content: JSON.stringify({
          proposal: {
            scenario_id: "{{scenario_id}}",
            authored_by: "make_activity_autonomous",
            registration_status: "draft",
          },
          template_artifact: "proposal-{{scenario_id}}.draft.txt",
        }),
      },
      outputShapes: ["activityTemplateProposal"],
    },
    {
      id: "register_variant",
      description:
        "Register the drafted template as a candidate variant in activity-api, " +
        "declaring its HONEST output shape: patch_proposal. V25 forces this variant's " +
        "analyze task to emit patch_proposal, so the variant IS a patch-proposing " +
        "activity — not a renderer of the gap's expected shape. Stamping the gap shape " +
        "here (the old {{extract_required_shapes}} override) made declared≠produced, so " +
        "the reachability gate rejected the variant and β-penalized this whole draft even " +
        "though its real product (the proposal file) succeeded (SUBSTRATE_AS_MDP §5 / " +
        "showcase-autonomous-authoring fix 4). The gap shape is closed by the downstream " +
        "apply-proposal-as-patch → source-patch chain, not by this variant's label.",
      resolver: "activity_create_variant",
      config: {
        type: "activity_create_variant",
        template: "{{draft_via_llm_text}}",
        output_shapes_override: "[\"patch_proposal\"]",
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
        strict: "auto",
        auto_strict_threshold: 10,
      },
      outputShapes: ["convergentValidityResult"],
    },
    {
      id: "draft_substrate_learning",
      description:
        "STRUCTURED LEARNING side-effect (G2 fix, 2026-05-30). Dispatch a second " +
        "llm_completion to extract a substrate concept from the same scenario + " +
        "concept-db priors that informed the template draft. Output is a JSON object " +
        "{ shape, summary, content } that gets minted into concept-db so the next " +
        "drafter run inherits this reasoning rather than re-deriving it.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON with no surrounding text.",
        prompt:
          "You just drafted a gap-closing template for the scenario below. Now record " +
          "what you LEARNED about why this gap exists, so future drafter runs inherit " +
          "your reasoning. Cite the scenario_id and (if relevant) prior substrate concept " +
          "ids you used.\n\n" +
          "## Scenario\n{{read_scenario_content}}\n\n" +
          "## Substrate concept priors you saw\n{{prime_substrate_concepts_text}}\n\n" +
          "## Required output schema\n" +
          '{ "shape": "<snake_case_shape, e.g. gap_closure_pattern or missing_resolver_pattern>",\n' +
          '  "summary": "<one-line gist <=120 chars>",\n' +
          '  "content": "<2-4 sentences citing scenario_id and any prior concept ids>" }\n\n' +
          "If the gap is trivial and no substantive pattern was found, return\n" +
          '{ "shape": "trivial_gap", "summary": "no substrate learning", "content": "trivial scenario; no pattern worth recording" }.\n' +
          "NEVER return null or empty. Output ONLY valid JSON.",
        model: "auto",
        max_tokens: 500,
      },
      outputShapes: ["substrateLearningDraft"],
    },
    {
      id: "extract_learning_shape",
      description:
        "Extract the shape field from the substrate learning JSON so concept-db " +
        "receives a top-level shape string.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{draft_substrate_learning_text}}",
        path: "shape",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_learning_summary",
      description: "Extract the summary field from the substrate learning JSON.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{draft_substrate_learning_text}}",
        path: "summary",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_learning_content",
      description: "Extract the content field from the substrate learning JSON.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{draft_substrate_learning_text}}",
        path: "content",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "mint_substrate_learning_concept",
      description:
        "G2 fix (2026-05-30): POST concept_create_write to concept-db with the " +
        "drafted substrate learning. Source_type=extracted because this concept is " +
        "trace-derived (from the scenario + priors that informed the drafter). " +
        "Deterministic side-effect — the autonomous palette grant of concept_create_write " +
        "is meaningless unless templates actually CALL it.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8260/v2/impulses/resolve",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "concept_create_write",
            conceptData: {
              shape: "{{extract_learning_shape_text}}",
              source_type: "extracted",
              summary: "{{extract_learning_summary_text}}",
              content: "{{extract_learning_content_text}}",
              priority: 0.5,
              budget: 2000,
              pointer: {
                type: "memo",
                path: "/workspace/proposals/proposal-{{scenario_id}}.json",
                section: "substrate_learning",
              },
            },
          },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["substrateLearningConcept"],
    },
    {
      id: "credit_primed_concepts",
      description:
        "FIX for the one-sided relevance signal (2026-06-13): the drafter primed " +
        "the top concepts (recording LOADS only); reaching this terminal task means " +
        "the draft+register chain succeeded, so credit those same primed concepts " +
        "with outcome=success via concept-db's own usage endpoint. Makes concept " +
        "relevance two-sided so it stops decaying with use. First-hand outcome " +
        "reporting, read+written from concept-db — not re-derived.",
      resolver: "credit_primed_concepts",
      config: {
        type: "credit_primed_concepts",
        minRelevance: 0.3,
        limit: 15,
        outcome: "success",
        // Thread the ACTUAL primed set (2026-07-03): credit exactly the ids the
        // prime step returned, instead of re-querying the (possibly shifted)
        // ranking at terminal time.
        primedJson: "{{prime_substrate_concepts_text}}",
      },
      outputShapes: ["conceptCreditResult"],
    },
  ],
};
