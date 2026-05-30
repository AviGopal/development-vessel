import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * ingest-doc-as-concepts — mint concepts per H2/H3 section of a markdown doc.
 *
 * History: prior versions of this template passed the WHOLE document body to
 * a single llm_completion_dispatch call, which overflowed Anthropic's 200K
 * prompt cap on large docs (CLAUDE.md ~ 211K tokens → 400 prompt too long).
 * The fix: split the doc deterministically on H2/H3 boundaries BEFORE the
 * LLM call so per-section payloads stay bounded.
 *
 * Two-phase execution stays intact:
 *
 *   Phase A (this template):
 *     read_doc → split_sections (deterministic, ≤3000 chars/section)
 *              → parse_sections (json_path_extract → sections array)
 *              → iter_extract (iteration: llm_completion_dispatch per section)
 *              → write_sections (fs_write the aggregated JSON-array).
 *
 *   Phase B (separate dispatch, in script
 *   validation/scripts/ingest-doc-mint-from-file.ts):
 *     Reads the file written in step 5 and POSTs each section to
 *     concept-db /concepts with idempotency by `metadata.signature`.
 *
 * Why deterministic splitting (not LLM): the LLM cannot split a doc it
 * can't fit in its context window. The substrate-side splitter (resolver
 * `markdown_split_sections`) chunks reliably regardless of doc length.
 *
 * Per-section LLM call: each section's body is ≤3000 chars (≈750 tokens),
 * plus a ~2KB system+rules envelope = well under any token budget.
 *
 * Idempotency: signature = `<doc_path>__<heading_slug>` is stamped into
 * `metadata.signature` on each concept. The companion script's mint step
 * pre-searches by signature and skips matches.
 *
 * Spec: openspec/changes/2026-05-30-doc-ingestion-and-concept-management/
 */

const EXTRACT_PROMPT = `You are extracting ONE concept from a single section of a markdown document.

DOCUMENT PATH: {{doc_path}}
SECTION HEADING: {{candidate.heading}}
SECTION HEADING SLUG: {{candidate.heading_slug}}
SECTION LEVEL (H{{candidate.level}}): {{candidate.level}}

SECTION BODY (truncated at 3000 chars):
{{candidate.body_excerpt}}

Output ONLY a single JSON object — no array, no prose, no markdown fences.
This object will be POSTed to concept-db's /concepts endpoint as-is:

  {
    "source_type": "extracted",
    "shape": "<specific noun-phrase shape; see RULES below>",
    "summary": "<one-sentence gist, ≤80 chars>",
    "content": "<the section body, lightly cleaned, ≤200 words, single line>",
    "priority": 0.5,
    "budget": 2000,
    "pointer": {"type": "memo", "path": "{{doc_path}}", "section": "{{candidate.heading}}"},
    "metadata": {
      "signature": "{{doc_path}}__{{candidate.heading_slug}}",
      "doc_path": "{{doc_path}}",
      "heading": "{{candidate.heading}}",
      "heading_slug": "{{candidate.heading_slug}}",
      "ingest_source": "ingest-doc-as-concepts"
    }
  }

If this section is navigational scaffold (TOC, cross-references, anchor
tags only), code-block-only, or otherwise NOT a load-bearing idea,
output instead:
  {"skip": true, "reason": "<one line>"}

CONTENT DISCIPLINE — hard rules. Violations will be rejected downstream:

1. ONE ATOMIC IDEA. If the section covers more than one mechanism,
   principle, or procedure, pick the MOST LOAD-BEARING one and ignore
   the rest. Do NOT combine. A concept covering more than one idea is wrong.

2. SUMMARY ≤ 80 CHARACTERS. Terse, identifies the concept; not a sentence
   retelling the body. "vessel_resolve_handler_dual_form" style is good;
   "Overview of how vessels handle resolve" is not.

3. BODY ≤ 200 WORDS, ONE LINE (no raw newlines, no leaked XML such as
   "<content>...</content>"). If the source section is longer, SUMMARIZE.
   Do not paste paragraphs verbatim.

4. MANDATORY POINTER. The pointer field MUST be at the TOP LEVEL (not
   under metadata) with exactly:
     "pointer": {"type": "memo", "path": "{{doc_path}}", "section": "{{candidate.heading}}"}

5. SPECIFIC SHAPE NAMES. shape must be a specific noun phrase, not a
   bucket. BANNED shape names — if the section's idea matches any of
   these, the section is navigational scaffold and you MUST emit
   {"skip": true, "reason": "banned-shape <name>"}:
     overview, related, key_files, mcp_tools, environment_variables,
     before_push, references, summary, introduction, section, notes,
     usage, examples, miscellaneous, table_of_contents, index, links.
   Good shapes look like: thompson_sampling_credit_propagation,
   sops_age_key_rotation_procedure, api_key_hmac_signature_format,
   impulse_resolver_tier_taxonomy, vessel_resolve_handler_dual_form.

6. ESCAPE for valid JSON (quotes, backslashes, newlines).

GOOD EXAMPLE OUTPUT:
  {
    "source_type": "extracted",
    "shape": "thompson_sampling_alpha_beta_attribution",
    "summary": "Thompson posterior credits both variant and dispatched template on failure",
    "content": "When a variant fails, the directly-executed variant AND any dispatched-via-meta-trace template both receive beta updates, preventing failure-attribution drift relative to success attribution.",
    "priority": 0.5,
    "budget": 2000,
    "pointer": {"type": "memo", "path": "CLAUDE.md", "section": "Thompson Sampling"},
    "metadata": {
      "signature": "CLAUDE.md__thompson-sampling",
      "doc_path": "CLAUDE.md",
      "heading": "Thompson Sampling",
      "heading_slug": "thompson-sampling",
      "ingest_source": "ingest-doc-as-concepts"
    }
  }

BAD EXAMPLE (DO NOT EMIT — multi-idea, banned shape, verbose summary, leaked XML, missing pointer):
  {
    "source_type": "extracted",
    "shape": "overview",
    "summary": "An overview of Thompson and retry strategies for failed activities",
    "content": "<content>Thompson is used... and also we retry...</content>",
    "metadata": {"signature": "CLAUDE.md__overview"}
  }

Emit the JSON object now applying ALL six rules above. Nothing else.`;

export const INGEST_DOC_AS_CONCEPTS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:ingest-doc-as-concepts",
  name: "ingest-doc-as-concepts",
  description:
    "Reads a markdown doc, splits it deterministically on H2/H3 boundaries " +
    "(each section body capped at 3000 chars), and dispatches a per-section " +
    "LLM call to extract one concept entry per load-bearing section. Writes " +
    "the aggregated JSON-array to a workspace file for the companion script " +
    "(ingest-doc-mint-from-file.ts) to mint into concept-db. " +
    "Deterministic pre-split avoids the 200K-token prompt overflow that " +
    "single-LLM-pass extraction hits on large docs (CLAUDE.md, etc.).",
  inputShapes: [],
  outputShapes: ["draftedSectionArray"],
  tags: [
    "lift.autonomous.loop",
    "concept.ingest",
    "doc.ingest",
    "substrate.knowledge.accumulation",
  ],
  variables: [
    {
      name: "doc_path",
      description:
        "Path to the markdown document to ingest. Substrate-readable " +
        "(host repo is mounted read-only at the same path inside the container).",
    },
    {
      name: "out_path",
      description:
        "Where to write the extracted JSON section array. Defaults to " +
        "/workspace/concept-ingest/sections-latest.json if unset.",
    },
  ],
  tasks: [
    {
      id: "read_doc",
      description: "Load the markdown document.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{doc_path}}",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "split_sections",
      description:
        "Deterministic split on H2/H3 headings. Each section body capped at " +
        "3000 chars so the downstream per-section LLM call stays well under " +
        "any token budget. No LLM here — splitter is a registered resolver.",
      resolver: "markdown_split_sections",
      config: {
        type: "markdown_split_sections",
        content: "{{read_doc_content}}",
        doc_path: "{{doc_path}}",
        maxSectionChars: 3000,
        maxSections: 60,
      },
      outputShapes: ["markdownSections"],
    },
    {
      id: "parse_sections",
      description:
        "Pluck the sections array out of the splitter result so iteration can " +
        "consume it as `over`.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{split_sections_valueJson}}",
        path: "sections",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "iter_extract",
      description:
        "Iterate per-section. Each iteration dispatches llm_completion_dispatch " +
        "with JUST that section's heading + body (≤3000 chars). The LLM emits " +
        "ONE concept JSON object per section (or {skip:true} for scaffold). " +
        "Aggregated as a list of text outputs.",
      resolver: "iteration",
      config: {
        over: "{{parse_sections_valueJson}}",
        elementVar: "candidate",
        indexVar: "i",
        maxIterations: 60,
        stopOnError: false,
        aggregateAs: "list",
        outputShape: "draftedSectionArray",
        body: {
          resolver: "llm_completion_dispatch",
          config: {
            type: "llm_completion_dispatch",
            prompt: EXTRACT_PROMPT,
            model: "anthropic/claude-haiku-4-5-20251001",
            max_tokens: 1500,
          },
        },
      },
      outputShapes: ["draftedSectionArray"],
    },
    {
      id: "write_sections",
      description:
        "Persist the aggregated array of per-section LLM outputs to a known " +
        "workspace path. Phase B (companion script ingest-doc-mint-from-file.ts) " +
        "reads this file, parses each entry, filters {skip:true}, and mints each " +
        "concept with idempotency by signature.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{out_path}}",
        content: "{{iter_extract_valueJson}}",
      },
      outputShapes: ["draftedSectionArray"],
    },
  ],
};
