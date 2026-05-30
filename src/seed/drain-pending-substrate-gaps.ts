import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * drain-pending-substrate-gaps — wires substrateGap impulses to the drafter.
 *
 * Problem this solves: `substrateGap_write` impulses persist gap statements
 * to /workspace/gaps/gaps.json, but the drafter (`draft-gap-closing-activity`)
 * only consumes failure-mode-scenario JSON files. Open substrateGaps sit as
 * inert evidence — the closure pathway exists in name only.
 *
 * Pattern: pull-poll. Each boredom tick that lands on goal[10] reads the
 * single oldest open gap from the substrateGap resolver and dispatches the
 * drafter against it via goal-host-vessel /run-goal with targetTemplateId.
 *
 * No bus event is required: `resolveSubstrateGapWrite` emits none. A future
 * iteration can switch to lifecycle:gap:created once the resolver emits it.
 *
 * Spec: openspec/changes/2026-05-30-substrate-gap-drafter-wiring/proposal.md
 */
export const DRAIN_PENDING_SUBSTRATE_GAPS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:drain-pending-substrate-gaps",
  name: "drain-pending-substrate-gaps",
  description:
    "Reads the oldest open substrateGap impulse and dispatches " +
    "draft-gap-closing-activity against it. Wires the substrateGap signal " +
    "(persisted by substrateGap_write) into the drafter. No-ops cleanly when " +
    "no gaps are open — null scenario_id propagates and the drafter's fs_read " +
    "fails fast as a normal trace.",
  inputShapes: ["substrateGap"],
  outputShapes: ["healthGapDispatch"],
  tags: ["lift.autonomous.loop", "substrate.gap.drain", "gap.closing"],
  variables: [
    {
      name: "scenarios_dir",
      description: "Directory containing failure-mode scenario JSON files.",
    },
    {
      name: "report_path",
      description: "Path to the latest failure-mode harness report.",
    },
    {
      name: "proposals_dir",
      description: "Directory where the drafter writes proposal JSON.",
    },
  ],
  tasks: [
    {
      id: "read_open_gaps",
      description:
        "Read the single oldest open substrateGap. The resolver sorts " +
        "descending by updated_at; we take limit=1 so each tick processes " +
        "one gap and lets Thompson posteriors accumulate per scenario.",
      resolver: "substrateGap",
      config: {
        type: "substrateGap",
        status: "open",
        limit: 1,
      },
      outputShapes: ["substrateGap"],
    },
    {
      id: "extract_gap_id",
      description:
        "Extract gaps[0].id from the resolver response. This becomes the " +
        "scenario_id for the drafter.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_open_gaps_content}}",
        path: "gaps.0.id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_gap_summary",
      description:
        "Extract gaps[0].summary for diagnostic logging in the dispatched goal.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_open_gaps_content}}",
        path: "gaps.0.summary",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "dispatch_drafter",
      description:
        "POST to goal-host-vessel /run-goal targeting draft-gap-closing-activity " +
        "with the gap id as scenario_id. When no gap is open, extract_gap_id_text " +
        "is empty and the drafter's fs_read fails fast — a normal trace, not an error.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "draft a gap-closing activity for open substrateGap {{extract_gap_id_text}}",
          targetTemplateId: "development-vessel:draft-gap-closing-activity",
          variables: {
            scenario_id: "{{extract_gap_id_text}}",
            scenarios_dir: "{{scenarios_dir}}",
            report_path: "{{report_path}}",
            proposals_dir: "{{proposals_dir}}",
            source: "drain-pending-substrate-gaps",
            gap_summary: "{{extract_gap_summary_text}}",
          },
        }),
      },
      outputShapes: ["healthGapDispatch"],
    },
  ],
};
