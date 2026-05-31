import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-phantom-success-trace — deterministic phantom-success-trace detector.
 *
 * A phantom-success trace is an execution row with status="success" AND
 * task_count=0. The substrate accumulates these when engine pre-flight
 * rejection credits success without a real task body, polluting Thompson
 * posteriors (9367+ observed from validator-dispatch alone as of 2026-05-30).
 *
 * Constitutional principle (concept_9ldsmRgqSTd5,
 * substrate_self_detection_principle): every bug class we observe is an
 * opportunity to author a detection template, not just patch the instance.
 * This template makes the bug class observable as substrateGap impulses so
 * downstream activities can plan a fix.
 *
 * Why a single-task template:
 *   - mirrors detect-stale-pointer's collapsed-resolver idiom
 *   - avoids the F25 multi-task abort pattern that produces the very
 *     phantom-success traces we are detecting (meta-irony averted)
 *   - filter+emit are deterministic; iteration adds no value
 *
 * Spec: substrate self-detection — author detection templates for
 * observed bug classes (operator directive 2026-05-30).
 */

export const DETECT_PHANTOM_SUCCESS_TRACE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-phantom-success-trace",
  name: "detect-phantom-success-trace",
  description:
    "Scans recent execution traces for the phantom-success-trace signature " +
    "(status=success AND task_count=0) and emits a substrateGap_write impulse " +
    "per finding. Deterministic detector (no LLM). Each gap carries " +
    "classification_metadata.gap_class='phantom_success_trace' and fix_priors " +
    "referencing the F25 phantom-success-trace concept so downstream drafting " +
    "activities have provenance. The underlying validator-dispatch bug is NOT " +
    "fixed here — this template makes the bug class observable.",
  inputShapes: [],
  outputShapes: ["substrateGap", "phantomTraceReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "trace.quality",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Run the phantom-success-trace scan + gap-emission in one server-side " +
        "step. Returns a phantomTraceReport with scanned/success_traces/" +
        "phantoms_detected/phantoms_posted counts and the per-entry list.",
      resolver: "phantom_trace_scan",
      config: {
        type: "phantom_trace_scan",
        limit: 200,
        maxEmits: 50,
        dry_run: false,
      },
      outputShapes: ["phantomTraceReport"],
    },
  ],
};
