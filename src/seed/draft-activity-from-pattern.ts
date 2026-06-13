import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * draft-activity-from-pattern — Phase 2 of the obsidian meta-skill prototype.
 *
 * Input: a hand-built or auto-detected `recurringPatternCluster` describing a
 * topology of resolvers and shapes that recurs across recent traces.
 * Output: an `authoredActivityCandidate` — an arbitrary-structure activity
 * template carrying declared shapes, citations, composition rationales, and
 * provenance markers.
 *
 * The drafter is iterative: a prune-vocabulary step precedes the draft step so
 * the LLM operates on a focused subset of the resolver + activity vocabularies
 * rather than the full ~30-resolver / ~100-template surface. Concept priors
 * are pulled from concept-db. Output goes through activity_create_variant
 * (which fires the 6 permissive-scope invariants) and convergent_validity_check
 * + comprehensibility_check before promotion.
 *
 * This is the substrate's general drafter — distinct from
 * `draft-gap-closing-activity` (the scenario-driven analytical drafter for
 * failure-mode gaps). They coexist; this one authors arbitrary topologies
 * from observed pattern clusters.
 */

const PROMPT_AUTHORING_DISCIPLINE = `
You are authoring an activity template for a self-improving substrate. The
five comprehensibility-discipline rules MUST be satisfied or your output will
be refused by the registration-time invariants.

RULE 1 — Self-describing names. Template id, shape names, and task ids must
be readable English-like identifiers, not single characters and not
unprintable. Use snake_case or camelCase. The regex rejects single-character
or unprintable names; ≥2 chars and printable is the floor.

RULE 2 — Substantive descriptions. Every task MUST carry a description ≥40
characters. The description states what the task does and why this resolver
was chosen. "TODO" / "TBD" / empty / a duplicate of the task id is refused.

RULE 3 — Citations to concept_ids. When the source pattern carries
n_concept_citations_available > 0, the template body MUST cite at least one
concept_id from concept-db in cited_concept_ids. Citations anchor the
authoring decision to an existing substrate concept.

Worked example — service_oom_cascade_scan cites concept_RYl73llSCGfc and
concept_6RwK5H5F28hT, the two concepts that name the seven-iteration-
unresolved OOM cascade bug class it detects. Without those citations the
detector reads as a generic process monitor.

RULE 4 — Composition rationales. Every compose-dispatch task carries a
composition_rationale entry of the form:
  { task_id: "<id>", rationale_class: "essential" | "replaceable" | "accidental",
    rationale_text: "<why this sub-activity, not another>" }
"essential" = this exact sub-activity is required by the pattern's contract.
"replaceable" = any activity producing the same output_shapes will do.
"accidental" = chosen for convenience; could be inlined.

RULE 5 — Provenance markers. The template MUST carry an authored_from_pattern
object: { pattern_id: "<cluster id>", observation_window: "<ISO range>",
contrast_examples: <count> }. The contrast count documents how many negative
examples the cluster supplied so a future reviewer can recompute the
discriminating power.

WORKED EXAMPLE — A pattern cluster matching "open file → make small edit →
save" with contrast examples of "open file → save unchanged" would author:

{
  "id": "proposed_pattern_authored_small_edit_save",
  "name": "small_edit_save",
  "description": "Performs a targeted in-place edit then persists the result. Authored from cluster small_edit_v2 with 4 contrast examples of unchanged-save behaviour.",
  "tags": ["substrate.authored", "edit.cycle"],
  "inputShapes": ["fileContent"],
  "outputShapes": ["fileContent", "editAuditLog"],
  "max_composition_depth": 2,
  "authored_from_pattern": { "pattern_id": "small_edit_v2", "observation_window": "2026-05-25/2026-05-30", "contrast_examples": 4 },
  "cited_concept_ids": ["concept_edit_save_minimal", "concept_in_place_replace"],
  "tasks": [...]
}

Now author one for the pattern cluster you are given.
`;

const DRAFT_PROMPT = `You are the substrate's general activity drafter (Phase 2).

You will be given:
  - A recurringPatternCluster describing a recurrent topology.
  - A pruned resolver vocabulary (only the resolvers relevant to this pattern).
  - A pruned activity vocabulary (only the activities relevant to this pattern).
  - Concept priors from concept-db.

${PROMPT_AUTHORING_DISCIPLINE}

== PATTERN CLUSTER (author a REAL resolver chain that performs this topology) ==
{{load_cluster_content}}

This cluster is the actual recurrent topology observed in traces. Your job is
NOT to describe or analyse it — it is to COMPOSE a reusable activity whose tasks
are real resolver calls that PERFORM the work the cluster recurs over. Each task
must name a concrete resolver (fs_read, fs_write, http_fetch, llm_completion_dispatch,
json_path_extract, compose, or any resolver listed in the pruned vocabulary below)
and declare the outputShapes it produces, so that executing the registered template
actually yields the cluster's output shapes. Do NOT author a read→analyse→write
meta-activity that merely emits a description; author the chain that does the thing.

== CONCEPT PRIORS (from concept-db; cite the relevant ones) ==
{{prime_concepts_text}}

== PRUNED RESOLVER + ACTIVITY VOCABULARIES ==
{{prune_vocabulary_text}}

== REQUIRED RESOLVER CONFIG CONTRACTS (an authored chain only closes the gap if it EXECUTES — use these exact field names) ==

Each task is { "id", "description" (>=40 chars), "resolver", "config", "outputShapes": [...] }.
Use ONLY these resolvers and these exact config shapes:

- fs_read:   { "type": "fs_read", "path": "<ABSOLUTE path under /workspace>" }
- fs_write:  { "type": "fs_write", "path": "/workspace/<dir>/<file>", "content": "<string>" }
- http_fetch GET:  { "type": "http_fetch", "url": "http://127.0.0.1:<port>/...", "method": "GET" }
- http_fetch POST: { "type": "http_fetch", "url": "http://127.0.0.1:<port>/...", "method": "POST", "headers": { "Content-Type": "application/json" }, "body": "<JSON string>" }
  The field is "url" (NOT "uri"). "body" is a JSON STRING, not an object. There is no "body_template".
- llm_completion_dispatch: { "type": "llm_completion_dispatch", "prompt": "<text, may reference {{<prior_task_id>_text}}>", "model": "anthropic/claude-haiku-4-5-20251001", "max_tokens": 1000 }
  model MUST be a substrate model id (anthropic/claude-haiku-4-5-20251001). Never "gpt-4-turbo" or other non-substrate ids. No "temperature" field.
- json_path_extract: { "type": "json_path_extract", "json": "{{<prior_task_id>_text}}", "path": "<dotted.path>" }

Cross-task data flows through {{<prior_task_id>_text}} interpolation (the raw text output of an earlier task). There is no {{shape.field}} addressing — to use a field from a prior JSON output, either json_path_extract it into its own task first, or pass the whole {{<task>_text}} into the next prompt.

CRITICAL — embedding a prior task's output inside a JSON "body" string: raw text contains quotes and newlines that BREAK the JSON body when placed inside quotes. Do NOT write "content": "{{classify_text}}". Instead use the {{<task>_json}} form, which expands to an already-quoted, escaped JSON string literal — place it WITHOUT surrounding quotes:
  "body": "{\\"pointer\\":{\\"type\\":\\"concept_create_write\\",\\"conceptData\\":{\\"shape\\":\\"<snake>\\",\\"source_type\\":\\"extracted\\",\\"summary\\":\\"<short literal>\\",\\"content\\":{{classify_orphaned_shapes_json}},\\"priority\\":0.5,\\"budget\\":2000}}}"
Note "content":{{..._json}} has NO quotes around the token (the _json form supplies them). Keep "summary" a short literal you write yourself (no interpolation) so the body stays valid even if an upstream task returned nothing.

Substrate write endpoints (use http_fetch POST with a JSON-string body of EXACTLY this shape):
- concept_create_write → http://127.0.0.1:8260/v2/impulses/resolve
  body (stringified): {"pointer":{"type":"concept_create_write","conceptData":{"shape":"<snake_case>","source_type":"extracted","summary":"<text>","content":"<text>","priority":0.5,"budget":2000}}}
- substrateGap_write → http://127.0.0.1:8270/v2/impulses/resolve
- activity-api reads (traces, templates, distribution) → http://127.0.0.1:8080/...

The LAST task MUST produce the cluster's output shape so executing the template yields it.

Output ONLY a single JSON object matching the ActivityTemplate shape. No
markdown fences, no surrounding prose. The id MUST begin with
"proposed_pattern_authored_". The authored_from_pattern.pattern_id MUST
match the cluster's id verbatim. Every compose-dispatch task MUST have an
entry in composition_rationales.`;

export const DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:draft-activity-from-pattern",
  name: "draft-activity-from-pattern",
  description:
    "Permissive-scope general drafter (Phase 2 of obsidian meta-skill). Given a " +
    "recurringPatternCluster, an actionEffectModel, the resolver vocabulary, and the " +
    "activity vocabulary, drafts an arbitrary-topology activity template with declared " +
    "shapes, cited_concept_ids, per-compose-task composition_rationales, and an " +
    "authored_from_pattern provenance marker. Iterative two-step: prune vocabulary first, " +
    "then draft. Comprehensibility-discipline rules are enforced in the prompt body " +
    "and re-checked at registration via the 6 permissive-scope invariants on " +
    "activity_create_variant, then by convergent_validity_check and comprehensibility_check. " +
    "Companion to draft-gap-closing-activity (the scenario-driven analytical drafter); " +
    "they coexist orthogonally.",
  // No template-level inputShapes: the cluster is loaded by the load_cluster
  // fs_read task from the path the feeder (detect-recurring-pattern) wrote.
  // Declaring recurringPatternCluster as a pool-seeded input triggered the same
  // F25 precondition-rejection the gap drafter hit — recurringPatternCluster is
  // not in KNOWN_SEEDABLE_SHAPES, so the autonomous /recommend filter skipped
  // this template entirely. The fs_read-from-variable-path is the real dataflow,
  // and it lets boredom Thompson rotation select the drafter (not just the
  // feeder's direct targetTemplateId dispatch).
  inputShapes: [],
  outputShapes: ["authoredActivityCandidate", "activityTemplateVariant"],
  tags: [
    "substrate.authored.drafter",
    "obsidian.meta.skill.phase2",
    "permissive.scope.authoring",
    // NOT tagged boredom_target_template (deliberately). This author needs a
    // recurringPatternCluster file on disk (load_cluster). Blind Thompson
    // selection with no cluster present would fail at load_cluster and pollute
    // the autonomous loop with β-penalised failures. The correct autonomy path is
    // the feeder: detect-recurring-pattern produces a cluster AND dispatches this
    // author via its dispatch_drafter task (passing pattern_id + patterns_dir).
    // Full self-driving requires (a) detect-recurring-pattern in boredom rotation
    // with a live, non-obsidian cluster source, and (b) the engine {{taskId_json}}
    // body-interpolation wire-through (ias-executor 0febd4d) so authored chains
    // mint cleanly. Until both land, this author is feeder-/operator-dispatched.
  ],
  variables: [
    // Aligned with the variables detect-recurring-pattern's dispatch_drafter
    // actually sends (pattern_id + patterns_dir). The prior pattern_cluster_id /
    // workspace_root names never matched the feeder, so the drafter was dispatched
    // but could not locate its cluster — a silent mis-wire that left this author
    // with zero live output.
    {
      name: "pattern_id",
      description: "Id of the recurringPatternCluster to author against (matches the cluster file stem written by detect-recurring-pattern)",
    },
    {
      name: "patterns_dir",
      description: "Directory holding the cluster JSON files. Default /workspace/patterns.",
      default: "/workspace/patterns",
    },
  ],
  tasks: [
    {
      id: "load_cluster",
      description:
        "Read the recurringPatternCluster JSON the feeder (detect-recurring-pattern) " +
        "persisted at {{patterns_dir}}/{{pattern_id}}.json. This is the concrete " +
        "topology — signature, member traces, contrast examples — the template is " +
        "authored FROM. Without this load the drafter would author blind against " +
        "generic concept-db results (the silent bug that left this author dead).",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{patterns_dir}}/{{pattern_id}}.json",
      },
      outputShapes: ["recurringPatternCluster"],
    },
    {
      id: "prime_vocabulary",
      description:
        "Fetch the current resolver vocabulary (from concept-db's source_type=resolver concepts) " +
        "and the activity vocabulary (from activity-api's /v2/activities/templates) so the " +
        "drafter has the full menu before pruning.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8080/v2/activities/templates?limit=200",
        method: "GET",
        timeoutMs: 5000,
      },
      outputShapes: ["activityVocabulary"],
    },
    {
      id: "prime_concepts",
      description:
        "Pull concept-db's accumulated concepts ranked by relevance plus the pattern cluster's " +
        "explicit citations. All source_types are eligible — Bayesian relevance gates inclusion, " +
        "not an enumerated allow-list. These become the cited_concept_ids candidates for the " +
        "drafted template. 2026-06-04: source_type whitelist removed; see openspec change " +
        "2026-06-04-drop-drafter-source-type-filter for rationale.",
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
      id: "prune_vocabulary",
      description:
        "Ask the LLM to select the subset of resolvers and activities relevant to the pattern cluster's " +
        "topology. The pruned output keeps the downstream draft step inside Anthropic's context budget " +
        "and improves selection quality by removing distractors.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise vocabulary pruner. Output JSON with two keys: resolvers (string array) " +
          "and activities (string array). Include only entries that materially help draft an activity " +
          "for the given pattern cluster.",
        prompt:
          "Pattern cluster (the recurrent topology to author for): {{load_cluster_content}}\n\n" +
          "Concept priors (for context only): {{prime_concepts_text}}\n\n" +
          "Full vocabulary: {{prime_vocabulary_text}}\n\n" +
          "Return the pruned subset as JSON.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 1500,
      },
      outputShapes: ["resolverVocabulary"],
    },
    {
      id: "draft_via_llm",
      description:
        "Author the activity template body via the substrate's LLM resolver. The prompt encodes " +
        "the five comprehensibility-discipline rules (self-describing names, substantive descriptions, " +
        "citations, composition rationales, provenance markers) with one worked example for each. " +
        "Output is a single JSON object; downstream tasks validate and register it.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only a single valid JSON object — no markdown " +
          "fences, no surrounding text. Honour all five comprehensibility-discipline rules or the " +
          "registration-time invariants will refuse your output.",
        prompt: DRAFT_PROMPT,
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 4096,
      },
      outputShapes: ["draftedTemplate"],
    },
    {
      id: "extract_topology",
      description:
        "Deterministically extract the task list from the drafted JSON so a downstream review " +
        "step can iterate over tasks without re-parsing the full template body.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{draft_via_llm_text}}",
        path: "tasks",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "register_variant",
      description:
        "Register the drafted template via activity_create_variant. The 6 permissive-scope " +
        "invariants fire here — max_composition_depth, inputShape producers, no circular compose, " +
        "task description discipline, output_shape coverage by tasks, and authored_from_pattern " +
        "metadata presence — refusing the variant with verifier_negative.activity_registration_invariant " +
        "on the first violation. Survives → activityRegistryChange.",
      resolver: "activity_create_variant",
      config: {
        type: "activity_create_variant",
        template: "{{draft_via_llm_text}}",
        validate_permissive_scope: true,
      },
      outputShapes: ["activityTemplateVariant"],
    },
    {
      id: "verify_outputs",
      description:
        "Convergent-validity check on the registered template's declared outputs. Pulls " +
        "concept-db co-occurrence edges and confirms the produced shape set matches the substrate's " +
        "learned priors. Warns (does not fail) when concept-db evidence is thin so the substrate " +
        "remains permissive while learning, and sharpens automatically as edges accumulate.",
      resolver: "convergent_validity_check",
      config: {
        type: "convergent_validity_check",
        produced_shapes: ["authoredActivityCandidate"],
        strict: "auto",
        auto_strict_threshold: 10,
      },
      outputShapes: ["convergentValidityResult"],
    },
    {
      id: "comprehensibility_gate",
      description:
        "Final gate before promotion. A second-provider LLM is given the template body without " +
        "its self-description and asked what it does, why it might have been authored, and what " +
        "would have to be true for it to be useful. The answers are scored against the template's " +
        "own description; below the configured floor the template is refused and a " +
        "verifier_negative.comprehensibility_below_floor impulse is emitted. Above-floor passes " +
        "are queued for downstream verification.",
      resolver: "comprehensibility_check",
      config: {
        type: "comprehensibility_check",
        template_json: "{{draft_via_llm_text}}",
        model: "anthropic/claude-haiku-4-5-20251001",
        // floor is calibrated to the CURRENT similarity metric (Jaccard token
        // overlap), not to a semantic-cosine scale. A blind-LLM paraphrase vs a
        // keyword-y self-description tops out around 0.3 by token overlap even for
        // a perfectly clear template, so the resolver's 0.6 default rejected 100%
        // of real authored chains (the v3 live drive scored 0.164 on a coherent
        // chain). 0.12 sits in the discriminating gap: coherent reconstructions
        // land ~0.15–0.30, while a template the blind LLM cannot explain scores
        // ~0. UPGRADE PATH: when an embedding endpoint is exposed (the substrate
        // already ships all-MiniLM-L6-v2 in activity-api), switch the resolver's
        // similarity to cosine and raise this floor back toward 0.6.
        floor: 0.12,
      },
      outputShapes: ["comprehensibilityScore"],
    },
  ],
};
