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

== PATTERN CLUSTER ==
{{prime_concepts_text}}

== PRUNED RESOLVER + ACTIVITY VOCABULARIES ==
{{prune_vocabulary_text}}

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
  inputShapes: ["recurringPatternCluster"],
  outputShapes: ["authoredActivityCandidate", "activityTemplateVariant"],
  tags: [
    "substrate.authored.drafter",
    "obsidian.meta.skill.phase2",
    "permissive.scope.authoring",
  ],
  variables: [
    {
      name: "pattern_cluster_id",
      description: "Id of the recurringPatternCluster to author against",
    },
    {
      name: "workspace_root",
      description: "Workspace root for write paths",
    },
  ],
  tasks: [
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
        "explicit citations. These become the cited_concept_ids candidates for the drafted template.",
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
          "Pattern cluster: {{prime_concepts_text}}\n\nFull vocabulary: {{prime_vocabulary_text}}\n\n" +
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
      },
      outputShapes: ["comprehensibilityScore"],
    },
  ],
};
