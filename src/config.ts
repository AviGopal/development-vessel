export const VESSEL_ID = process.env["VESSEL_ID"] ?? `development-vessel-${process.env["HOSTNAME"] ?? "local"}`;
export const PORT = parseInt(process.env["PORT"] ?? "8090", 10);
export const HOST = process.env["HOST"] ?? "0.0.0.0";

export const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "https://activity.metabob.com";
export const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
export const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "https://discovery.metabob.com";

export const WORKSPACE_ROOT = process.env["WORKSPACE_ROOT"] ?? process.cwd();

/** All impulse shapes this vessel advertises to discovery. One entry per R2.* resolver. */
export const DISCOVERY_SHAPES: string[] = [
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
];

export const config = {
  vesselId: VESSEL_ID,
  port: PORT,
  host: HOST,
  metabobEndpoint: METABOB_ENDPOINT,
  metabobApiKey: METABOB_API_KEY,
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  workspaceRoot: WORKSPACE_ROOT,
  discovery: {
    shapes: DISCOVERY_SHAPES,
    resolveEndpoint: "/v2/impulses/resolve",
    resolveRequestFormat: "pointer" as const,
    authScheme: "ApiKey" as const,
    resolveTimeoutMs: 10_000,
  },
} as const;
