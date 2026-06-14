import { Hono } from "hono";
import { resolveGitStatus } from "../resolvers/git-status.js";
import { resolveGitAdd } from "../resolvers/git-add.js";
import { resolveGitCommit } from "../resolvers/git-commit.js";
import { resolveGitDiff } from "../resolvers/git-diff.js";
import { resolveGitLog } from "../resolvers/git-log.js";
import { resolveFsRead } from "../resolvers/fs-read.js";
import { resolveFsWrite } from "../resolvers/fs-write.js";
import { resolveFsEdit } from "../resolvers/fs-edit.js";
import { resolveActivityFetch } from "../resolvers/activity-fetch.js";
import { resolveActivityCreateVariant } from "../resolvers/activity-create-variant.js";
import { resolveVesselRegisterPassthrough } from "../resolvers/vessel-register-passthrough.js";
import { resolveCodeIntrospect } from "../resolvers/code-introspect.js";
import { resolvePropagateJudgment } from "../resolvers/propagate-judgment.js";
import { resolveLiftDemoNoop } from "../resolvers/lift-demo-noop.js";
import { resolveLlmCompletionDispatch } from "../resolvers/llm-completion-dispatch.js";
import { resolveJsonPathExtract } from "../resolvers/json-path-extract.js";
import { resolveActivityRecommend } from "../resolvers/activity-recommend.js";
import { resolveActivityDiscoverByShapes } from "../resolvers/activity-discover-by-shapes.js";
import { resolveSystemdRestart } from "../resolvers/systemd-restart.js";
import { resolveLearnedTopologySnapshot } from "../resolvers/learned-topology-snapshot.js";
import { resolveReachableUnlearnedReport } from "../resolvers/reachable-unlearned-report.js";
import { resolveUnknownShapeReport } from "../resolvers/unknown-shape-report.js";
import { resolveCoverageTick } from "../resolvers/coverage-tick.js";
import { resolveSubstrateHealthTick } from "../resolvers/substrate-health-tick.js";
import { resolveFailureModeMatrixScore } from "../resolvers/failure-mode-matrix-score.js";
import { resolveBoredomEnqueue } from "../resolvers/boredom-enqueue.js";
import { resolveMemoryNote, resolveMemoryNoteWrite } from "../resolvers/memory-note.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "../resolvers/substrate-gap.js";
import { resolveFsList } from "../resolvers/fs-list.js";
import { resolveFsGrep } from "../resolvers/fs-grep.js";
import { resolveHttpFetch } from "../resolvers/http-fetch.js";
import { resolveResolverPatternReport } from "../resolvers/resolver-pattern-report.js";
import { resolveMarkdownSplitSections } from "../resolvers/markdown-split-sections.js";
import { resolveStalePointerEmit } from "../resolvers/stale-pointer-emit.js";
import { resolvePhantomTraceScan } from "../resolvers/phantom-trace-scan.js";
import { resolveConvergentValidityCheck } from "../resolvers/convergent-validity-check.js";
import { resolveTraceFailurePatternReport } from "../resolvers/trace-failure-pattern-report.js";
import { resolveSystemLoadReport } from "../resolvers/system-load-report.js";
import { resolveLoadAttribution, resolveLoadAttributionWrite } from "../resolvers/load-attribution.js";
import { resolveLoadAttributionReport } from "../resolvers/load-attribution-report.js";
import { resolvePreconditionRejectionScan } from "../resolvers/precondition-rejection-scan.js";
import { resolveDispatchTargetDriftScan } from "../resolvers/dispatch-target-drift-scan.js";
import { resolveServiceOomCascadeScan } from "../resolvers/service-oom-cascade-scan.js";
import { resolveComprehensibilityCheck } from "../resolvers/comprehensibility-check.js";
import { resolveGhPrMerge } from "../resolvers/gh-pr-merge.js";
import { resolveGitBranchCreate } from "../resolvers/git-branch-create.js";
import { resolveGitPush } from "../resolvers/git-push.js";
import { resolveGhPrCreate } from "../resolvers/gh-pr-create.js";
import { resolveComputeStateSignature } from "../resolvers/compute-state-signature.js";
import { resolveAuthoringChainHealthReport } from "../resolvers/authoring-chain-health-report.js";
import { resolveConceptWrite } from "../resolvers/concept-write.js";
import { resolveConceptSearchBySource } from "../resolvers/concept-search-by-source.js";
import { resolveConceptSelectForPrompt } from "../resolvers/concept-select-for-prompt.js";
import { resolveCodeNeedsReport } from "../resolvers/code-needs-report.js";
import { resolveConceptUsageRecord } from "../resolvers/concept-usage-record.js";
import { resolveUiWritePassthrough } from "../resolvers/ui-write-passthrough.js";
import { resolveInteractorWrite, type InteractorWriteShape } from "../resolvers/interactor-passthrough.js";
import {
  resolveInterventionEvaluate,
  resolveInterventionRefused,
  resolveInterventionRefusedWrite,
} from "../resolvers/intervention-evaluate.js";
import { resolveCompositionCoverageReport } from "../resolvers/composition-coverage-report.js";
import { resolveVesselCompletenessReport } from "../resolvers/vessel-completeness-report.js";
import { resolveTemplateInvocationHistoryReport } from "../resolvers/template-invocation-history-report.js";
import { resolveVesselDemandReport } from "../resolvers/vessel-demand-report.js";
import { resolveVesselMitosisStart } from "../resolvers/vessel-mitosis-start.js";
import { resolveVesselMitosisEvaluate } from "../resolvers/vessel-mitosis-evaluate.js";
import {
  resolveVesselMitosisCutover,
  resolveCutoverApplied,
} from "../resolvers/vessel-mitosis-cutover.js";
import { resolveSurrealdbExport } from "../resolvers/surrealdb-export.js";
import { resolveSurrealdbImport } from "../resolvers/surrealdb-import.js";
import { resolveGhRepoCreate } from "../resolvers/gh-repo-create.js";
import { resolveVesselResponsibilityAudit } from "../resolvers/vessel-responsibility-audit.js";
import { resolveVesselArchitecturePatternScan } from "../resolvers/vessel-architecture-pattern-scan.js";
import { resolveActivityLifecycleAudit } from "../resolvers/activity-lifecycle-audit.js";
import { resolveResolverDistributionAudit } from "../resolvers/resolver-distribution-audit.js";
import { resolveGapToScenarioBridge } from "../resolvers/gap-to-scenario-bridge.js";
import { resolveDispatchLatestAutoDraft } from "../resolvers/dispatch-latest-auto-draft.js";
import { resolveApplyProposalAsPatch } from "../resolvers/apply-proposal-as-patch.js";
import { resolvePatchWithTools } from "../resolvers/patch-with-tools.js";
import { resolveTemplateAuditReport } from "../resolvers/template-audit-report.js";
import { resolveVariantPromote } from "../resolvers/variant-promote.js";
import { resolveVectorSpaceOrthogonalityAudit } from "../resolvers/vector-space-orthogonality-audit.js";
import { resolveTraceOutcomeValidityAudit } from "../resolvers/trace-outcome-validity-audit.js";
import { resolvePosteriorConsistencyAudit } from "../resolvers/posterior-consistency-audit.js";
import { resolveCapabilityGapAudit } from "../resolvers/capability-gap-audit.js";
import { resolveSystemdUnitHealthObserver } from "../resolvers/systemd-unit-health-observer.js";
import { resolveMitosisIntentQueueObserver } from "../resolvers/mitosis-intent-queue-observer.js";
import { resolveAppliedProposalSentinelObserver } from "../resolvers/applied-proposal-sentinel-observer.js";
import { resolveMitosisPendingObserver } from "../resolvers/mitosis-pending-observer.js";
import { resolveDispatchDroppedObserver } from "../resolvers/dispatch-dropped-observer.js";
import { resolveLlmApiHealthObserver } from "../resolvers/llm-api-health-observer.js";
import { resolveHostContainerSourceDriftObserver } from "../resolvers/host-container-source-drift-observer.js";
import { resolveDiskSpaceObserver } from "../resolvers/disk-space-observer.js";
import { resolveWorkspaceHygieneObserver } from "../resolvers/workspace-hygiene-observer.js";
import { resolvePruneStaleMitosis } from "../resolvers/prune-stale-mitosis.js";
import { resolveLearningSignalHealthObserver } from "../resolvers/learning-signal-health-observer.js";
import { resolveCreditPrimedConcepts } from "../resolvers/credit-primed-concepts.js";
import { resolveConceptDbHealthObserver } from "../resolvers/concept-db-health-observer.js";
import { resolveDiscoveryVesselRegistryObserver } from "../resolvers/discovery-vessel-registry-observer.js";
import { resolveVesselArrivalScan } from "../resolvers/vessel-arrival-scan.js";
import { resolveCreditVesselShapes } from "../resolvers/credit-vessel-shapes.js";
import { resolveSubstrateHeartbeatObserver } from "../resolvers/substrate-heartbeat-observer.js";
import { resolveLlmQuotaObserver } from "../resolvers/llm-quota-observer.js";
import type { ResolverResult } from "../resolvers/types.js";

type AnyPointer = { type: string } & Record<string, unknown>;

/** Shared dispatch logic — used by both the HTTP route and the CLI. */
export async function resolveDispatch(pointer: AnyPointer): Promise<ResolverResult> {
  const p = pointer as unknown;
  switch (pointer.type) {
    case "lift_demo_noop":
      return resolveLiftDemoNoop();
    case "git_status":
      return resolveGitStatus(p as Parameters<typeof resolveGitStatus>[0]);
    case "git_add":
      return resolveGitAdd(p as Parameters<typeof resolveGitAdd>[0]);
    case "git_commit":
      return resolveGitCommit(p as Parameters<typeof resolveGitCommit>[0]);
    case "git_diff":
      return resolveGitDiff(p as Parameters<typeof resolveGitDiff>[0]);
    case "git_log":
      return resolveGitLog(p as Parameters<typeof resolveGitLog>[0]);
    case "fs_read":
      return resolveFsRead(p as Parameters<typeof resolveFsRead>[0]);
    case "fs_write":
      return resolveFsWrite(p as Parameters<typeof resolveFsWrite>[0]);
    case "fs_edit":
      return resolveFsEdit(p as Parameters<typeof resolveFsEdit>[0]);
    case "activity_fetch":
      return resolveActivityFetch(p as Parameters<typeof resolveActivityFetch>[0]);
    case "activity_create_variant":
      return resolveActivityCreateVariant(p as Parameters<typeof resolveActivityCreateVariant>[0]);
    case "vessel_register_passthrough":
      return resolveVesselRegisterPassthrough(p as Parameters<typeof resolveVesselRegisterPassthrough>[0]);
    case "code_introspect":
      return resolveCodeIntrospect(p as Parameters<typeof resolveCodeIntrospect>[0]);
    case "propagate_judgment":
      return resolvePropagateJudgment(p as Parameters<typeof resolvePropagateJudgment>[0]);
    case "llm_completion_dispatch":
      return resolveLlmCompletionDispatch(p as Parameters<typeof resolveLlmCompletionDispatch>[0]);
    case "json_path_extract":
      return resolveJsonPathExtract(p as Parameters<typeof resolveJsonPathExtract>[0]);
    case "activity_recommend":
      return resolveActivityRecommend(p as Parameters<typeof resolveActivityRecommend>[0]);
    case "activity_discover_by_shapes":
      return resolveActivityDiscoverByShapes(p as Parameters<typeof resolveActivityDiscoverByShapes>[0]);
    case "systemd_restart":
      return resolveSystemdRestart(p as Parameters<typeof resolveSystemdRestart>[0]);
    case "learned_topology_snapshot":
      return resolveLearnedTopologySnapshot(p as Parameters<typeof resolveLearnedTopologySnapshot>[0]);
    case "reachable_unlearned_report":
      return resolveReachableUnlearnedReport(p as Parameters<typeof resolveReachableUnlearnedReport>[0]);
    case "unknown_shape_report":
      return resolveUnknownShapeReport(p as Parameters<typeof resolveUnknownShapeReport>[0]);
    case "coverage_tick":
      return resolveCoverageTick(p as Parameters<typeof resolveCoverageTick>[0]);
    case "substrate_health_tick":
      return resolveSubstrateHealthTick(p as Parameters<typeof resolveSubstrateHealthTick>[0]);
    case "failure_mode_matrix_score":
      return resolveFailureModeMatrixScore(p as Parameters<typeof resolveFailureModeMatrixScore>[0]);
    case "boredom_enqueue":
      return resolveBoredomEnqueue(p as Parameters<typeof resolveBoredomEnqueue>[0]);
    case "memoryNote":
      return resolveMemoryNote(p as Parameters<typeof resolveMemoryNote>[0]);
    case "memoryNote_write":
      return resolveMemoryNoteWrite(p as Parameters<typeof resolveMemoryNoteWrite>[0]);
    case "substrateGap":
      return resolveSubstrateGap(p as Parameters<typeof resolveSubstrateGap>[0]);
    case "substrateGap_write":
      return resolveSubstrateGapWrite(p as Parameters<typeof resolveSubstrateGapWrite>[0]);
    case "fs_list":
      return resolveFsList(p as Parameters<typeof resolveFsList>[0]);
    case "fs_grep":
      return resolveFsGrep(p as Parameters<typeof resolveFsGrep>[0]);
    case "http_fetch":
      return resolveHttpFetch(p as Parameters<typeof resolveHttpFetch>[0]);
    case "resolver_pattern_report":
      return resolveResolverPatternReport(p as Parameters<typeof resolveResolverPatternReport>[0]);
    case "markdown_split_sections":
      return resolveMarkdownSplitSections(p as Parameters<typeof resolveMarkdownSplitSections>[0]);
    case "stale_pointer_emit":
      return resolveStalePointerEmit(p as Parameters<typeof resolveStalePointerEmit>[0]);
    case "phantom_trace_scan":
      return resolvePhantomTraceScan(p as Parameters<typeof resolvePhantomTraceScan>[0]);
    case "convergent_validity_check":
      return resolveConvergentValidityCheck(p as Parameters<typeof resolveConvergentValidityCheck>[0]);
    case "trace_failure_pattern_report":
      return resolveTraceFailurePatternReport(p as Parameters<typeof resolveTraceFailurePatternReport>[0]);
    case "system_load_report":
      return resolveSystemLoadReport(p as Parameters<typeof resolveSystemLoadReport>[0]);
    case "loadAttribution":
      return resolveLoadAttribution(p as Parameters<typeof resolveLoadAttribution>[0]);
    case "loadAttribution_write":
      return resolveLoadAttributionWrite(p as Parameters<typeof resolveLoadAttributionWrite>[0]);
    case "load_attribution_report":
      return resolveLoadAttributionReport(p as Parameters<typeof resolveLoadAttributionReport>[0]);
    case "dispatch_target_drift_scan":
      return resolveDispatchTargetDriftScan(p as Parameters<typeof resolveDispatchTargetDriftScan>[0]);
    case "service_oom_cascade_scan":
      return resolveServiceOomCascadeScan(p as Parameters<typeof resolveServiceOomCascadeScan>[0]);
    case "precondition_rejection_scan":
      return resolvePreconditionRejectionScan(p as Parameters<typeof resolvePreconditionRejectionScan>[0]);
    case "comprehensibility_check":
      return resolveComprehensibilityCheck(p as Parameters<typeof resolveComprehensibilityCheck>[0]);
    case "git_branch_create":
      return resolveGitBranchCreate(p as Parameters<typeof resolveGitBranchCreate>[0]);
    case "git_push":
      return resolveGitPush(p as Parameters<typeof resolveGitPush>[0]);
    case "gh_pr_create":
      return resolveGhPrCreate(p as Parameters<typeof resolveGhPrCreate>[0]);
    case "gh_pr_merge":
      return resolveGhPrMerge(p as Parameters<typeof resolveGhPrMerge>[0]);
    case "compute_state_signature":
      return resolveComputeStateSignature(p as Parameters<typeof resolveComputeStateSignature>[0]);
    case "authoring_chain_health_report":
      return resolveAuthoringChainHealthReport(p as Parameters<typeof resolveAuthoringChainHealthReport>[0]);
    case "concept_write":
      return resolveConceptWrite(p as Parameters<typeof resolveConceptWrite>[0]);
    case "concept_search_by_source":
      return resolveConceptSearchBySource(p as Parameters<typeof resolveConceptSearchBySource>[0]);
    case "concept_select_for_prompt":
      return resolveConceptSelectForPrompt(p as Parameters<typeof resolveConceptSelectForPrompt>[0]);
    case "code_needs_report":
      return resolveCodeNeedsReport(p as Parameters<typeof resolveCodeNeedsReport>[0]);
    case "concept_usage_record":
      return resolveConceptUsageRecord(p as Parameters<typeof resolveConceptUsageRecord>[0]);
    case "uiPanel_write":
    case "uiQuestion_write":
      return resolveUiWritePassthrough(p as Parameters<typeof resolveUiWritePassthrough>[0]);
    case "uiFeedback_write":
    case "interactorEvent_write":
    case "interactorAssertion_write":
    case "interactorDismiss_write":
    case "interactorAttachment_write":
      return resolveInteractorWrite(p as { type: InteractorWriteShape } & Record<string, unknown>);
    case "intervention_evaluate":
      return resolveInterventionEvaluate(p as Parameters<typeof resolveInterventionEvaluate>[0]);
    case "interventionRefused":
      return resolveInterventionRefused(p as Parameters<typeof resolveInterventionRefused>[0]);
    case "interventionRefused_write":
      return resolveInterventionRefusedWrite(p as Parameters<typeof resolveInterventionRefusedWrite>[0]);
    case "composition_coverage_report":
      return resolveCompositionCoverageReport(p as Parameters<typeof resolveCompositionCoverageReport>[0]);
    case "vessel_completeness_report":
      return resolveVesselCompletenessReport(p as Parameters<typeof resolveVesselCompletenessReport>[0]);
    case "template_invocation_history_report":
      return resolveTemplateInvocationHistoryReport(p as Parameters<typeof resolveTemplateInvocationHistoryReport>[0]);
    case "vessel_demand_report":
      return resolveVesselDemandReport(p as Parameters<typeof resolveVesselDemandReport>[0]);
    case "vessel_mitosis_start":
      return resolveVesselMitosisStart(p as Parameters<typeof resolveVesselMitosisStart>[0]);
    case "vessel_mitosis_evaluate":
      return resolveVesselMitosisEvaluate(p as Parameters<typeof resolveVesselMitosisEvaluate>[0]);
    case "vessel_mitosis_cutover":
      return resolveVesselMitosisCutover(p as Parameters<typeof resolveVesselMitosisCutover>[0]);
    case "cutoverApplied":
      return resolveCutoverApplied(p as Parameters<typeof resolveCutoverApplied>[0]);
    case "surrealdb_export":
      return resolveSurrealdbExport(p as Parameters<typeof resolveSurrealdbExport>[0]);
    case "surrealdb_import":
      return resolveSurrealdbImport(p as Parameters<typeof resolveSurrealdbImport>[0]);
    case "gh_repo_create":
      return resolveGhRepoCreate(p as Parameters<typeof resolveGhRepoCreate>[0]);
    case "vessel_responsibility_audit":
      return resolveVesselResponsibilityAudit(
        p as Parameters<typeof resolveVesselResponsibilityAudit>[0],
      );
    case "vessel_architecture_pattern_scan":
      return resolveVesselArchitecturePatternScan(
        p as Parameters<typeof resolveVesselArchitecturePatternScan>[0],
      );
    case "activity_lifecycle_audit":
      return resolveActivityLifecycleAudit(
        p as Parameters<typeof resolveActivityLifecycleAudit>[0],
      );
    case "resolver_distribution_audit":
      return resolveResolverDistributionAudit(
        p as Parameters<typeof resolveResolverDistributionAudit>[0],
      );
    case "gap_to_scenario_bridge":
      return resolveGapToScenarioBridge(
        p as Parameters<typeof resolveGapToScenarioBridge>[0],
      );
    case "dispatch_latest_auto_draft":
      return resolveDispatchLatestAutoDraft(
        p as Parameters<typeof resolveDispatchLatestAutoDraft>[0],
      );
    case "apply_proposal_as_patch":
      return resolveApplyProposalAsPatch(
        p as Parameters<typeof resolveApplyProposalAsPatch>[0],
      );
    case "patch_with_tools":
      return resolvePatchWithTools(
        p as Parameters<typeof resolvePatchWithTools>[0],
      );
    case "template_audit_report":
      return resolveTemplateAuditReport(
        p as Parameters<typeof resolveTemplateAuditReport>[0],
      );
    case "variant_promote":
      return resolveVariantPromote(
        p as Parameters<typeof resolveVariantPromote>[0],
      );
    case "vector_space_orthogonality_audit":
      return resolveVectorSpaceOrthogonalityAudit(
        p as Parameters<typeof resolveVectorSpaceOrthogonalityAudit>[0],
      );
    case "trace_outcome_validity_audit":
      return resolveTraceOutcomeValidityAudit(
        p as Parameters<typeof resolveTraceOutcomeValidityAudit>[0],
      );
    case "posterior_consistency_audit":
      return resolvePosteriorConsistencyAudit(
        p as Parameters<typeof resolvePosteriorConsistencyAudit>[0],
      );
    case "capability_gap_audit":
      return resolveCapabilityGapAudit(
        p as Parameters<typeof resolveCapabilityGapAudit>[0],
      );
    case "systemd_unit_health_observer":
      return resolveSystemdUnitHealthObserver(
        p as Parameters<typeof resolveSystemdUnitHealthObserver>[0],
      );
    case "mitosis_intent_queue_observer":
      return resolveMitosisIntentQueueObserver(
        p as Parameters<typeof resolveMitosisIntentQueueObserver>[0],
      );
    case "applied_proposal_sentinel_observer":
      return resolveAppliedProposalSentinelObserver(
        p as Parameters<typeof resolveAppliedProposalSentinelObserver>[0],
      );
    case "mitosis_pending_observer":
      return resolveMitosisPendingObserver(
        p as Parameters<typeof resolveMitosisPendingObserver>[0],
      );
    case "dispatch_dropped_observer":
      return resolveDispatchDroppedObserver(
        p as Parameters<typeof resolveDispatchDroppedObserver>[0],
      );
    case "llm_api_health_observer":
      return resolveLlmApiHealthObserver(
        p as Parameters<typeof resolveLlmApiHealthObserver>[0],
      );
    case "host_container_source_drift_observer":
      return resolveHostContainerSourceDriftObserver(
        p as Parameters<typeof resolveHostContainerSourceDriftObserver>[0],
      );
    case "disk_space_observer":
      return resolveDiskSpaceObserver(
        p as Parameters<typeof resolveDiskSpaceObserver>[0],
      );
    case "workspace_hygiene_observer":
      return resolveWorkspaceHygieneObserver(
        p as Parameters<typeof resolveWorkspaceHygieneObserver>[0],
      );
    case "prune_stale_mitosis":
      return resolvePruneStaleMitosis(
        p as Parameters<typeof resolvePruneStaleMitosis>[0],
      );
    case "learning_signal_health_observer":
      return resolveLearningSignalHealthObserver(
        p as Parameters<typeof resolveLearningSignalHealthObserver>[0],
      );
    case "credit_primed_concepts":
      return resolveCreditPrimedConcepts(
        p as Parameters<typeof resolveCreditPrimedConcepts>[0],
      );
    case "concept_db_health_observer":
      return resolveConceptDbHealthObserver(
        p as Parameters<typeof resolveConceptDbHealthObserver>[0],
      );
    case "discovery_vessel_registry_observer":
      return resolveDiscoveryVesselRegistryObserver(
        p as Parameters<typeof resolveDiscoveryVesselRegistryObserver>[0],
      );
    case "substrate_heartbeat_observer":
      return resolveSubstrateHeartbeatObserver(
        p as Parameters<typeof resolveSubstrateHeartbeatObserver>[0],
      );
    case "llm_quota_observer":
      return resolveLlmQuotaObserver(
        p as Parameters<typeof resolveLlmQuotaObserver>[0],
      );
    case "vessel_arrival_scan":
      return resolveVesselArrivalScan(
        p as Parameters<typeof resolveVesselArrivalScan>[0],
      );
    case "credit_vessel_shapes":
      return resolveCreditVesselShapes(
        p as Parameters<typeof resolveCreditVesselShapes>[0],
      );
    default:
      throw new Error(`unknown shape: ${pointer.type}`);
  }
}

export const impulsesRouter = new Hono();

/**
 * Vessel-proxy adapter endpoint.
 *
 * VesselResolverProxy in minibob calls POST /resolvers/execute with:
 *   { resolver: string, impulseRefs: ImpulseRef[], config: Record<string,unknown> }
 * and expects back:
 *   { impulses: Impulse[] }
 *
 * This adapts the minibob vessel-proxy wire format to dev-vessel's own
 * resolver dispatch logic and wraps the result as a single-item impulses array.
 */
impulsesRouter.post("/resolvers/execute", async (c) => {
  let body: { resolver?: string; impulseRefs?: unknown[]; config?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const resolverName = body?.resolver;
  if (!resolverName) {
    return c.json({ error: "resolver field is required" }, 400);
  }

  try {
    const pointer = { ...(body.config ?? {}), type: resolverName };
    const result = await resolveDispatch(pointer as { type: string } & Record<string, unknown>);
    const content = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    const impulse = {
      id: `dv-resolver-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      pointer: { type: "memo", content },
      content,
      loaded: true,
      budget: Math.ceil(content.length / 4),
      priority: "high" as const,
      metadata: { shape: result.shape },
      createdAt: Date.now(),
    };
    return c.json({ impulses: [impulse] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

impulsesRouter.post("/v2/impulses/resolve", async (c) => {
  let body: { impulse?: { type?: string; pointer?: { type?: string } } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }

  const pointer = body?.impulse?.pointer ?? body?.impulse;
  const pointerType = pointer?.type ?? body?.impulse?.type;

  if (!pointerType) {
    return c.json({ success: false, error: "pointer.type is required" }, 400);
  }

  try {
    const result = await resolveDispatch({ ...(pointer as Record<string, unknown>), type: pointerType });
    // Wire-level boundary lie fix (V1, 2026-06-06): a resolver that returns
    // shape:"structuredError" is signalling a substantive failure (missing
    // required field, vessel-not-found, etc). The HTTP envelope must reflect
    // that — otherwise callers (boredom, light-dispatch, the probe harness)
    // that trust `success:true` record Thompson wins for what is actually a
    // failure. Phase 2 probe observed this exact pattern on
    // vessel_mitosis_cutover: success=true + shape=structuredError + zero
    // intents emitted. Soft-refuse paths (e.g. vesselMitosisCutoverResult
    // with applied:false) remain success:true — they are audited NOs, not
    // boundary lies.
    if (result.shape === "structuredError") {
      const detail =
        (result.body as Record<string, unknown> | undefined)?.["detail"];
      return c.json({
        success: false,
        shape: result.shape,
        body: result.body,
        error: typeof detail === "string" ? detail : "structuredError",
      });
    }
    return c.json({ success: true, shape: result.shape, body: result.body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unknown shape:")) {
      return c.json({ success: false, error: message }, 400);
    }
    return c.json({ success: false, error: message }, 500);
  }
});
