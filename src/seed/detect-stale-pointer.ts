import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-stale-pointer — smallest management template in Family 2.
 *
 * Reads concepts from concept-db and, for each one with a metadata.doc_path
 * (or pointer-style path), checks whether the file still exists on disk.
 * Concepts whose source has disappeared emit a substrateGap of category
 * "missing_concept" (the substrateGap resolver enum doesn't have a
 * dedicated "stale_concept_pointer" category — missing_concept with a
 * descriptive summary and classification_metadata is the closest fit).
 *
 * Why no per-concept fs_read fan-out: a single LLM-dispatched scan over
 * the concept list is simpler than 200+ deterministic fs_read iterations
 * for the first cut. The pattern can switch to iteration+fs_read once the
 * substrate has more concepts with explicit pointer paths.
 *
 * Spec: openspec/changes/2026-05-30-doc-ingestion-and-concept-management/
 */

const SCAN_PROMPT = `You are auditing concepts for stale source-pointer references.

Below is a list of concepts from concept-db. Each concept has metadata that
MAY contain a 'doc_path' (set by ingest-doc-as-concepts) or a pointer with
a 'path' field. Your task: list the concepts whose source path looks like
it would no longer resolve, plus the reasoning.

You do NOT have direct filesystem access here. Use these heuristics:
  - paths containing 'TODO', 'TEMP', 'tmp', or that look like throwaway
  - paths under archived directories like 'archive/', 'deprecated/', 'old/'
  - paths that mention versions or dates that look stale
  - paths to files inside other vessels' archived dirs

When uncertain, INCLUDE the concept — false positives are cheap (the
gap-drain loop will dispatch the drafter which will fail fast); false
negatives are silent rot.

CONCEPTS:
{{search_concepts_content}}

Output ONLY a JSON array. No prose, no markdown fences. Each entry:

  {
    "concept_id": "<id>",
    "suspected_path": "<the path from metadata or pointer>",
    "reason": "<one-line reasoning>"
  }

Cap at 10 entries. If nothing looks stale, output [].`;

export const DETECT_STALE_POINTER_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-stale-pointer",
  name: "detect-stale-pointer",
  description:
    "Scans concept-db for concepts whose source path appears stale (archived, " +
    "deprecated, throwaway). Per stale concept, emits a substrateGap impulse " +
    "of category 'missing_concept' so the gap-drain loop picks it up. " +
    "Smallest management template in Family 2 — uses a heuristic LLM scan " +
    "rather than per-concept fs_read fan-out for the first cut.",
  inputShapes: [],
  outputShapes: ["substrateGap", "stalePointerReport"],
  tags: [
    "lift.autonomous.loop",
    "concept.management",
    "substrate.knowledge.curation",
  ],
  variables: [],
  tasks: [
    {
      id: "search_concepts",
      description:
        "List up to 200 concepts. Includes those minted by ingest-doc-as-concepts " +
        "(which carry metadata.doc_path) and operator hand-mints. The LLM downstream " +
        "scans for stale paths.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8260/concepts/search?limit=200",
        method: "GET",
        timeoutMs: 10000,
      },
      outputShapes: ["conceptSearchResult"],
    },
    {
      id: "scan_for_stale",
      description:
        "LLM heuristic scan for concepts whose source path looks stale. Cheap " +
        "model — this is a triage step, not deep reasoning. Output: bounded " +
        "JSON array of {concept_id, suspected_path, reason}.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt: SCAN_PROMPT,
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 2000,
      },
      outputShapes: ["staleCandidatesList"],
    },
    {
      id: "parse_candidates",
      description: "Extract the JSON array.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{scan_for_stale_text}}",
        path: "",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "emit_gaps",
      description:
        "Iterate over stale candidates. Per candidate: emit a substrateGap_write " +
        "with category=missing_concept. The drain-pending-substrate-gaps loop " +
        "picks these up and dispatches the drafter. classification_metadata " +
        "carries the structural detail (stale_pointer subtype, suspected_path).",
      resolver: "iteration",
      config: {
        over: "{{parse_candidates_value}}",
        elementVar: "candidate",
        indexVar: "i",
        maxIterations: 10,
        stopOnError: false,
        aggregateAs: "list",
        outputShape: "substrateGap",
        body: {
          resolver: "http_fetch",
          config: {
            type: "http_fetch",
            url: "http://127.0.0.1:8270/v2/impulses/resolve",
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              impulse: {
                pointer: {
                  type: "substrateGap_write",
                  gap: {
                    id: "stale-pointer-{{candidate.concept_id}}",
                    category: "missing_concept",
                    source: "substrate_detected",
                    summary:
                      "Stale concept pointer for {{candidate.concept_id}}: {{candidate.suspected_path}}. {{candidate.reason}}",
                    detected_at: new Date(0).toISOString(),
                    status: "open",
                    classification_metadata: {
                      gap_subtype: "stale_concept_pointer",
                      concept_id: "{{candidate.concept_id}}",
                      suspected_path: "{{candidate.suspected_path}}",
                      detection_reason: "{{candidate.reason}}",
                    },
                  },
                },
              },
            }),
            timeoutMs: 10000,
          },
        },
      },
      outputShapes: ["substrateGap"],
    },
    {
      id: "emit_report",
      description: "Write a small summary report for the operator.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "/workspace/concept-ingest/last-stale-scan.json",
        content: JSON.stringify({
          completed_at: new Date(0).toISOString(),
          candidates: "{{parse_candidates_value}}",
          gaps_emitted: "{{emit_gaps_value}}",
        }),
      },
      outputShapes: ["stalePointerReport"],
    },
  ],
};
