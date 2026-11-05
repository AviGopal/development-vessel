import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * gap-close-verify — the close of a gap on a verified landing (src/judge/gap-landing-verdict.ts: closeLandedGap and the
 * pending-land sweep), run in process, never dispatched. It produces one gapCloseDecision per close (gap, landing sha,
 * which closer, closed_reason, close_basis). Its grade is decided by a LATER READER, the gap-close-verify-credit trace
 * a sweep posts at least 72 h after the close: reached = the row is still closed and its own check, re-run then, reads
 * absent. Never graded at exit. Variant-0 only: the close exactly as it is decided today, so an alternative can compete
 * with it later. Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const GAP_CLOSE_VERIFY_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:gap-close-verify",
  name: "gap-close-verify",
  description:
    "Closes a gap whose fix landed and was verified, recording a gapCloseDecision (gap, landing sha, closer, " +
    "closed_reason, close_basis). Graded by a later reader: still closed with its own check green when re-run at " +
    "least 72 h after the close; never at exit.",
  inputShapes: ["substrateGap", "cutoverApplied"],
  outputShapes: ["gapCloseDecision"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "close",
      description: "Close the gap on its verified landing, as both closers decide it today (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["gapCloseDecision"],
    },
  ],
};
