export const VESSEL_ID = process.env["VESSEL_ID"] ?? `development-vessel-${process.env["HOSTNAME"] ?? "local"}`;
export const PORT = parseInt(process.env["PORT"] ?? "8090", 10);
export const HOST = process.env["HOST"] ?? "0.0.0.0";

export const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
export const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
export const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
export const GOAL_HOST_VESSEL_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
export const CONCEPT_DB_ENDPOINT = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";

export const WORKSPACE_ROOT = process.env["WORKSPACE_ROOT"] ?? process.cwd();

/**
 * Full configuration block. The `discovery.shapes` array is the single source
 * of truth for the vessel's advertised shape contract — `scripts/check-shape-dispatch.ts`
 * (via `bun run lint`) verifies every entry has a matching `case` in
 * `src/routes/impulses.ts` and vice versa.
 *
 * Don't add a shape here without adding a case in the route. Don't add a case
 * in the route without adding the shape here. The lint gate enforces it.
 */
export const config = {
  vesselId: VESSEL_ID,
  port: PORT,
  host: HOST,
  metabobEndpoint: METABOB_ENDPOINT,
  metabobApiKey: METABOB_API_KEY,
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  workspaceRoot: WORKSPACE_ROOT,
  discovery: {
    // Inline literal so packages/shape-dispatch-check/check.ts can find it.
    // One entry per R2.* resolver in specs/development-vessel/spec.md.
    shapes: [
      "lift_demo_noop",
      "git_status",
      "git_add",
      "git_commit",
      "git_diff",
      "git_log",
      "fs_read",
      "fs_write",
      "fs_edit",
      "activity_fetch",
      "activity_create_variant",
      "vessel_register_passthrough",
      "code_introspect",
      "propagate_judgment",
      "llm_completion_dispatch",
      "json_path_extract",
      "activity_recommend",
      "activity_discover_by_shapes",
      "systemd_restart",
      "learned_topology_snapshot",
      "reachable_unlearned_report",
      "unknown_shape_report",
      "coverage_tick",
      "substrate_health_tick",
      "failure_mode_matrix_score",
      "boredom_enqueue",
      // Memory closure (IAL 27.3.j.1): substrate-resident note store.
      // Read: filter by type/title/provenance. Write: upsert by id.
      // Backed by WORKSPACE_ROOT/memory/notes.json (atomic writes).
      "memoryNote",
      "memoryNote_write",
      // Inv-031 (operator-authorized 71a28d5): substrate-resident gap-statement
      // store. Distinct from memoryNote (problem statement vs candidate answer).
      // Shape primitive only; gap-closing activity lives separately.
      "substrateGap",
      "substrateGap_write",
      // Skill closure (IAL 27.3.j.2): resolver primitives for codebase navigation
      // and outbound HTTP — enables substrate to perform skill-equivalent operations
      // without operator-authored templates.
      "fs_list",
      "http_fetch",
      // Resolver-pattern aggregation (audit inv-028 B): trace-side
      // (resolver_id, output_shape) → success-rate report. Lets ribosome
      // bias future synthesis and makes the F-127 Thompson skew observable.
      "resolver_pattern_report",
      // Deterministic markdown splitter (iter-082, 2026-05-30): chunks docs
      // on H2/H3 headings BEFORE the LLM call so ingest-doc-as-concepts can
      // operate per-section without overflowing Anthropic's 200K prompt cap.
      "markdown_split_sections",
      // Deterministic stale-pointer detector + emitter (iter-082, 2026-05-30):
      // scans concept-db, stats each concept's pointer.path, POSTs substrateGap
      // for missing files. Replaces the prior LLM-heuristic detect-stale-pointer
      // path that overflowed the prompt cap on large concept corpora.
      "stale_pointer_emit",
      // Deterministic phantom-success-trace detector + emitter (2026-05-30):
      // scans recent execution traces for status=success AND task_count=0
      // (the F25 phantom-success-trace signature), POSTs a substrateGap per
      // finding. Companion to detect-stale-pointer; embodies the
      // substrate_self_detection_principle (concept_9ldsmRgqSTd5).
      "phantom_trace_scan",
      // Convergent validity — independent co-occurrence signal from concept-db.
      // Activities insert this as an explicit task after high-stakes resolvers
      // to cross-check that produced shapes match concept-db's learned priors.
      // Returns convergentValidityResult. Non-fatal by default (strict=false).
      "convergent_validity_check",
      // Substrate-self-detection (companion to phantom_trace_scan):
      // groups recent failed traces by (template, first_failed_task) and reports
      // systematic patterns with occurrence ≥ threshold. Output feeds substrate
      // activities that mint substrateGap impulses — the substrate detects its
      // own systematic failures rather than waiting for the operator to read traces.
      "trace_failure_pattern_report",
      // Substrate self-observation of resource state (iter-087, 2026-05-31):
      // reads /proc/loadavg, /proc/meminfo, /sys/fs/cgroup/cpu.stat from inside
      // the container. Without this, resource pathologies (the iter-086 1315%
      // CPU spin) are invisible to the substrate — the detection family queries
      // activity-api/SurrealDB which are the layer pegged by the pathology.
      // Activities compose this with substrateGap_write to detect amplification
      // cascades autonomously.
      "system_load_report",
      // Per-execution load attribution (iter-088, 2026-05-31): boredom-vessel
      // samples system_load_report before/after each goal dispatch and writes
      // one loadAttribution record per dispatch with cpu_usec_delta and
      // mem_bytes_delta. load_attribution_report aggregates by template_id and
      // surfaces spiking templates (≥50% of invocations exceeding cpu threshold)
      // — same group-by-template pattern as trace_failure_pattern_report,
      // applied to resource consumption. Implements
      // concept_QCBqcPjQbdF_ (delta_observation_causal_attribution).
      "loadAttribution",
      "loadAttribution_write",
      "load_attribution_report",
      // Substrate-self-detection (companion to phantom_trace_scan):
      // scans recent execution traces for the pre-flight rejection signature
      // (status=failure + duration<500ms + task_count=0 — the F25 pattern,
      // concept_qcctOLBT5-CL), groups by template_id, and emits one
      // substrateGap impulse per affected template. Constitutional principle
      // concept_9ldsmRgqSTd5 — substrate authors detection templates for
      // observed bug classes rather than only patching instances.
      "precondition_rejection_scan",
      // Deterministic service-level OOM cascade detector + emitter (2026-05-31):
      // scans systemctl-show across substrate vessel units for the cascade
      // signature (rapid restart loop, MemoryCurrent > 4GB absolute, or
      // > 500MB delta since previous scan). One substrateGap_write per
      // affected service. Detects the seven-iteration-unresolved bug class
      // (concept_RYl73llSCGfc, concept_6RwK5H5F28hT, concept_s9ye5GKLw2L8,
      // concept_T-CTTOEl97IM). Immunity-pattern compliant (empty inputShapes,
      // empty variables, single server-side resolver).
      "service_oom_cascade_scan",
      // Deterministic dispatch-target-drift detector + emitter (2026-05-30):
      // probes traces for any target-recording field; if absent, emits a
      // single instrumentation_gap substrateGap; if present, emits one
      // substrateGap per drift. Detection-template-of-detection-templates;
      // embodies the substrate_self_detection_principle (concept_9ldsmRgqSTd5).
      "dispatch_target_drift_scan",
      // Phase 2 of obsidian meta-skill prototype (2026-06-01):
      // permissive-scope authoring gate. LLM is asked to read a template body
      // without its self-description and explain what it does, why, and when
      // useful; answers are compared semantically against the template's own
      // description. Below floor → verifier_negative.comprehensibility_below_floor.
      "comprehensibility_check",
      // Substrate-driven publication primitives (iter-substrate-as-git-author,
      // 2026-06-01): substrate-side resolvers that let the substrate compose
      // its own publication path to dev. git_branch_create refuses branch
      // names outside SUBSTRATE_ALLOWED_BRANCH_PATTERNS env var (default
      // ^(substrate-authored|substrate)/.+$). git_push refuses --force and
      // refuses pushes to main/dev/master/trunk/release. gh_pr_create wraps
      // the GitHub REST pulls endpoint, requires a Substrate-Authored-By
      // trailer in the body, refuses auto-merge. Used together with existing
      // git_add/git_commit/git_status by the publish-substrate-authored-
      // artifact activity composition. No destination paths canonized — the
      // composition carries target_path as a variable.
      "git_branch_create",
      "git_push",
      "gh_pr_create",
      // Substrate self-merge of approved PRs. Refuses merge unless the PR has
      // at least one APPROVED review from a non-substrate identity. The
      // substrate authors + publishes + (after operator approval) merges;
      // operator's role narrows to approve + audit.
      "gh_pr_merge",
      // First substrate state-space signature (iter-state-signature, 2026-06-01):
      // returns stateSpaceSignature combining /proc/loadavg + /proc/meminfo +
      // cgroup mem + recent-trace aggregates (success_rate, phantom_count,
      // precondition_count, top failure_mode) + catalogue counters. Threaded
      // through goal-host dispatches so every trace carries a state_signature
      // tag — the substrate learns how environment affects template choice
      // and template success, not just which template succeeds in the abstract.
      "compute_state_signature",
      // Substrate-self-detection of authoring-chain health (iter-substrate-face-v0.2,
      // 2026-06-02). Classifies recent failures into preflight_rejection (#140),
      // chain_truncation (fm-51), authoring_completed, other_failure, success.
      // Verdict: HEALTHY / DEGRADED / BLOCKED. Lets the substrate detect when
      // both authoring paths are simultaneously broken — the impasse observed
      // when the projection-fix dispatch (9a6b1e0d) wedged.
      "authoring_chain_health_report",
      // Concept-db learning loop (2026-06-03): substrate-side wrappers around
      // concept-db POST /concepts + GET /concepts/search filtered by source_type.
      // The substrate calls concept_search_by_source before authoring a new
      // vessel (read priors) and concept_write after a successful trace (write
      // the new pattern back). source_type values include vessel_construction_pattern
      // and impulse_activity_pattern — the two most relevant for substrate-
      // authored learning. Empirical seeds: 4 vessel_construction_pattern
      // concepts authored 2026-06-03 covering canonical vessel anatomy, the
      // scaffold-and-publish-vessel composition, the three-place rule, and
      // the immunity pattern for detectors.
      "concept_write",
      "concept_search_by_source",
      // Multi-axis prior selection for LLM prompts (2026-06-03). Combines
      // source-type affinity (hard filter), vector-similarity rank, usage
      // success rate, priority, and token economy into combined_score.
      // Greedy budget fill returns selected concepts {id, name, content,
      // why_selected, combined_score} for llm_completion_dispatch to inject
      // as priors. Replaces naive "top-N by similarity" prior dumping.
      "concept_select_for_prompt",
      // Trace→code-needed synthesis (2026-06-03). Reads traces + templates +
      // discovery in parallel; classifies needs into missing_resolver /
      // broken_template / missing_template / (future) missing_vessel /
      // incomplete_vessel. Each entry has a structured action (CREATE / MODIFY
      // / REFACTOR), cited evidence, and priority_score. This is the
      // resolver that answers the operator's question 'how do we use traces
      // to understand what code we need to make' — the substrate's
      // observability surface becomes actionable decisions.
      "code_needs_report",
      // Stateful-UI vessel (substrate's face, 2026-06-02): advertised here so
      // discovery routes uiPanel_write / uiQuestion_write traffic correctly
      // for callers that resolve via dev-vessel. Implementation is a thin
      // passthrough to stateful-ui-vessel on port 8270 — the canonical store
      // lives there. See repos/stateful-ui-vessel/.
      "uiPanel_write",
      "uiQuestion_write",
      // Stateful-UI vessel v0.2 (2026-06-02): interactor* impulses produced
      // by the operator through the substrate's face. Dev-vessel passthrough
      // appends to WORKSPACE_ROOT/interactor-log/<shape>.jsonl for substrate-
      // side aggregation; durable in-memory pool lives in stateful-ui-vessel.
      // Read shapes (uiFeedback / interactorEvent / interactorAssertion /
      // interactorAttachment) are advertised by stateful-ui-vessel directly.
      "uiFeedback_write",
      "interactorEvent_write",
      "interactorAssertion_write",
      "interactorDismiss_write",
      "interactorAttachment_write",
      // S3 push-away primitive (iter-s3-push-away, 2026-06-02): substrate
      // evaluates a proposed operator/external intervention against its own
      // priors (recent traces + concept-db) and returns ACCEPT / REFUSE /
      // DEFER with cited substrate priors. REFUSE persists a refusal record
      // (interventionRefused) so the substrate accumulates push-away history
      // — the operator-measured S3 readiness signal per IAL §27.S.6.
      // Deterministic only; semantic evaluation composes later with
      // comprehensibility_check.
      "intervention_evaluate",
      "interventionRefused",
      "interventionRefused_write",
      // Lift-criterion meta-detectors (iter-lift-criterion, 2026-06-02): each
      // surfaces a class of substrate gap that would have prompted the prior
      // operator intervention. composition_coverage_report flags producer/
      // consumer mismatches in the template catalogue; vessel_completeness_report
      // flags vessel scaffolds missing canonical files; template_invocation_history_report
      // flags registered-but-never-fired templates; vessel_demand_report flags
      // shapes required by ≥N templates with zero advertising vessel — the
      // trigger condition for substrate-authored vessel creation.
      "composition_coverage_report",
      "vessel_completeness_report",
      "template_invocation_history_report",
      "vessel_demand_report",
      // Mitosis primitives (iter-vessel-mitosis, 2026-06-03): the substrate's
      // self-modification keystone. vessel_mitosis_start copies a vessel tree
      // to a parallel-track path with operator/substrate-supplied source
      // changes and a port override; vessel_mitosis_evaluate segments recent
      // traces by version_id and renders FAVORABLE/NEUTRAL/UNFAVORABLE/
      // INSUFFICIENT_DATA; vessel_mitosis_cutover refuses unless verdict is
      // FAVORABLE, then archives the base and promotes the mitosis track to
      // the canonical path on the original port. Refuses on H4-load-bearing
      // baseline vessels (discovery-vessel, identity-vessel) and on operator-
      // anchor base_version_ids (v0, baseline, <vessel>-original).
      "vessel_mitosis_start",
      "vessel_mitosis_evaluate",
      "vessel_mitosis_cutover",
    ] as const,
    resolveEndpoint: "/v2/impulses/resolve",
    resolveRequestFormat: "pointer" as const,
    authScheme: "ApiKey" as const,
    resolveTimeoutMs: 10_000,
  },
} as const;

/**
 * Back-compat alias used by tests that import the list directly. Derived
 * from `config.discovery.shapes` so there's one source of truth.
 */
export const DISCOVERY_SHAPES: readonly string[] = config.discovery.shapes;
