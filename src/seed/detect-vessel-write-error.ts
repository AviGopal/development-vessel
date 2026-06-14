import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-vessel-write-error — deterministic detector for vessels logging
 * repeated persistence (write) errors.
 *
 * Meta-detector authored 2026-06-13 after the operator had to hand-fix exactly
 * this class: concept-db logged a SurrealDB INSERT failure ("Found NULL for
 * field content ... expected a option<string>") on EVERY concept_create_write,
 * silently dropping its write-audit impulse. The concept write "succeeded" so no
 * trace failed — the only signal was a repeating ERROR line nothing watched.
 * This makes the class substrate-detectable: scan each data-bearing vessel's
 * journal for SQL/write errors over a window and emit a substrateGap when the
 * count crosses a threshold, routing the fix into the gap → bridge → drafter
 * loop so the next instance self-completes.
 *
 * Single-task template (mirrors detect-stale-pointer); the resolver reads the
 * journal (journalctl) and emits; no LLM.
 */
export const DETECT_VESSEL_WRITE_ERROR_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-vessel-write-error",
  name: "detect-vessel-write-error",
  description:
    "Scans data-bearing vessels' systemd journals (concept-db, activity-api, " +
    "identity-vessel by default) for repeated persistence-error lines (SurrealDB " +
    "query failed / Found NULL / INSERT|UPDATE failed) over a window. Emits one " +
    "substrateGap per unit whose match count crosses the threshold, with " +
    "classification_metadata.gap_subtype='vessel_write_error'. Catches the class " +
    "where concept-db dropped its write-audit impulse on every mint via a silent " +
    "NULL-vs-NONE INSERT failure.",
  inputShapes: [],
  outputShapes: ["substrateGap", "vesselWriteErrorReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "mechanism.health.tick",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Run the per-vessel journal write-error scan + gap-emission in one " +
        "server-side step. Returns a vesselWriteErrorReport with per_target match " +
        "counts and the findings that crossed the threshold.",
      resolver: "vessel_write_error_scan",
      config: {
        type: "vessel_write_error_scan",
        windowMinutes: 30,
        threshold: 3,
        dry_run: false,
      },
      outputShapes: ["vesselWriteErrorReport"],
    },
  ],
};
