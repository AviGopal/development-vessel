import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * vector-space-orthogonality-audit-tick — substrate detects failure traces
 * orthogonal to ALL existing architectural_pattern_principle concepts and
 * emits substrateGap impulses (category=novel_failure_mode_detected) so the
 * drafter can author new principles covering uncovered vector subspaces.
 * Immunity-pattern compliant: empty inputShapes, empty variables, single
 * resolver dispatch. light-dispatch-eligible.
 */
export const VECTOR_SPACE_ORTHOGONALITY_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:vector-space-orthogonality-audit-tick",
  name: "vector-space-orthogonality-audit-tick",
  description:
    "Deterministic single-resolver wrapper around vector_space_orthogonality_audit. " +
    "Scores recent failure traces against architectural_pattern_principle concepts via " +
    "concept-db dense search; clusters traces below similarity threshold and emits " +
    "novel_failure_mode_detected substrateGap impulses. Closes the meta-recursion: " +
    "substrate detects what it wasn't taught to detect.",
  inputShapes: [],
  outputShapes: ["vectorSpaceOrthogonalityResult"],
  tags: [
    "intent:horizon_detection",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
  ],
  variables: [],
  tasks: [
    {
      id: "audit_vector_space_orthogonality",
      description:
        "Invoke vector_space_orthogonality_audit. Reads failure traces, queries " +
        "concept-db for nearest architectural_pattern_principle per trace, emits " +
        "substrateGap for orthogonal clusters.",
      resolver: "vector_space_orthogonality_audit",
      config: { type: "vector_space_orthogonality_audit" },
      outputShapes: ["vectorSpaceOrthogonalityResult"],
    },
  ],
};
