import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

const PROMPT_TEMPLATE = `You are authoring a new openspec change for a self-improving activity system.

Your input has three parts: (1) a batch of substrateGap impulses sharing a gap_class,
(2) prior concepts that explain the parent pattern and downstream rules, and (3) two
markdown exemplars showing the in-tree skeleton of an openspec change.

## Gap batch — substrateGap impulses

These are real drift signals the substrate has minted. Cite at least two of them by
concept id in the proposal's References section. Treat them as the EVIDENCE the
proposal addresses.

{{read_gaps_content}}

## Prior concepts — parent rules + downstream patterns

Cite the most relevant prior concepts inline in the Motivation so the reader can
trace the conceptual lineage of the proposed fix.

{{read_priors_content}}

## Exemplar — openspec proposal.md skeleton

{{read_exemplar_proposal_content}}

## Exemplar — openspec tasks.md skeleton

{{read_exemplar_tasks_content}}

## Requirements

1. Produce ONE JSON object with EXACTLY these three top-level keys:
     { "slug": "<kebab-case-slug>", "proposal_md": "<full proposal markdown>", "tasks_md": "<full tasks markdown>" }
   Output ONLY this JSON. No markdown fences, no prose before or after.

2. The "slug" must be kebab-case, 4-6 words, descriptive of the fix
   (e.g. "concept-db-impulse-wrapper-parse" or "llm-resolver-normalize-handler").

3. The "proposal_md" must include these headings in order:
   # <date> — <Human Title>
   ## Motivation
   ## Proposal
   ## Out of Scope
   ## Success Criteria
   ## References
   - Motivation: 2-4 paragraphs naming the gap_class and citing at least
     two substrateGap concept ids from the input.
   - Proposal: concrete, minimal, single-vessel-or-fewer scope. Name the
     files to edit and the rough shape of the patch.
   - Out of Scope: enumerate adjacent work this proposal does NOT do.
   - Success Criteria: 3-5 numbered, verifiable bullets.
   - References: at least the cited concept ids and the relevant openspec
     change path that produced the substrateGap impulses.

4. The "tasks_md" must include sections like:
   # Tasks — <slug>
   ## DEV-1: <step>
   ## DEV-2: <step>
   ## Per-DEV-step regression check
   ## Stop-doing-this signal
   With unchecked checkboxes under each DEV-N section.

5. Do not fabricate concept ids. Only cite ids that appear in the gap
   batch or prior concepts above. If you can't find at least two cited
   ids, return { "slug": "INSUFFICIENT_EVIDENCE", "proposal_md": "...", "tasks_md": "..." }.

Respond with the JSON object only.`;

export const DRAFT_SPEC_FROM_GAP_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:draft-spec-from-gap",
  name: "draft-spec-from-gap",
  description:
    "Read N substrateGap impulses sharing a gap_class from concept-db, plus the " +
    "cited fix_priors and two openspec change exemplars, draft a coherent openspec " +
    "change (proposal.md + tasks.md) via llm_completion_dispatch, and write both " +
    "files to openspec/changes/<date>-substrate-authored-<slug>/. Operator reviews " +
    "the resulting directory; this template does not commit.",
  inputShapes: ["substrateGapBatch", "openspecExemplar"],
  outputShapes: ["specProposal"],
  tags: [
    "lift.autonomous.loop",
    "substrate.authored.openspec",
    "spec.drafting",
  ],
  variables: [
    {
      name: "gap_class",
      description:
        "Shared gap_class to filter substrateGap impulses by (e.g. 'resolve_contract_partial_parse').",
    },
    {
      name: "fix_priors_query",
      description:
        "Natural-language query to find prior concepts citing parent rules + downstream patterns.",
    },
    {
      name: "max_gaps",
      description: "Max substrateGap impulses to load (default 5).",
    },
    {
      name: "date",
      description:
        "YYYY-MM-DD date prefix for the change directory; should be today's date.",
    },
  ],
  tasks: [
    {
      id: "read_gaps",
      description:
        "Load N substrateGap impulses from concept-db matching the gap_class.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8260/concepts/search?source_type=substrate_gap&query={{gap_class}}&limit={{max_gaps}}",
        method: "GET",
        timeoutMs: 5000,
      },
      outputShapes: ["substrateGapBatch"],
    },
    {
      id: "read_priors",
      description:
        "Load prior concepts citing parent rules + downstream patterns. " +
        "These give the LLM the conceptual lineage to reference.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8260/concepts/search?query={{fix_priors_query}}&limit=5",
        method: "GET",
        timeoutMs: 5000,
      },
      outputShapes: ["substratePriorConcepts"],
    },
    {
      id: "read_exemplar_proposal",
      description:
        "Load a real openspec proposal.md as a structural exemplar so the " +
        "drafter matches the in-tree skeleton (Motivation / Proposal / Out of " +
        "Scope / Success Criteria / References).",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/workspace/openspec/changes/2026-05-22-failure-mode-autonomous-loop/proposal.md",
      },
      outputShapes: ["openspecProposalExemplar"],
    },
    {
      id: "read_exemplar_tasks",
      description: "Load the paired tasks.md exemplar.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/workspace/openspec/changes/2026-05-22-failure-mode-autonomous-loop/tasks.md",
      },
      outputShapes: ["openspecTasksExemplar"],
    },
    {
      id: "draft_via_llm",
      description:
        "Dispatch to a discovered llm_completion vessel to draft a JSON bundle " +
        "{ slug, proposal_md, tasks_md } from gaps + priors + exemplars.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON with no surrounding text.",
        prompt: PROMPT_TEMPLATE,
        model: "anthropic/claude-haiku-4-5-20251001",
      },
      outputShapes: ["draftedSpecBundle"],
    },
    {
      id: "extract_slug",
      description:
        "Deterministically extract slug from the drafted JSON bundle so the " +
        "downstream fs_write paths can reference it.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{draft_via_llm_text}}",
        path: "slug",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_proposal_md",
      description: "Extract proposal_md body from the drafted JSON bundle.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{draft_via_llm_text}}",
        path: "proposal_md",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_tasks_md",
      description: "Extract tasks_md body from the drafted JSON bundle.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{draft_via_llm_text}}",
        path: "tasks_md",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "write_proposal",
      description:
        "Persist the drafted proposal.md to openspec/changes/<date>-substrate-authored-<slug>/. " +
        "Subject to WRITE_ALLOWLIST scoping (substrate-mode allows openspec/changes/).",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "/workspace/openspec/changes/{{date}}-substrate-authored-{{extract_slug_text}}/proposal.md",
        content: "{{extract_proposal_md_text}}",
        createDirs: true,
      },
      outputShapes: ["specProposal"],
    },
    {
      id: "write_tasks",
      description: "Persist the drafted tasks.md alongside the proposal.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "/workspace/openspec/changes/{{date}}-substrate-authored-{{extract_slug_text}}/tasks.md",
        content: "{{extract_tasks_md_text}}",
        createDirs: true,
      },
      outputShapes: ["specProposal"],
    },
    {
      id: "draft_substrate_learning",
      description:
        "STRUCTURED LEARNING side-effect (G2 fix, 2026-05-30). Extract a substrate " +
        "concept describing WHY this gap_class needed an openspec change. Future " +
        "spec-from-gap runs read these concepts as priors instead of re-deriving " +
        "the lineage from scratch.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a precise JSON generator. Output only valid JSON with no surrounding text.",
        prompt:
          "You just authored an openspec change for gap_class '{{gap_class}}'. Now " +
          "record what you LEARNED about why this gap_class persists, so future spec " +
          "drafter runs inherit your reasoning.\n\n" +
          "## Gap batch you saw\n{{read_gaps_content}}\n\n" +
          "## Prior concepts you saw\n{{read_priors_content}}\n\n" +
          "## Required output schema\n" +
          '{ "shape": "<snake_case_shape, e.g. spec_gap_lineage or openspec_authoring_pattern>",\n' +
          '  "summary": "<one-line gist <=120 chars>",\n' +
          '  "content": "<2-4 sentences citing gap_class and any prior concept ids>" }\n\n' +
          "If trivial, return\n" +
          '{ "shape": "trivial_gap", "summary": "no substrate learning", "content": "trivial gap_class; no pattern worth recording" }.\n' +
          "Output ONLY valid JSON.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 500,
      },
      outputShapes: ["substrateLearningDraft"],
    },
    {
      id: "extract_learning_shape",
      description: "Extract shape from substrate learning JSON.",
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
      description: "Extract summary from substrate learning JSON.",
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
      description: "Extract content from substrate learning JSON.",
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
        "drafted substrate learning. Makes the autonomous palette grant of " +
        "concept_create_write actually load-bearing.",
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
                path: "/workspace/openspec/changes/{{date}}-substrate-authored-{{extract_slug_text}}/proposal.md",
                section: "substrate_learning",
              },
            },
          },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["substrateLearningConcept"],
    },
  ],
};
