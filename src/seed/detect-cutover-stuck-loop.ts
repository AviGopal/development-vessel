import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-cutover-stuck-loop — substrate-citizen for the 2026-06-04 session's
 * meta-bug class.
 *
 * Background. This session shipped four interlocking operator-side patches:
 *   - check-shape-dispatch.ts: host vs container packages/ layout
 *   - vessel-mitosis-cutover.ts: freshness sentinel = first staged file
 *   - mitosis-tick.ts (template): pin base_root to /vessels/<vessel>
 *   - host-sync-poller.sh: same freshness sentinel fix as cutover
 *
 * Each was a different surface bug. The shared shape: a value V was written
 * at point A reading source path P1, and gated at point B reading source
 * path P2; P1 ≠ P2 → gate refuses forever. From outside (no code reading)
 * the symptom is uniform: many `vesselMitosisCutoverResult{applied:false}`
 * impulses, zero `cutoverApplied` impulses. The chain runs, ticks succeed,
 * no host-sync intent is emitted, no autonomous commit lands.
 *
 * This detector observes that symptom directly. It does not try to identify
 * which path mismatched — the gap-closing drafter does that downstream.
 *
 * What it measures.
 *   1. Count mitosis-tick traces (status=success, last `window_hours`).
 *   2. Count intent rows appended to /workspace/mitosis-applied-host-sync.jsonl
 *      in the same window.
 *   3. ratio = intents / ticks.
 *   4. If ticks ≥ `min_ticks` AND ratio < `min_ratio` → stuck-loop gap.
 *
 * Why ratio not absolute count: the autonomous chain runs at variable
 * cadence (boredom-vessel scoring + LLM latency). 0/5 and 0/50 are
 * qualitatively the same gap; 0/5 might just be cold start.
 *
 * Why this avoids the recursive trap: it doesn't introspect resolver
 * source. A path-mismatch bug in this detector itself cannot make it
 * report a false positive — the inputs are externally observable trace
 * counts and an externally observable intent file. The detector reports
 * an audited NO when the substrate is healthy (no stuck loop), and an
 * audited YES (substrateGap emitted) when it isn't. Same audited-NO
 * idiom as vessel-mitosis-cutover itself.
 *
 * Refs:
 *   - concept_Orn4yVaJYD24 (operator-becomes-tick-template)
 *   - feedback_substrate_self_detection_recursive
 *   - feedback_substrate_self_detection
 *   - concept_7mzv7SQN_7JB (no new tiers — restated in existing primitives)
 */
export const DETECT_CUTOVER_STUCK_LOOP_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-cutover-stuck-loop",
  name: "detect-cutover-stuck-loop",
  description:
    "Substrate-citizen detector for the 'autonomous cutover never commits' " +
    "failure mode. Compares mitosis-tick success count against host-sync intent " +
    "count in a sliding window; emits substrateGap_write when ticks accumulate " +
    "without intents (the externally-visible symptom of cutover refusing every " +
    "tick for some structural reason). Does not attempt to identify the cause — " +
    "the gap-closing drafter authors the proposed fix.",
  inputShapes: [],
  outputShapes: ["cutoverStuckLoopFinding", "substrateGap"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "cutover.health",
  ],
  variables: [
    { name: "window_hours", description: "Lookback window in hours. Default 24." },
    { name: "min_ticks", description: "Floor on tick count before evaluating ratio (cold-start guard). Default 5." },
    { name: "min_ratio", description: "Floor on intents/ticks. Below this → emit gap. Default 0.10." },
    { name: "activity_api_endpoint", description: "Activity-api base URL. Default http://127.0.0.1:8080." },
    { name: "intent_file", description: "Host-sync intent JSONL path. Default /workspace/mitosis-applied-host-sync.jsonl." },
  ],
  tasks: [
    {
      id: "fetch_recent_ticks",
      description:
        "Pull recent mitosis-tick execution traces from activity-api. Trace " +
        "summary includes status + created_at; we count status=success rows " +
        "within window_hours.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{activity_api_endpoint}}/v2/activities/execution-traces?activity_template_id=development-vessel:mitosis-tick&limit=200",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "read_intents",
      description:
        "Read the host-sync intent file. Each non-blank line is one intent " +
        "emitted by a successful cutover. Missing file → 0 intents.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{intent_file}}",
        optional: true,
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "analyze",
      description:
        "Count successful ticks in window, count intent lines, compute ratio, " +
        "decide verdict. Emits cutoverStuckLoopFinding{ticks, intents, ratio, " +
        "verdict: 'healthy' | 'stuck_loop' | 'cold_start', window_hours}. The " +
        "LLM is acting as a deterministic counter here — temp 0, JSON output, " +
        "no creative reasoning.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        model: "auto",
        max_tokens: 800,
        prompt:
          "You are computing a deterministic detection verdict for the substrate's " +
          "autonomous cutover loop. Output ONLY JSON, no prose.\n\n" +
          "## Inputs\n" +
          "window_hours = {{window_hours}}\n" +
          "min_ticks = {{min_ticks}}\n" +
          "min_ratio = {{min_ratio}}\n" +
          "now = (compute as latest created_at in the trace stream below)\n\n" +
          "## Recent mitosis-tick traces (JSON: {executions: [...]} or empty)\n" +
          "{{fetch_recent_ticks_content}}\n\n" +
          "## Host-sync intents (JSONL — one intent per line; missing → empty)\n" +
          "{{read_intents_content}}\n\n" +
          "## Algorithm\n" +
          "1. ticks = count of trace rows with status=='success' AND " +
          "created_at within window_hours of now.\n" +
          "2. intents = count of non-blank intent lines whose emitted_at falls " +
          "in the same window. If emitted_at is missing, count the whole file.\n" +
          "3. ratio = intents/ticks (or 1.0 if ticks==0).\n" +
          "4. verdict:\n" +
          "     - 'cold_start' if ticks < min_ticks\n" +
          "     - 'stuck_loop' if ticks ≥ min_ticks AND ratio < min_ratio\n" +
          "     - 'healthy'    otherwise\n\n" +
          "## Output (exactly this shape)\n" +
          "{\"cutoverStuckLoopFinding\": {\"ticks\": N, \"intents\": N, \"ratio\": F, " +
          "\"verdict\": \"...\", \"window_hours\": H, \"min_ratio\": M}}\n",
      },
      outputShapes: ["cutoverStuckLoopFinding"],
    },
    {
      id: "emit_gap_when_stuck",
      description:
        "If verdict is 'stuck_loop', POST a substrateGap_write to activity-api " +
        "so the gap-closing drafter picks it up. classification_metadata.kind = " +
        "'cutover_stuck_loop' carries the externally-visible counts; the drafter " +
        "is responsible for proposing the fix (typically a freshness-sentinel " +
        "or path-resolution patch). Cites principle: " +
        "resilient_against_unintended_changes.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "{{activity_api_endpoint}}/v2/impulses/resolve",
        body: {
          impulse: {
            type: "substrateGap_write",
            gap: {
              id: "cutover_stuck_loop:{{analyze_content.cutoverStuckLoopFinding.verdict}}",
              category: "selector_pathology",
              source: "substrate_detected",
              summary:
                "Cutover stuck-loop: ticks={{analyze_content.cutoverStuckLoopFinding.ticks}}, " +
                "intents={{analyze_content.cutoverStuckLoopFinding.intents}}, " +
                "ratio={{analyze_content.cutoverStuckLoopFinding.ratio}}. " +
                "Substrate is producing successful mitosis-tick traces but no " +
                "downstream cutover intents, which means every cutover is " +
                "soft-refusing for a structural reason. The drafter should " +
                "propose a fix in vessel-mitosis-cutover, mitosis-tick template, " +
                "apply-proposal-as-patch, or host-sync-poller — the path-config " +
                "writer/reader pair that diverged.",
              status: "open",
              classification_metadata: {
                kind: "cutover_stuck_loop",
                ticks: "{{analyze_content.cutoverStuckLoopFinding.ticks}}",
                intents: "{{analyze_content.cutoverStuckLoopFinding.intents}}",
                ratio: "{{analyze_content.cutoverStuckLoopFinding.ratio}}",
                window_hours: "{{analyze_content.cutoverStuckLoopFinding.window_hours}}",
                cite_principle: "resilient_against_unintended_changes",
                suggested_remediation:
                  "Audit (writer_of_base_sha, reader_of_base_sha) pairs and " +
                  "(writer_of_path, reader_of_path) pairs for divergence. " +
                  "Symmetric instances in resolver TS + shell scripts.",
              },
            },
          },
        },
      },
      outputShapes: ["substrateGap"],
    },
  ],
};
