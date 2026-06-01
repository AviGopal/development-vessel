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
