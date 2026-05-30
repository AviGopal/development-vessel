import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * ingest-doc-as-concepts — mint concepts per H2/H3 section of a markdown doc.
 *
 * History: prior versions of this template passed the WHOLE document body to
 * a single llm_completion_dispatch call, which overflowed Anthropic's 200K
 * prompt cap on large docs (CLAUDE.md ~ 211K tokens → 400 prompt too long).
 *
 * The fix: deterministically split the doc on H2/H3 headings FIRST, then
 * pass the JSON-stringified section array (with each body capped at 3000
 * chars and at most 60 sections) to the LLM. Worst case the LLM payload is
 * ~180KB ≈ 45K tokens — well under the 200K cap regardless of input doc
 * size.
 *
 * Two-phase execution is preserved:
 *
 *   Phase A (this template):
 *     read_doc → split_sections (deterministic, ≤3000 chars/section)
 *              → extract_sections (LLM walks the array, emits JSON array)
 *              → write_sections (fs_write to /workspace).
 *
 *   Phase B (separate dispatch, in script
 *   validation/scripts/ingest-doc-mint-from-file.ts):
 *     Reads the file written in step 4 and POSTs each section to
 *     concept-db /concepts with idempotency by `metadata.signature`.
 *
 * Why no per-section iteration: ias-executor-ts's activity-api-provider
 * adapter strips `inputShapes`/`outputShapes` from raw task definitions
 * during mapTask, which breaks the canonical iteration-by-shape-name
 * binding pattern. Until that adapter preserves the fields, a single
 * LLM call over the bounded section array is the simpler shape. Per-
 * section iteration can be re-introduced when the upstream adapter is
 * fixed (out of scope here; the user's directive is "don't touch
 * ias-executor-ts").
 *
 * Idempotency: signature = `<doc_path>__<heading_slug>` is stamped into
 * `metadata.signature` on each concept entry. The companion script's
 * mint step pre-searches by signature and skips matches.
 *
 * Spec: openspec/changes/2026-05-30-doc-ingestion-and-concept-management/
 */

const EXTRACT_PROMPT = `You are extracting concepts from a markdown document, ONE per section.

The document has been deterministically split on H2/H3 headings. Each
section's body is capped at 3000 chars. Walk the array below and emit
ONE concept entry per load-bearing section.

DOCUMENT PATH: {{doc_path}}

SECTIONS (JSON array; each entry is {heading, level, heading_slug, body_excerpt}):
{{split_sections_valueJson}}

Output ONLY a JSON array. No prose, no markdown fences. Each entry MUST
be a JSON object ready to POST to concept-db's /concepts endpoint:

  {
    "source_type": "extracted",
    "shape": "<specific noun-phrase shape; see RULES below>",
    "summary": "<one-sentence gist, ≤80 chars>",
    "content": "<the section body, lightly cleaned, ≤200 words, single line>",
    "priority": 0.5,
    "budget": 2000,
    "pointer": {"type": "memo", "path": "{{doc_path}}", "section": "<verbatim heading>"},
    "metadata": {
      "signature": "{{doc_path}}__<heading_slug>",
      "doc_path": "{{doc_path}}",
      "heading": "<verbatim heading>",
      "heading_slug": "<from input>",
      "ingest_source": "ingest-doc-as-concepts"
    }
  }

SKIP sections that are navigational scaffold (TOC, anchor tags, pure
cross-reference) or code-block-only. Don't emit an entry for those.
Cap at 30 entries total — if more sections look load-bearing than 30,
pick the most load-bearing ones (system invariants, architectural
decisions, operational procedures).

CONTENT DISCIPLINE — hard rules. Violations will be rejected downstream:

1. ONE ATOMIC IDEA per concept. If a section covers multiple mechanisms,
   pick THE most load-bearing one and ignore the rest. A concept covering
   more than one idea is wrong.

2. SUMMARY ≤ 80 CHARACTERS. Terse, identifies the concept; not a sentence
   retelling the body. "vessel_resolve_handler_dual_form" is good;
   "Overview of how vessels handle resolve" is not.

3. BODY ≤ 200 WORDS, ONE LINE (no raw newlines, no leaked XML such as
   "<content>...</content>"). If the source section is longer, SUMMARIZE.
   Do not paste paragraphs verbatim.

4. MANDATORY POINTER at TOP LEVEL (not under metadata) with exactly:
     "pointer": {"type": "memo", "path": "{{doc_path}}", "section": "<heading>"}

5. SPECIFIC SHAPE NAMES. shape must be a specific noun phrase, not a
   bucket. BANNED shape names — if the section's idea matches any of
   these, SKIP it (it's navigational scaffold):
     overview, related, key_files, mcp_tools, environment_variables,
     before_push, references, summary, introduction, section, notes,
     usage, examples, miscellaneous, table_of_contents, index, links.
   Good shapes look like: thompson_sampling_credit_propagation,
   sops_age_key_rotation_procedure, api_key_hmac_signature_format,
   impulse_resolver_tier_taxonomy, vessel_resolve_handler_dual_form.

6. heading_slug from each input entry MUST be reused verbatim in the
   signature and metadata.heading_slug — preserves idempotency.

7. ESCAPE for valid JSON (quotes, backslashes, newlines).

GOOD ENTRY:
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

BAD ENTRY (DO NOT EMIT — multi-idea, banned shape, verbose summary, leaked XML, missing pointer):
  {
    "source_type": "extracted",
    "shape": "overview",
    "summary": "An overview of Thompson and retry strategies for failed activities",
    "content": "<content>Thompson is used... and also we retry...</content>",
    "metadata": {"signature": "CLAUDE.md__overview"}
  }

Emit the JSON array now applying ALL rules. Nothing else.`;

export const INGEST_DOC_AS_CONCEPTS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:ingest-doc-as-concepts",
  name: "ingest-doc-as-concepts",
  description:
    "Reads a markdown doc, deterministically splits it on H2/H3 boundaries " +
    "(each section body capped at 3000 chars), and dispatches ONE LLM call " +
    "with the bounded section array as input. The LLM walks the array and " +
    "emits one concept entry per load-bearing section, writing the JSON " +
    "array to a workspace file for the companion script " +
    "(ingest-doc-mint-from-file.ts) to mint into concept-db. " +
    "Deterministic pre-split avoids the 200K-token prompt overflow that " +
    "single-LLM-pass extraction hits on large docs (CLAUDE.md, etc.) — " +
    "worst case LLM payload after splitting is ~45K tokens.",
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
        "3000 chars so the downstream single LLM call sees a bounded payload " +
        "regardless of input doc length. No LLM here — splitter is a registered " +
        "resolver (markdown_split_sections).",
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
      id: "extract_sections",
      description:
        "Dispatch a single LLM call with the JSON-stringified section array " +
        "as input. The LLM walks the array and emits one concept entry per " +
        "load-bearing section. Cheap haiku model — structural extraction " +
        "does not need a frontier model. Payload size is bounded by the " +
        "splitter's per-section cap × maxSections, NOT by the input doc.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt: EXTRACT_PROMPT,
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 8000,
      },
      outputShapes: ["llm_completion_dispatch"],
    },
    {
      id: "write_sections",
      description:
        "Persist the extracted JSON section array to a known workspace path. " +
        "Phase B (companion script ingest-doc-mint-from-file.ts) reads this " +
        "file and mints each entry to concept-db with idempotency by signature.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{out_path}}",
        content: "{{extract_sections_text}}",
      },
      outputShapes: ["draftedSectionArray"],
    },
  ],
};
