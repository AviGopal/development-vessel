import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-reach-rate-shortfall — the substrate measuring itself against its own
 * execution contract.
 *
 * The contract (CLAUDE.md, "The execution expectation") says an arbitrary goal
 * walk should reach with high probability (~90%) regardless of priors. Measured
 * 2026-09-01 the fleet reached 1.5%-16.8% depending on the population, and had
 * never filed a gap about it — because no activity read an aggregate reach
 * statistic. substrate-health-tick measures posterior confidence, graph stability
 * and optimality; coverage-tick's "reach" is shape reachability in the graph;
 * performance-reach-gate reads HTTP latency. A contract with no instrument cannot
 * be violated visibly. This template is the instrument.
 *
 * Sibling of detect-gate-saturation, with its blind spot deliberately corrected:
 * that detector filters candidates by an id substring (check|gate|valid|...), so
 * it could never see a family named `composed-cap-…` re-minting itself 79 times.
 * This one filters on GRADED VOLUME and RATE only — never on a name.
 *
 * Single-task, deterministic, no LLM.
 */
export const DETECT_REACH_RATE_SHORTFALL_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-reach-rate-shortfall",
  name: "detect-reach-rate-shortfall",
  description:
    "Detects activity families falling short of the substrate's ~90% goal-reach " +
    "execution contract. Consumes activity-api's groupedExecutionStats (per-activity " +
    "reach_rate computed from the `reached` GOAL VERDICT over GRADED runs only — not " +
    "from `success`, which is merely exit status); flags any family whose reach_rate " +
    "≤ min_reach_rate over ≥ min_graded_volume graded runs, regardless of its name. " +
    "Emits one substrateGap per family with classification_metadata.gap_subtype=" +
    "'reach_rate_shortfall' carrying a re-runnable evidence_resolve falsifier. Closes " +
    "the blind spot in which nothing in the fleet read an aggregate reach statistic.",
  inputShapes: [],
  outputShapes: ["substrateGap", "reachRateReport"],
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
        "Read per-activity reach statistics over the window and emit a substrateGap " +
        "per family reaching below the floor on a sufficiently graded sample. Returns " +
        "a reachRateReport with families_evaluated / finding_count / fleet_reach_rate.",
      resolver: "reach_rate_scan",
      config: {
        type: "reach_rate_scan",
        window_hours: 24,
        // The contract is 0.90; the floor starts at 0.50 so the first emissions are
        // the unambiguous cases rather than a fleet-wide gap flood. Ratchet toward
        // the contract here as the fleet climbs — this value is read at use time.
        min_reach_rate: 0.5,
        min_graded_volume: 8,
        limit: 50,
        dry_run: false,
        max_emits: 10,
      },
      outputShapes: ["reachRateReport"],
    },
  ],
};
