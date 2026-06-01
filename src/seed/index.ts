import type { ActivityTemplate } from "@avigopal/ias-executor-ts";
import { SHIP_CHANGE_TEMPLATE } from "./ship-change.js";
import { BRANCH_HEALTH_TEMPLATE } from "./branch-health.js";
import { RELEASE_CHANGE_TEMPLATE } from "./release-change.js";
import { ADD_RESOLVER_TO_VESSEL_TEMPLATE } from "./add-resolver-to-vessel.js";
import { PROPAGATE_JUDGMENT_TEMPLATE } from "./propagate-judgment.js";
import { SCAFFOLD_NEW_VESSEL_TEMPLATE } from "./scaffold-new-vessel.js";
import { RELEASE_AND_VALIDATE_TEMPLATE } from "./release-and-validate.js";
import { DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE } from "./draft-gap-closing-activity.js";
import { HARNESS_CHECK_SCENARIO_TEMPLATE } from "./harness-check-scenario.js";
import { PROBE_REACHABLE_UNLEARNED_TEMPLATE } from "./probe-reachable-unlearned.js";
import { PROBE_UNTRAVERSED_EDGE_TEMPLATE } from "./probe-untraversed-edge.js";
import { ESCALATE_UNKNOWN_SHAPE_TEMPLATE } from "./escalate-unknown-shape.js";
import { COVERAGE_TICK_TEMPLATE } from "./coverage-tick.js";
import { SUBSTRATE_HEALTH_TICK_TEMPLATE } from "./substrate-health-tick.js";
import { HARNESS_RUN_MATRIX_TEMPLATE } from "./harness-run-matrix.js";
import { TRY_DIRECT_ANSWER_TEMPLATE } from "./try-direct-answer.js";
import { CLOSE_HEALTH_GAP_TEMPLATE } from "./close-health-gap.js";
import { DRAIN_PENDING_SUBSTRATE_GAPS_TEMPLATE } from "./drain-pending-substrate-gaps.js";
import { DRAFT_SPEC_FROM_GAP_TEMPLATE } from "./draft-spec-from-gap.js";
import { INGEST_DOC_AS_CONCEPTS_TEMPLATE } from "./ingest-doc-as-concepts.js";
import { DETECT_STALE_POINTER_TEMPLATE } from "./detect-stale-pointer.js";
import { DETECT_PHANTOM_SUCCESS_TRACE_TEMPLATE } from "./detect-phantom-success-trace.js";
import { DETECT_PRECONDITION_REJECTION_TEMPLATE } from "./detect-precondition-rejection.js";
import { AUDIT_DISPATCH_TARGET_DRIFT_TEMPLATE } from "./audit-dispatch-target-drift.js";
import { INGEST_AUDIT_FINDINGS_TEMPLATE } from "./ingest-audit-findings.js";
import { DETECT_SERVICE_OOM_CASCADE_TEMPLATE } from "./detect-service-oom-cascade.js";

export { SHIP_CHANGE_TEMPLATE } from "./ship-change.js";
export { BRANCH_HEALTH_TEMPLATE } from "./branch-health.js";
export { RELEASE_CHANGE_TEMPLATE } from "./release-change.js";
export { ADD_RESOLVER_TO_VESSEL_TEMPLATE } from "./add-resolver-to-vessel.js";
export { PROPAGATE_JUDGMENT_TEMPLATE } from "./propagate-judgment.js";
export { SCAFFOLD_NEW_VESSEL_TEMPLATE } from "./scaffold-new-vessel.js";
export { RELEASE_AND_VALIDATE_TEMPLATE } from "./release-and-validate.js";
export { DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE } from "./draft-gap-closing-activity.js";
export { HARNESS_CHECK_SCENARIO_TEMPLATE } from "./harness-check-scenario.js";
export { PROBE_REACHABLE_UNLEARNED_TEMPLATE } from "./probe-reachable-unlearned.js";
export { PROBE_UNTRAVERSED_EDGE_TEMPLATE } from "./probe-untraversed-edge.js";
export { ESCALATE_UNKNOWN_SHAPE_TEMPLATE } from "./escalate-unknown-shape.js";
export { COVERAGE_TICK_TEMPLATE } from "./coverage-tick.js";
export { SUBSTRATE_HEALTH_TICK_TEMPLATE } from "./substrate-health-tick.js";
export { HARNESS_RUN_MATRIX_TEMPLATE } from "./harness-run-matrix.js";
export { TRY_DIRECT_ANSWER_TEMPLATE } from "./try-direct-answer.js";
export { CLOSE_HEALTH_GAP_TEMPLATE } from "./close-health-gap.js";
export { DRAIN_PENDING_SUBSTRATE_GAPS_TEMPLATE } from "./drain-pending-substrate-gaps.js";
export { DRAFT_SPEC_FROM_GAP_TEMPLATE } from "./draft-spec-from-gap.js";
export { INGEST_DOC_AS_CONCEPTS_TEMPLATE } from "./ingest-doc-as-concepts.js";
export { DETECT_STALE_POINTER_TEMPLATE } from "./detect-stale-pointer.js";
export { DETECT_PHANTOM_SUCCESS_TRACE_TEMPLATE } from "./detect-phantom-success-trace.js";
export { DETECT_PRECONDITION_REJECTION_TEMPLATE } from "./detect-precondition-rejection.js";
export { AUDIT_DISPATCH_TARGET_DRIFT_TEMPLATE } from "./audit-dispatch-target-drift.js";
export { INGEST_AUDIT_FINDINGS_TEMPLATE } from "./ingest-audit-findings.js";
export { DETECT_SERVICE_OOM_CASCADE_TEMPLATE } from "./detect-service-oom-cascade.js";

export const SEED_TEMPLATES: ActivityTemplate[] = [
  SHIP_CHANGE_TEMPLATE,
  BRANCH_HEALTH_TEMPLATE,
  RELEASE_CHANGE_TEMPLATE,
  ADD_RESOLVER_TO_VESSEL_TEMPLATE,
  PROPAGATE_JUDGMENT_TEMPLATE,
  SCAFFOLD_NEW_VESSEL_TEMPLATE,
  RELEASE_AND_VALIDATE_TEMPLATE,
  DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE,
  HARNESS_CHECK_SCENARIO_TEMPLATE,
  // topology-discovery-loop (§2 + §3 + §3a)
  PROBE_REACHABLE_UNLEARNED_TEMPLATE,
  PROBE_UNTRAVERSED_EDGE_TEMPLATE,
  ESCALATE_UNKNOWN_SHAPE_TEMPLATE,
  COVERAGE_TICK_TEMPLATE,
  SUBSTRATE_HEALTH_TICK_TEMPLATE,
  // harness-as-lifecycle-participant (§2)
  HARNESS_RUN_MATRIX_TEMPLATE,
  // minimum activity loop — try → trace → learn (operator directive 2026-05-28)
  TRY_DIRECT_ANSWER_TEMPLATE,
  // self-healing: closes diagnostic→action loop for confidence gap (2026-05-28)
  CLOSE_HEALTH_GAP_TEMPLATE,
  // gap-drain: wires substrateGap impulses to draft-gap-closing-activity (2026-05-30)
  DRAIN_PENDING_SUBSTRATE_GAPS_TEMPLATE,
  // substrate-authored openspec changes (Unlock C, 2026-05-30)
  DRAFT_SPEC_FROM_GAP_TEMPLATE,
  // doc-ingestion + concept management (2026-05-30)
  INGEST_DOC_AS_CONCEPTS_TEMPLATE,
  DETECT_STALE_POINTER_TEMPLATE,
  // substrate self-detection (2026-05-30): author detection templates for
  // observed bug classes — phantom-success traces (F25) are the first.
  DETECT_PHANTOM_SUCCESS_TRACE_TEMPLATE,
  // substrate self-detection (2026-05-30): pre-flight-rejected traces
  // (status=failure + duration<500ms + task_count=0) — F25 signature.
  // Complement to detect-phantom-success-trace (which catches status=success
  // + task_count=0). Same constitutional principle (concept_9ldsmRgqSTd5).
  DETECT_PRECONDITION_REJECTION_TEMPLATE,
  // dispatch-target-drift detector (2026-05-30): detection-template-of-detection-
  // templates — probes trace schema for any target-recording field; if absent
  // (current state) emits a single instrumentation_gap substrateGap declaring
  // the chained-prerequisite data shape; if present, emits per-drift gaps.
  AUDIT_DISPATCH_TARGET_DRIFT_TEMPLATE,
  // audit-ingestion bridge (iter-080, 2026-05-30): reads audit findings → substrateGap impulses
  INGEST_AUDIT_FINDINGS_TEMPLATE,
  // substrate self-detection (2026-05-31): service-level OOM cascade detector
  // (concept_RYl73llSCGfc, concept_6RwK5H5F28hT, concept_s9ye5GKLw2L8,
  // concept_T-CTTOEl97IM). The seven-iteration-unresolved bug class becomes
  // a first-class substrate citizen; same constitutional principle
  // (concept_9ldsmRgqSTd5) as detect-phantom-success-trace and
  // detect-precondition-rejection.
  DETECT_SERVICE_OOM_CASCADE_TEMPLATE,
];
