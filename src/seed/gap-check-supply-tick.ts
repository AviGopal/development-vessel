import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * gap-check-supply-tick — deterministic single-resolver wrapper around gap_check_supply_tick, so the
 * supply of system-authored gap checks is an activity the loop can select and grade (law 2). The
 * resolver reads its own family's timeShapedRhythm ("gap-check-supply") and does nothing when the
 * family has no rhythm or is not due, so selecting this template cannot bypass the cadence (law 5).
 * Per tick it arms gaps whose system-authored test has landed red at HEAD for the right reason, and
 * dispatches one test-writing edit goal per needs-localization gap (appending to an existing test of
 * the edit site when one exists; a hash-parity control arm gets none), bounded and backed off by the
 * rhythm's body. No LLM here; the only writes are gap rows and the family's report-graded settlement.
 */
export const GAP_CHECK_SUPPLY_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:gap-check-supply-tick",
  name: "gap-check-supply-tick",
  description:
    "Supplies checks for gaps the lane cannot take because they have none: dispatches one edit goal " +
    "per needs-localization gap to write (or append) a failing test in its vessel (no src edits), and " +
    "arms the gap from that test through substrateGap_write once it imports the edit site and the birth " +
    "judge reads its named tests failing on an assertion at HEAD. " +
    "Cadence, per-tick bound and backoff come from the gap-check-supply timeShapedRhythm.",
  inputShapes: [],
  outputShapes: ["gapCheckSupplyReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "boredom_target_template", "phase:supply"],
  variables: [],
  tasks: [
    {
      id: "supply_gap_checks",
      description: "Invoke gap_check_supply_tick; it gates itself on the gap-check-supply rhythm.",
      resolver: "gap_check_supply_tick",
      config: { type: "gap_check_supply_tick" },
      outputShapes: ["gapCheckSupplyReport"],
    },
  ],
};
