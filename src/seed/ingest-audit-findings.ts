import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * ingest-audit-findings — parses audit findings file and creates substrateGap impulses.
 *
 * Reads /workspace/findings/audit.md, extracts open Finding entries via LLM,
 * and writes each as a substrateGap impulse to dev-vessel's substrateGap_write
 * resolver. This bridges the audit agent's findings into the drain pipeline:
 *
 *   audit.md → substrateGap impulses → drain-pending-substrate-gaps
 *            → draft-gap-closing-activity → gap-closing templates
 *
 * Per inv-080: the bridge was unblocked when F13 fixed proxy-catch silent-success.
 * Now that gap-closing templates work (template validation), this bridge provides
 * ongoing substrate work items from the audit's identified gaps.
 *
 * The findings file is copied to /workspace/findings/audit.md during substrate
 * bootstrap. This template runs as boredom goal[11].
 */
export const INGEST_AUDIT_FINDINGS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:ingest-audit-findings",
  name: "ingest-audit-findings",
  description:
    "Reads the audit findings file, extracts open Finding entries via LLM, " +
    "and writes each finding as a substrateGap impulse via http_fetch. " +
    "Bridges the audit agent's findings into the drain-pending-substrate-gaps pipeline.",
  inputShapes: [],
  outputShapes: ["substrateGapBatch"],
  tags: ["lift.autonomous.loop", "audit.ingestion", "gap.closing"],
  tasks: [
    {
      id: "read_findings",
      description: "Load the audit findings markdown file from workspace.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/workspace/findings/audit.md",
      },
      outputShapes: ["auditFindingsContent"],
    },
    {
      id: "extract_open_findings",
      description:
        "Use LLM to extract open Finding entries from the markdown. " +
        "Return JSON array: [{id, title, severity, summary}]",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 2000,
        prompt:
          "Parse the following audit findings document and extract all OPEN findings (not yet fully resolved).\n\n" +
          "Document:\n{{read_findings_content}}\n\n" +
          "Return a JSON array of objects. Each object must have:\n" +
          "- id: string like 'finding-1', 'finding-2' etc\n" +
          "- title: the finding title (short, under 80 chars)\n" +
          "- severity: 'blocking' | 'high' | 'medium' | 'low'\n" +
          "- summary: one sentence describing the gap\n\n" +
          "Only include findings that describe genuine technical gaps (not retractions, not already fixed).\n" +
          "Return ONLY the JSON array, no prose.",
      },
      outputShapes: ["openFindingsList"],
    },
    {
      id: "write_gaps_to_workspace",
      description: "Persist the parsed findings as substrateGap batch to workspace.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "/workspace/gaps/audit-findings-batch.json",
        content: "{{extract_open_findings_text}}",
      },
      outputShapes: ["substrateGapBatch"],
    },
    {
      id: "submit_gaps",
      description:
        "Submit the top 3 findings as substrateGap impulses to dev-vessel. " +
        "Uses LLM to format the first finding as a proper substrateGap_write call.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8090/v2/impulses/resolve",
        headers: { "Content-Type": "application/json" },
        body: "{\"impulse\":{\"pointer\":{\"type\":\"substrateGap_write\",\"gap\":{\"id\":\"audit-ingest-batch\",\"category\":\"missing_concept\",\"source\":\"substrate_detected\",\"summary\":\"Audit findings ingested: {{extract_open_findings_text}}\",\"detected_at\":\"2026-05-30T00:00:00Z\",\"status\":\"open\"}}}}",
      },
    },
  ],
};
