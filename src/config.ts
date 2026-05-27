export const VESSEL_ID = process.env["VESSEL_ID"] ?? `development-vessel-${process.env["HOSTNAME"] ?? "local"}`;
export const PORT = parseInt(process.env["PORT"] ?? "8090", 10);
export const HOST = process.env["HOST"] ?? "0.0.0.0";

export const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
export const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
export const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
export const GOAL_HOST_VESSEL_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";

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
