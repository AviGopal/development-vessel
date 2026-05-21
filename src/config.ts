export const VESSEL_ID = process.env["VESSEL_ID"] ?? `development-vessel-${process.env["HOSTNAME"] ?? "local"}`;
export const PORT = parseInt(process.env["PORT"] ?? "8090", 10);
export const HOST = process.env["HOST"] ?? "0.0.0.0";

export const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "https://activity.metabob.com";
export const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
export const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "https://discovery.metabob.com";

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
