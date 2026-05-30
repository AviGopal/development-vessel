import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * ingest-doc-as-concepts — mint concepts per H2/H3 section of a markdown doc.
 *
 * Two-phase execution to work around an iteration+lifecycle interaction that
 * caused mint_sections to never start when wired as a single template (see
 * smoke-test findings 2026-05-30):
 *
 *   Phase A (this template): read_doc → extract_sections (LLM → JSON array)
 *                          → write_sections (fs_write to /workspace).
 *   Phase B (separate dispatch, in script): script reads the file, POSTs each
 *                          section to concept-db /concepts.
 *
 * The LLM splits the doc on H2/H3 boundaries and emits an array of
 * concept-shaped JSON objects. These are persisted to a known workspace path.
 * A companion script (validation/scripts/ingest-doc-mint-from-file.ts) reads
 * the file and mints concepts.
 *
 * Why two phases: a single-template iteration-then-http_fetch chain reliably
 * stops after the LLM step (engine records only the first 2 tasks; the
 * iteration task neither runs nor errors visibly). Same template wired as
 * fs_read → llm → fs_write completes cleanly. Splitting the substrate-mint
 * step out keeps the autonomous-palette pattern intact while leaving the
 * iteration question as a separate debugging target.
 *
 * Idempotency: signature = <doc_path>__<heading_slug> is stamped into
 * metadata.signature on each concept. The companion script's mint step
 * pre-searches by signature and skips matches.
 *
 * Spec: openspec/changes/2026-05-30-doc-ingestion-and-concept-management/
 */

const EXTRACT_PROMPT = `You are extracting concepts from a markdown document.

Below is the raw markdown content of a documentation file. Split it on
H2 (##) and H3 (###) headings. For each section, emit ONE concept entry
describing the load-bearing idea in that section.

DOCUMENT PATH: {{doc_path}}

DOCUMENT CONTENT:
{{read_doc_content}}

Output ONLY a JSON array. No prose, no markdown fences. Each entry MUST
be a JSON object ready to POST to concept-db's /concepts endpoint:

  {
    "source_type": "extracted",
    "shape": "<one of: vessel_construction_pattern, architecture_principle, operations_runbook, code_pattern, troubleshooting_recipe, security_property, ontology_definition, deployment_procedure, doc_section>",
    "summary": "<one-sentence gist, max 150 chars>",
    "content": "<the section body, lightly cleaned, max 1200 chars>",
    "priority": 0.5,
    "budget": 2000,
    "metadata": {
      "signature": "<doc_path>__<heading_slug>",
      "doc_path": "<doc_path verbatim>",
      "heading": "<verbatim H2/H3 heading text without ## prefix>",
      "heading_slug": "<lowercased kebab-case of heading, max 60 chars>",
      "ingest_source": "ingest-doc-as-concepts"
    }
  }

Where <doc_path> is exactly: {{doc_path}}

Rules:
- Cap at 30 sections total. If the doc is longer, pick the 30 most
  load-bearing sections (those describing system invariants, architectural
  decisions, operational procedures). Skip sections that are pure
  cross-reference, anchor tags, or navigation.
- Skip H1 (single-#). Skip code-block-only sections.
- heading_slug MUST be unique within the array (used for idempotency).
- Pick the most specific shape from the enumerated list. "doc_section" is
  the fallback when nothing else fits.
- Escape all string values for valid JSON (quotes, backslashes, newlines).

Output the JSON array now, nothing else.`;

export const INGEST_DOC_AS_CONCEPTS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:ingest-doc-as-concepts",
  name: "ingest-doc-as-concepts",
  description:
    "Reads a markdown doc, asks the LLM to split it on H2/H3 boundaries, and " +
    "writes a JSON array of concept-shaped entries to a workspace file for a " +
    "companion script (ingest-doc-mint-from-file.ts) to mint into concept-db. " +
    "Two-phase because single-template iteration+lifecycle interaction stalls " +
    "after the LLM step; splitting keeps the autonomous-palette pattern intact.",
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
      id: "extract_sections",
      description:
        "Dispatch to LLM to split the doc on H2/H3 boundaries and emit one " +
        "structured concept entry per section. Cheap fast model — structural " +
        "extraction does not need a frontier model.",
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
