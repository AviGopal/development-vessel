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
import { DETECTOR_COVERAGE_AUDIT_TICK_TEMPLATE } from "./detector-coverage-audit-tick.js";
import { COST_EXPECTATION_AUDIT_TICK_TEMPLATE } from "./cost-expectation-audit-tick.js";
import { SELF_ALTERATION_FUNNEL_TICK_TEMPLATE } from "./self-alteration-funnel-tick.js";
import { GAP_LIFECYCLE_TICK_TEMPLATE } from "./gap-lifecycle-tick.js";
import { MODEL_OPPORTUNITY_TICK_TEMPLATE } from "./model-opportunity-tick.js";
import { DETECTOR_META_TICK_TEMPLATE } from "./detector-meta-tick.js";
import { DRAFT_DETECTOR_ACTIVITY_TEMPLATE } from "./draft-detector-activity.js";
import { PROBE_REACHABLE_UNLEARNED_TEMPLATE } from "./probe-reachable-unlearned.js";
import { PROBE_UNTRAVERSED_EDGE_TEMPLATE } from "./probe-untraversed-edge.js";
import { ESCALATE_UNKNOWN_SHAPE_TEMPLATE } from "./escalate-unknown-shape.js";
import { COVERAGE_TICK_TEMPLATE } from "./coverage-tick.js";
import { SUBSTRATE_HEALTH_TICK_TEMPLATE } from "./substrate-health-tick.js";
import { VESSEL_DEMAND_TICK_TEMPLATE } from "./vessel-demand-tick.js";
import { HARNESS_RUN_MATRIX_TEMPLATE } from "./harness-run-matrix.js";
import { TRY_DIRECT_ANSWER_TEMPLATE } from "./try-direct-answer.js";
import { CLOSE_HEALTH_GAP_TEMPLATE } from "./close-health-gap.js";
import { DRAIN_PENDING_SUBSTRATE_GAPS_TEMPLATE } from "./drain-pending-substrate-gaps.js";
import { DRAFT_SPEC_FROM_GAP_TEMPLATE } from "./draft-spec-from-gap.js";
import { INGEST_DOC_AS_CONCEPTS_TEMPLATE } from "./ingest-doc-as-concepts.js";
import { DETECT_STALE_POINTER_TEMPLATE } from "./detect-stale-pointer.js";
import { DETECT_TEMPLATE_INPUT_LINT_TEMPLATE } from "./detect-template-input-lint.js";
import { DETECT_GATE_SATURATION_TEMPLATE } from "./detect-gate-saturation.js";
import { DETECT_VESSEL_WRITE_ERROR_TEMPLATE } from "./detect-vessel-write-error.js";
import { DETECT_CHAIN_FETCH_FAILURE_TEMPLATE } from "./detect-chain-fetch-failure.js";
import { DETECT_PHANTOM_SUCCESS_TRACE_TEMPLATE } from "./detect-phantom-success-trace.js";
import { DETECT_CUTOVER_STUCK_LOOP_TEMPLATE } from "./detect-cutover-stuck-loop.js";
import { DETECT_PRECONDITION_REJECTION_TEMPLATE } from "./detect-precondition-rejection.js";
import { AUDIT_DISPATCH_TARGET_DRIFT_TEMPLATE } from "./audit-dispatch-target-drift.js";
import { INGEST_AUDIT_FINDINGS_TEMPLATE } from "./ingest-audit-findings.js";
import { DETECT_SERVICE_OOM_CASCADE_TEMPLATE } from "./detect-service-oom-cascade.js";
import { DETECT_CONCEPT_DB_DRIFT_TEMPLATE } from "./detect-concept-db-drift.js";
import { DETECT_OBSIDIAN_VESSEL_HEALTH_TEMPLATE } from "./detect-obsidian-vessel-health.js";
import { DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE } from "./draft-activity-from-pattern.js";
import { PUBLISH_SUBSTRATE_AUTHORED_ARTIFACT_TEMPLATE } from "./publish-substrate-authored-artifact.js";
import { EVALUATE_PR_VIA_INTERNAL_IDIOMS_TEMPLATE } from "./evaluate-pr-via-internal-idioms.js";
import { OBSERVE_ORTHOGONAL_PATTERNS_TEMPLATE } from "./observe-orthogonal-patterns.js";
import { ENACT_ORTHOGONAL_DECISIONS_TEMPLATE } from "./enact-orthogonal-decisions.js";
import { COMPLETE_VESSEL_SCAFFOLD_TEMPLATE } from "./complete-vessel-scaffold.js";
import { SCAFFOLD_AND_PUBLISH_VESSEL_TEMPLATE } from "./scaffold-and-publish-vessel.js";
import { SCAFFOLD_MITOSIS_TRACK_TEMPLATE } from "./scaffold-mitosis-track.js";
import { BACKEND_SNAPSHOT_TO_GIT_TEMPLATE } from "./backend-snapshot-to-git.js";
import { VESSEL_REPO_PROMOTE_TEMPLATE } from "./vessel-repo-promote.js";
import { MITOSIS_TICK_TEMPLATE } from "./mitosis-tick.js";
import { CONCEPT_USAGE_BACKFILL_TEMPLATE } from "./concept-usage-backfill.js";
// Horizon-detector ticks (Stage 1 of 2026-06-03-pre-lift-bootstrap-and-architecture-aware-loop)
import { VESSEL_RESPONSIBILITY_AUDIT_TICK_TEMPLATE } from "./vessel-responsibility-audit-tick.js";
import { VESSEL_ARCHITECTURE_PATTERN_SCAN_TICK_TEMPLATE } from "./vessel-architecture-pattern-scan-tick.js";
import { ACTIVITY_LIFECYCLE_AUDIT_TICK_TEMPLATE } from "./activity-lifecycle-audit-tick.js";
import { RESOLVER_DISTRIBUTION_AUDIT_TICK_TEMPLATE } from "./resolver-distribution-audit-tick.js";
// Gap-drain bridges (2026-06-04): close Break 1 (gap → drafter input boundary)
// and Break 2 (drafter → executor wiring) so the substrate's autonomous
// self-repair backlog can drain into applied vessel fixes.
import { GAP_TO_SCENARIO_BRIDGE_TICK_TEMPLATE } from "./gap-to-scenario-bridge-tick.js";
import { DISPATCH_LATEST_AUTO_DRAFT_TEMPLATE } from "./dispatch-latest-auto-draft.js";
import { APPLY_PROPOSAL_AS_PATCH_TEMPLATE } from "./apply-proposal-as-patch.js";
// mechanism-health-tick detection loop (2026-06-04). Three generic detectors +
// one aggregator that compose the 3 detection-template-pattern primitives
// against the M1-M6 observable surface (concept_q2n0_XaSvphV).
import { DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE } from "./detect-classifier-distribution-skew.js";
import { DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE } from "./detect-feature-flag-zero-exercise.js";
import { DETECT_FILTER_SATURATION_TEMPLATE } from "./detect-filter-saturation.js";
import { MECHANISM_HEALTH_TICK_TEMPLATE } from "./mechanism-health-tick.js";
import { DRAFTER_TRIGGER_TICK_TEMPLATE } from "./drafter-trigger-tick.js";
// Loop-C dispatch closer (2026-06-13): deterministic consumer of the
// vessel-authoring scenario queue gap-to-scenario-bridge already writes.
// Dual of drafter-trigger-tick — picks a vessel-authoring scenario, designs the
// vessel via one constrained LLM task, dispatches scaffold-and-publish-vessel.
import { VESSEL_SCAFFOLD_TRIGGER_TICK_TEMPLATE } from "./vessel-scaffold-trigger-tick.js";
// Vessel-arrival horizon classifier + reward edge (2026-06-13,
// SUBSTRATE_AS_MDP §8.4/§8.6): the missing arrival trigger. Detects vessels
// that joined discovery since last run, classifies their shape coverage,
// routes uncovered shapes into the drafter, credits the shapes (reward edge).
import { CHARACTERIZE_ARRIVED_VESSEL_TEMPLATE } from "./characterize-arrived-vessel.js";
// Phase 3 — closed-loop learning and verification
// (openspec/changes/2026-06-01-closed-loop-learning-and-verification/)
import { DETECT_RECURRING_PATTERN_TEMPLATE } from "./detect-recurring-pattern.js";
import { DETECT_RECURRING_TRACE_PATTERN_TEMPLATE } from "./detect-recurring-trace-pattern.js";
import { PREDICT_AND_VERIFY_TEMPLATE } from "./predict-and-verify.js";
import { REFINE_ON_DISAGREEMENT_TEMPLATE } from "./refine-on-disagreement.js";
import { VALIDATE_OBSIDIAN_VESSEL_INTERACTION_TEMPLATE } from "./validate-obsidian-vessel-interaction.js";
// Goal recovery activities (2026-06-04): replace autoDraft with explicit,
// measurable, Thompson-sampled activities for shape pre-check, failure recovery,
// and orchestrated retry. Composable standalone or together.
import { GOAL_SHAPE_PRE_CHECK_TEMPLATE } from "./goal-shape-pre-check.js";
import { RECOVER_FROM_GOAL_FAILURE_TEMPLATE } from "./recover-from-goal-failure.js";
import { GOAL_EXECUTION_WITH_RETRY_TEMPLATE } from "./goal-execution-with-retry.js";
// Template-mitosis variant-authoring loop (2026-06-04): detects weak template
// families via Thompson posterior mean < threshold, drafts improved variants
// through activity_create_variant. Write-scope only; Thompson sampling does
// the implicit promotion. Parallel to mitosis-tick (which targets vessel
// source) but for template source — same variant-first repair discipline.
import { TEMPLATE_MITOSIS_TICK_TEMPLATE } from "./template-mitosis-tick.js";
import { TEMPLATE_PROMOTE_TICK_TEMPLATE } from "./template-promote-tick.js";
// Vector-space orthogonality audit (2026-06-04): substrate-detected novel
// failure modes via embedding orthogonality vs architectural principles.
import { VECTOR_SPACE_ORTHOGONALITY_AUDIT_TICK_TEMPLATE } from "./vector-space-orthogonality-audit-tick.js";
// Trace-recording correctness audits (2026-06-05): substrate inspects its
// own learning records for status/outcome inconsistencies + Thompson posterior
// drift; emits substrateGap so the drafter authors the fix.
import { TRACE_OUTCOME_VALIDITY_AUDIT_TICK_TEMPLATE } from "./trace-outcome-validity-audit-tick.js";
import { POSTERIOR_CONSISTENCY_AUDIT_TICK_TEMPLATE } from "./posterior-consistency-audit-tick.js";
// Meta-cognition bootstrap (2026-06-05): substrate detects its own missing
// capabilities and authors new resolvers to fill them. capability-gap-audit-tick
// is the detection half; resolver-author is the authoring half. After this
// lands the substrate's capability surface grows by its own action.
import { CAPABILITY_GAP_AUDIT_TICK_TEMPLATE } from "./capability-gap-audit-tick.js";
import { RESOLVER_AUTHOR_TEMPLATE } from "./resolver-author.js";
// Shadow-state observer ticks (2026-06-05): promote out-of-band substrate
// state into impulse form so detectors can observe it.
import {
  SYSTEMD_UNIT_HEALTH_OBSERVER_TICK_TEMPLATE,
  MITOSIS_INTENT_QUEUE_OBSERVER_TICK_TEMPLATE,
  APPLIED_PROPOSAL_SENTINEL_OBSERVER_TICK_TEMPLATE,
  MITOSIS_PENDING_OBSERVER_TICK_TEMPLATE,
  DISPATCH_DROPPED_OBSERVER_TICK_TEMPLATE,
  LLM_API_HEALTH_OBSERVER_TICK_TEMPLATE,
  HOST_CONTAINER_SOURCE_DRIFT_OBSERVER_TICK_TEMPLATE,
  DISK_SPACE_OBSERVER_TICK_TEMPLATE,
  WORKSPACE_HYGIENE_OBSERVER_TICK_TEMPLATE,
  PRUNE_STALE_MITOSIS_TICK_TEMPLATE,
  LEARNING_SIGNAL_HEALTH_OBSERVER_TICK_TEMPLATE,
  SELECTOR_SATURATION_AUDIT_TICK_TEMPLATE,
  CONCEPT_DB_HEALTH_OBSERVER_TICK_TEMPLATE,
  DISCOVERY_VESSEL_REGISTRY_OBSERVER_TICK_TEMPLATE,
  SUBSTRATE_HEARTBEAT_OBSERVER_TICK_TEMPLATE,
  LLM_QUOTA_OBSERVER_TICK_TEMPLATE,
  PUSH_HEALTH_OBSERVER_TICK_TEMPLATE,
} from "./shadow-state-observer-ticks.js";

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
export { VESSEL_DEMAND_TICK_TEMPLATE } from "./vessel-demand-tick.js";
export { HARNESS_RUN_MATRIX_TEMPLATE } from "./harness-run-matrix.js";
export { TRY_DIRECT_ANSWER_TEMPLATE } from "./try-direct-answer.js";
export { CLOSE_HEALTH_GAP_TEMPLATE } from "./close-health-gap.js";
export { DRAIN_PENDING_SUBSTRATE_GAPS_TEMPLATE } from "./drain-pending-substrate-gaps.js";
export { DRAFT_SPEC_FROM_GAP_TEMPLATE } from "./draft-spec-from-gap.js";
export { INGEST_DOC_AS_CONCEPTS_TEMPLATE } from "./ingest-doc-as-concepts.js";
export { DETECT_STALE_POINTER_TEMPLATE } from "./detect-stale-pointer.js";
export { DETECT_TEMPLATE_INPUT_LINT_TEMPLATE } from "./detect-template-input-lint.js";
export { DETECT_GATE_SATURATION_TEMPLATE } from "./detect-gate-saturation.js";
export { DETECT_VESSEL_WRITE_ERROR_TEMPLATE } from "./detect-vessel-write-error.js";
export { DETECT_CHAIN_FETCH_FAILURE_TEMPLATE } from "./detect-chain-fetch-failure.js";
export { DETECT_PHANTOM_SUCCESS_TRACE_TEMPLATE } from "./detect-phantom-success-trace.js";
export { DETECT_CUTOVER_STUCK_LOOP_TEMPLATE } from "./detect-cutover-stuck-loop.js";
export { DETECT_PRECONDITION_REJECTION_TEMPLATE } from "./detect-precondition-rejection.js";
export { AUDIT_DISPATCH_TARGET_DRIFT_TEMPLATE } from "./audit-dispatch-target-drift.js";
export { INGEST_AUDIT_FINDINGS_TEMPLATE } from "./ingest-audit-findings.js";
export { DETECT_SERVICE_OOM_CASCADE_TEMPLATE } from "./detect-service-oom-cascade.js";
export { DETECT_CONCEPT_DB_DRIFT_TEMPLATE } from "./detect-concept-db-drift.js";
export { DETECT_OBSIDIAN_VESSEL_HEALTH_TEMPLATE } from "./detect-obsidian-vessel-health.js";
export { DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE } from "./draft-activity-from-pattern.js";
export { DETECT_RECURRING_PATTERN_TEMPLATE } from "./detect-recurring-pattern.js";
export { DETECT_RECURRING_TRACE_PATTERN_TEMPLATE } from "./detect-recurring-trace-pattern.js";
export { PREDICT_AND_VERIFY_TEMPLATE } from "./predict-and-verify.js";
export { REFINE_ON_DISAGREEMENT_TEMPLATE } from "./refine-on-disagreement.js";
export { VALIDATE_OBSIDIAN_VESSEL_INTERACTION_TEMPLATE } from "./validate-obsidian-vessel-interaction.js";
export { GOAL_SHAPE_PRE_CHECK_TEMPLATE } from "./goal-shape-pre-check.js";
export { RECOVER_FROM_GOAL_FAILURE_TEMPLATE } from "./recover-from-goal-failure.js";
export { GOAL_EXECUTION_WITH_RETRY_TEMPLATE } from "./goal-execution-with-retry.js";
export { TEMPLATE_MITOSIS_TICK_TEMPLATE } from "./template-mitosis-tick.js";
export { TEMPLATE_PROMOTE_TICK_TEMPLATE } from "./template-promote-tick.js";
export { VECTOR_SPACE_ORTHOGONALITY_AUDIT_TICK_TEMPLATE } from "./vector-space-orthogonality-audit-tick.js";
export { TRACE_OUTCOME_VALIDITY_AUDIT_TICK_TEMPLATE } from "./trace-outcome-validity-audit-tick.js";
export { POSTERIOR_CONSISTENCY_AUDIT_TICK_TEMPLATE } from "./posterior-consistency-audit-tick.js";
export { CAPABILITY_GAP_AUDIT_TICK_TEMPLATE } from "./capability-gap-audit-tick.js";
export { RESOLVER_AUTHOR_TEMPLATE } from "./resolver-author.js";
export {
  SYSTEMD_UNIT_HEALTH_OBSERVER_TICK_TEMPLATE,
  MITOSIS_INTENT_QUEUE_OBSERVER_TICK_TEMPLATE,
  APPLIED_PROPOSAL_SENTINEL_OBSERVER_TICK_TEMPLATE,
  MITOSIS_PENDING_OBSERVER_TICK_TEMPLATE,
  DISPATCH_DROPPED_OBSERVER_TICK_TEMPLATE,
  LLM_API_HEALTH_OBSERVER_TICK_TEMPLATE,
  HOST_CONTAINER_SOURCE_DRIFT_OBSERVER_TICK_TEMPLATE,
  DISK_SPACE_OBSERVER_TICK_TEMPLATE,
  WORKSPACE_HYGIENE_OBSERVER_TICK_TEMPLATE,
  PRUNE_STALE_MITOSIS_TICK_TEMPLATE,
  LEARNING_SIGNAL_HEALTH_OBSERVER_TICK_TEMPLATE,
  SELECTOR_SATURATION_AUDIT_TICK_TEMPLATE,
  CONCEPT_DB_HEALTH_OBSERVER_TICK_TEMPLATE,
  DISCOVERY_VESSEL_REGISTRY_OBSERVER_TICK_TEMPLATE,
  SUBSTRATE_HEARTBEAT_OBSERVER_TICK_TEMPLATE,
  LLM_QUOTA_OBSERVER_TICK_TEMPLATE,
  PUSH_HEALTH_OBSERVER_TICK_TEMPLATE,
} from "./shadow-state-observer-ticks.js";
export { OBSERVE_ORTHOGONAL_PATTERNS_TEMPLATE } from "./observe-orthogonal-patterns.js";
export { ENACT_ORTHOGONAL_DECISIONS_TEMPLATE } from "./enact-orthogonal-decisions.js";
export { COMPLETE_VESSEL_SCAFFOLD_TEMPLATE } from "./complete-vessel-scaffold.js";
export { SCAFFOLD_AND_PUBLISH_VESSEL_TEMPLATE } from "./scaffold-and-publish-vessel.js";
export { SCAFFOLD_MITOSIS_TRACK_TEMPLATE } from "./scaffold-mitosis-track.js";
export { BACKEND_SNAPSHOT_TO_GIT_TEMPLATE } from "./backend-snapshot-to-git.js";
export { VESSEL_REPO_PROMOTE_TEMPLATE } from "./vessel-repo-promote.js";
export { MITOSIS_TICK_TEMPLATE } from "./mitosis-tick.js";
export { CONCEPT_USAGE_BACKFILL_TEMPLATE } from "./concept-usage-backfill.js";
export { VESSEL_RESPONSIBILITY_AUDIT_TICK_TEMPLATE } from "./vessel-responsibility-audit-tick.js";
export { VESSEL_ARCHITECTURE_PATTERN_SCAN_TICK_TEMPLATE } from "./vessel-architecture-pattern-scan-tick.js";
export { ACTIVITY_LIFECYCLE_AUDIT_TICK_TEMPLATE } from "./activity-lifecycle-audit-tick.js";
export { RESOLVER_DISTRIBUTION_AUDIT_TICK_TEMPLATE } from "./resolver-distribution-audit-tick.js";
export { GAP_TO_SCENARIO_BRIDGE_TICK_TEMPLATE } from "./gap-to-scenario-bridge-tick.js";
export { DISPATCH_LATEST_AUTO_DRAFT_TEMPLATE } from "./dispatch-latest-auto-draft.js";
export { APPLY_PROPOSAL_AS_PATCH_TEMPLATE } from "./apply-proposal-as-patch.js";
export { DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE } from "./detect-classifier-distribution-skew.js";
export { DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE } from "./detect-feature-flag-zero-exercise.js";
export { DETECT_FILTER_SATURATION_TEMPLATE } from "./detect-filter-saturation.js";
export { MECHANISM_HEALTH_TICK_TEMPLATE } from "./mechanism-health-tick.js";
export { DRAFTER_TRIGGER_TICK_TEMPLATE } from "./drafter-trigger-tick.js";
export { VESSEL_SCAFFOLD_TRIGGER_TICK_TEMPLATE } from "./vessel-scaffold-trigger-tick.js";
export { CHARACTERIZE_ARRIVED_VESSEL_TEMPLATE } from "./characterize-arrived-vessel.js";
export { DETECTOR_COVERAGE_AUDIT_TICK_TEMPLATE } from "./detector-coverage-audit-tick.js";
export { COST_EXPECTATION_AUDIT_TICK_TEMPLATE } from "./cost-expectation-audit-tick.js";
export { SELF_ALTERATION_FUNNEL_TICK_TEMPLATE } from "./self-alteration-funnel-tick.js";
export { GAP_LIFECYCLE_TICK_TEMPLATE } from "./gap-lifecycle-tick.js";
export { MODEL_OPPORTUNITY_TICK_TEMPLATE } from "./model-opportunity-tick.js";
export { DETECTOR_META_TICK_TEMPLATE } from "./detector-meta-tick.js";
export { DRAFT_DETECTOR_ACTIVITY_TEMPLATE } from "./draft-detector-activity.js";

export const SEED_TEMPLATES: ActivityTemplate[] = [
  // detector-authoring recursion (2026-06-14, SUBSTRATE_AS_MDP §9.3 limit-8):
  // the substrate authors its own detectors for uncovered problem classes via
  // the same detect→draft→register→promote loop it uses for every activity.
  DETECTOR_COVERAGE_AUDIT_TICK_TEMPLATE,
  COST_EXPECTATION_AUDIT_TICK_TEMPLATE,
  SELF_ALTERATION_FUNNEL_TICK_TEMPLATE,
  GAP_LIFECYCLE_TICK_TEMPLATE,
  MODEL_OPPORTUNITY_TICK_TEMPLATE,
  DETECTOR_META_TICK_TEMPLATE,
  DRAFT_DETECTOR_ACTIVITY_TEMPLATE,
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
  // drafter-trigger-tick (V18, 2026-06-07) — bridges boredom rotation to the
  // drafter's variable-supply requirement. Lists scenarios dir, picks the
  // first one, dispatches draft-gap-closing-activity via light-dispatch with
  // scenario_id + paths filled in. Without this template the producer chain
  // dead-ends at goal[8] precondition-rejection.
  DRAFTER_TRIGGER_TICK_TEMPLATE,
  // Loop-C dispatch closer (2026-06-13): the deterministic consumer of the
  // vessel-authoring scenario queue. gap-to-scenario-bridge routes
  // missing_capability gaps to validation/failure-modes/vessel-scenarios/ with
  // target=scaffold-and-publish-vessel, but nothing consumed that queue. This
  // tick (dual of drafter-trigger-tick) lists it, designs a vessel from the
  // demanded capability_shape via one constrained LLM task, and dispatches
  // scaffold-and-publish-vessel — which terminates in a PR (the safety gate).
  // Compose-only; closes the last wired-but-truncated self-stability loop
  // (SUBSTRATE_AS_MDP §8.6). No boredom goal added — operator-tunable cadence.
  VESSEL_SCAFFOLD_TRIGGER_TICK_TEMPLATE,
  // Vessel-arrival horizon classifier + reward edge (2026-06-13). The arrival
  // trigger SUBSTRATE_AS_MDP §8.6 named as missing: when a new vessel joins
  // discovery, classify the shapes it brought and route uncovered ones to the
  // drafter so the substrate gains a selectable action over the vessel; credit
  // the shapes (reward edge) so their cold-start relevance leaves zero. Boredom
  // dispatches it on cadence; first run is a no-arrival baseline.
  CHARACTERIZE_ARRIVED_VESSEL_TEMPLATE,
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
  DETECT_TEMPLATE_INPUT_LINT_TEMPLATE,
  DETECT_GATE_SATURATION_TEMPLATE,
  DETECT_VESSEL_WRITE_ERROR_TEMPLATE,
  DETECT_CHAIN_FETCH_FAILURE_TEMPLATE,
  // substrate self-detection (2026-05-30): author detection templates for
  // observed bug classes — phantom-success traces (F25) are the first.
  DETECT_PHANTOM_SUCCESS_TRACE_TEMPLATE,
  DETECT_CUTOVER_STUCK_LOOP_TEMPLATE,
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
  // concept-db upkeep detector (2026-06-03): detects duplicate clusters +
  // cold-start concepts. Fills the detect-concept-db-upkeep-gaps gap cited
  // in openspec/changes/2026-06-01-concept-db-supersession-and-chunker-hygiene/
  // and openspec/changes/2026-06-01-concept-db-upkeep-loop/.
  DETECT_CONCEPT_DB_DRIFT_TEMPLATE,
  // obsidian-vessel connectivity detector (2026-06-03): detects CORS anti-patterns
  // (raw fetch() calls that the Electron renderer blocks) and WebSocket URL doubling
  // (/ws/ws construction). Reads concept-db priors + live plugin source via
  // local-tools-vessel. Constitutional principle: every observed bug class becomes
  // a detection template (concept_9ldsmRgqSTd5).
  DETECT_OBSIDIAN_VESSEL_HEALTH_TEMPLATE,
  // Phase 2 of obsidian meta-skill prototype (2026-06-01): the substrate's
  // general drafter. Inputs a hand-built recurringPatternCluster, prunes the
  // resolver + activity vocabularies, drafts an arbitrary-topology activity
  // template, registers it through the 6 permissive-scope invariants, and
  // gates promotion on convergent-validity + comprehensibility checks.
  DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE,
  // Phase 3 — closed-loop learning and verification (2026-06-01)
  // openspec/changes/2026-06-01-closed-loop-learning-and-verification/
  DETECT_RECURRING_PATTERN_TEMPLATE,
  DETECT_RECURRING_TRACE_PATTERN_TEMPLATE,
  PREDICT_AND_VERIFY_TEMPLATE,
  REFINE_ON_DISAGREEMENT_TEMPLATE,
  // substrate-as-git-author Phase 1 (2026-06-01): composition that lets the
  // substrate publish authored artifacts via its own git_branch_create +
  // git_push + gh_pr_create resolvers without canonizing any destination path.
  // Caller chooses target_path, target_branch, and PR text as variables.
  PUBLISH_SUBSTRATE_AUTHORED_ARTIFACT_TEMPLATE,
  // Substrate-internal evaluation gate replacing operator-approval. Composes
  // comprehensibility_check + phantom_trace_scan + precondition_rejection_scan
  // + (future) convergent_validity_check into an evaluationEvidence payload
  // that gh_pr_merge accepts.
  EVALUATE_PR_VIA_INTERNAL_IDIOMS_TEMPLATE,
  // orthogonal-pattern observer (2026-06-01): composes resolver_pattern_report
  // + trace_failure_pattern_report and LLM-synthesizes MODIFY /
  // CREATE_DETECTOR / CREATE_CONSUMER decisions for the catalogue. Compose-
  // only — adds no resolver code.
  OBSERVE_ORTHOGONAL_PATTERNS_TEMPLATE,
  // enact-orthogonal-decisions (2026-06-01): closes the meta-loop by reading
  // the latest orthogonal observation, synthesizing a failure-mode-style
  // scenario for the highest-priority CREATE_DETECTOR/CREATE_CONSUMER
  // decision, and dispatching draft-gap-closing-activity. MODIFY decisions
  // are surfaced as pendingModifyDecision context for future handling.
  // Compose-only — adds no resolver code.
  ENACT_ORTHOGONAL_DECISIONS_TEMPLATE,
  // Lift-iter (2026-06-02): complete-vessel-scaffold writes the full canonical
  // vessel structure (extends scaffold-new-vessel from 4 files → 7 files,
  // adding src/index.ts, src/discovery-registration.ts, and the systemd unit).
  COMPLETE_VESSEL_SCAFFOLD_TEMPLATE,
  // Lift-iter (2026-06-02): scaffold-and-publish-vessel composes the full
  // vessel scaffold with the substrate-as-git-author publication chain —
  // git_branch_create + git_add + git_commit + git_push + gh_pr_create.
  // Mirrors publish-substrate-authored-artifact safety gates for vessel scope.
  SCAFFOLD_AND_PUBLISH_VESSEL_TEMPLATE,
  // Goal-alignment fix (2026-06-03): single-resolver wrapper for goal[12]
  // so its open-ended text routes to a deterministic vessel_demand_report
  // dispatch instead of LLM-reuse picking the closest semantic match.
  VESSEL_DEMAND_TICK_TEMPLATE,
  // Autonomous self-modification loop (2026-06-03): scaffold-mitosis-track
  // composes concept_select_for_prompt + fs_read + llm_completion_dispatch +
  // vessel_mitosis_start. Boredom goal[13] dispatches this when
  // code_needs_report surfaces a MODIFY decision. The substrate observes the
  // need, drafts a parallel-track fix, and produces a vesselMitosisInitiated
  // artifact as a side effect of normal operation.
  SCAFFOLD_MITOSIS_TRACK_TEMPLATE,
  // Durability (iter 2026-06-03): backend-snapshot-to-git dumps SurrealDB
  // tables to /workspace/snapshots/<TS>/ (bind-mounted, survives container
  // destruction) and commits a small manifest to git. Goal[14] dispatches
  // this on the boredom timer. Closes Gap A.
  BACKEND_SNAPSHOT_TO_GIT_TEMPLATE,
  // New-vessel-repo capability (iter 2026-06-03): vessel-repo-promote creates
  // a standalone GitHub repo for a substrate-authored vessel via
  // gh_repo_create and commits a finding-style record. Closes Gap B; the
  // submodule pointer conversion is deferred to a follow-up.
  VESSEL_REPO_PROMOTE_TEMPLATE,
  // Autonomous mitosis evaluate+cutover (iter 2026-06-03): mitosis-tick reads
  // /workspace/mitosis-pending.json, dispatches vessel_mitosis_evaluate, then
  // unconditionally dispatches vessel_mitosis_cutover (which self-refuses
  // unless verdict=FAVORABLE). Boredom goal[15] fires this on cadence. After
  // this iteration the lift loop (detect → modify → evaluate → cutover) has
  // no operator hand in the modify path.
  MITOSIS_TICK_TEMPLATE,
  // Concept-db relevance writeback (iter 2026-06-03): unblocks the
  // (ts+1)/(tl+2) Bayesian relevance signal that's currently one-sided
  // (29/37 concepts have times_loaded > 0; only 6 have times_succeeded > 0
  // from a manual backfill; ZERO autonomous traces invoke concept_usage_record).
  // Boredom goal[16] dispatches this on cadence with a rotating query so
  // different concepts get exercised. Single resolver chain + deterministic;
  // no LLM, no pool iteration. The resolver concept_usage_record already
  // exists (5/5 tests green); this is the missing dispatcher.
  CONCEPT_USAGE_BACKFILL_TEMPLATE,
  // Horizon-detector ticks (Stage 1 of openspec change
  // 2026-06-03-pre-lift-bootstrap-and-architecture-aware-loop): four
  // single-task wrappers around the architecture-aware horizon detectors.
  // Boredom goals [17..20] explicitly target these so the goal text routes
  // deterministically to the resolver dispatch.
  VESSEL_RESPONSIBILITY_AUDIT_TICK_TEMPLATE,
  VESSEL_ARCHITECTURE_PATTERN_SCAN_TICK_TEMPLATE,
  ACTIVITY_LIFECYCLE_AUDIT_TICK_TEMPLATE,
  RESOLVER_DISTRIBUTION_AUDIT_TICK_TEMPLATE,
  // Gap-drain bridges (2026-06-04): wire detector-emitted + operator-seeded
  // substrateGap impulses into the drafter, and seed Thompson posteriors for
  // newly-authored gap-closing:auto-* templates so they actually execute.
  GAP_TO_SCENARIO_BRIDGE_TICK_TEMPLATE,
  DISPATCH_LATEST_AUTO_DRAFT_TEMPLATE,
  // apply-proposal-as-patch (Break 3 close, 2026-06-04). Converts the newest
  // unstaged drafter proposal into a staged mitosis directory the existing
  // cutover machinery can apply. Closes the gap between drafter analysis and
  // real-source patching — the missing link between "describe remediation"
  // and "enact remediation".
  APPLY_PROPOSAL_AS_PATCH_TEMPLATE,
  // mechanism-health-tick detection loop (2026-06-04). Three generic detectors
  // (substrate anchors concept_9L8PB5tQzc7l / concept_7_yVEeVfMKQV /
  // concept_-rQijiezhmMZ) and the aggregator (concept_q2n0_XaSvphV) that
  // composes them against the M1/M2/M3/M4/M6 observable surface. Boredom-
  // vessel dispatches mechanism-health-tick on cadence so detection runs
  // autonomously without operator probes.
  DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE,
  DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE,
  DETECT_FILTER_SATURATION_TEMPLATE,
  MECHANISM_HEALTH_TICK_TEMPLATE,
  // obsidian-vessel interaction self-test (2026-06-04): drives the plugin over
  // HTTP (health + observations/status + actions/sync + observations/concept-status)
  // with 5s timeouts and synthesizes a structured obsidianVesselInteractionReport
  // identifying live endpoints, missing endpoints (404), concept-graph coverage
  // metrics, missing capabilities, and prioritised recommendations.
  VALIDATE_OBSIDIAN_VESSEL_INTERACTION_TEMPLATE,
  // Goal recovery activities (2026-06-04): idiomatic composable replacements for
  // goal-host's autoDraft path. All three are standalone-composable AND wire
  // together as a pre-check → execute → recover chain.
  //   goal-shape-pre-check: deterministic gate — verifies template output_shapes
  //     intersect with expected_output_shapes before any execution cost is incurred.
  //     Verdict 'fail' propagates verifier_negative via forbiddenPattern guard.
  //   recover-from-goal-failure: given a failed trace ID, extracts failure_mode
  //     context and dispatches the appropriate recovery (sub-goal, re-dispatch,
  //     create_variant, or give_up) to goal-host-vessel.
  //   goal-execution-with-retry: full orchestrator — recommend → execute → evaluate
  //     → recover → compile. Thompson Sampling drives template selection; exclude
  //     list accumulates failed templates; autoDraft never fires.
  GOAL_SHAPE_PRE_CHECK_TEMPLATE,
  RECOVER_FROM_GOAL_FAILURE_TEMPLATE,
  GOAL_EXECUTION_WITH_RETRY_TEMPLATE,
  // Template-mitosis variant-authoring loop (2026-06-04). Boredom goal[25]
  // dispatches this; the chain detects the weakest family and authors an
  // improved variant via the write-scope activity_create_variant resolver.
  // No admin-scope mutation — Thompson Sampling does the promotion.
  TEMPLATE_MITOSIS_TICK_TEMPLATE,
  // Substrate-managed template-lifecycle back-half (2026-06-04). Composes
  // templateAuditReport.strongest_families → variant_promote, issuing
  // activityTemplate_update + activityTemplate_deprecate with Thompson
  // evidence. activity-api's evidence gate admits the write-scope calls
  // when loser_samples >= 10 AND posterior delta >= 0.15. The substrate
  // now manages its own template lifecycle end-to-end (mint via
  // template-mitosis-tick, promote+retire via template-promote-tick).
  TEMPLATE_PROMOTE_TICK_TEMPLATE,
  // Substrate-detected novel-failure-mode discovery (2026-06-04). Closes the
  // meta-recursion gap: substrate scans failure traces for embeddings that are
  // orthogonal (max cosine similarity < threshold) to every existing
  // architectural_pattern_principle, clusters them, and emits substrateGap
  // impulses (category=novel_failure_mode_detected) that feed the drafter on
  // the next gap-drain cycle. Goal slot wired in boredom-vessel; cheap-tier
  // (no LLM, HTTP-only).
  VECTOR_SPACE_ORTHOGONALITY_AUDIT_TICK_TEMPLATE,
  // Substrate trace-recording correctness audits (2026-06-05). Closes a
  // recursion gap surfaced by the apply-proposal-as-patch echo chamber
  // (commit a0f9f593): substrate should detect status/outcome mismatches in
  // its own learning records via activities, not via operator log-scraping.
  // trace-outcome-validity inspects per-trace tail shape vs status; posterior-
  // consistency cross-checks claimed α/β against empirical trace counts. Both
  // cheap-tier (HTTP-only, no LLM).
  TRACE_OUTCOME_VALIDITY_AUDIT_TICK_TEMPLATE,
  POSTERIOR_CONSISTENCY_AUDIT_TICK_TEMPLATE,
  // Meta-cognition bootstrap (2026-06-05). capability-gap-audit-tick scans
  // failure traces for missing-capability signatures and emits substrateGap.
  // resolver-author consumes those gaps and produces a 4-file new-resolver
  // patch (resolver + test + config-patched + impulses-patched) via the
  // apply_proposal_as_patch multifile branch. Boredom goal[29] dispatches the
  // audit tick; the authoring template is dispatchable on demand or via a
  // future drain-pending-capability-gaps activity.
  CAPABILITY_GAP_AUDIT_TICK_TEMPLATE,
  RESOLVER_AUTHOR_TEMPLATE,
  // Shadow-state observer ticks (Part B, 2026-06-05). Each promotes one
  // out-of-band substrate state into a shape-typed impulse so the
  // orthogonality / validation audits can observe it. All immunity-pattern
  // single-resolver wrappers (empty inputShapes + variables = precondition
  // always satisfied), light-dispatch eligible, cheap tier.
  SYSTEMD_UNIT_HEALTH_OBSERVER_TICK_TEMPLATE,
  MITOSIS_INTENT_QUEUE_OBSERVER_TICK_TEMPLATE,
  APPLIED_PROPOSAL_SENTINEL_OBSERVER_TICK_TEMPLATE,
  MITOSIS_PENDING_OBSERVER_TICK_TEMPLATE,
  DISPATCH_DROPPED_OBSERVER_TICK_TEMPLATE,
  LLM_API_HEALTH_OBSERVER_TICK_TEMPLATE,
  // Round 2 shadow-state observers (2026-06-05): host-container source
  // drift, disk pressure, concept-db health, discovery-registry staleness,
  // substrate-heartbeat liveness, LLM-quota traces. Together with round 1
  // they close the 12-observer impulse-coverage surface.
  HOST_CONTAINER_SOURCE_DRIFT_OBSERVER_TICK_TEMPLATE,
  DISK_SPACE_OBSERVER_TICK_TEMPLATE,
  WORKSPACE_HYGIENE_OBSERVER_TICK_TEMPLATE,
  PRUNE_STALE_MITOSIS_TICK_TEMPLATE,
  LEARNING_SIGNAL_HEALTH_OBSERVER_TICK_TEMPLATE,
  SELECTOR_SATURATION_AUDIT_TICK_TEMPLATE,
  CONCEPT_DB_HEALTH_OBSERVER_TICK_TEMPLATE,
  DISCOVERY_VESSEL_REGISTRY_OBSERVER_TICK_TEMPLATE,
  SUBSTRATE_HEARTBEAT_OBSERVER_TICK_TEMPLATE,
  LLM_QUOTA_OBSERVER_TICK_TEMPLATE,
  // push-health observer (2026-06-19): surfaces substrate self-push failure.
  PUSH_HEALTH_OBSERVER_TICK_TEMPLATE,
];
