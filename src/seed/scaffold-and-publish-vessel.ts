import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * scaffold-and-publish-vessel — vessel-scope composition that mirrors
 * publish-substrate-authored-artifact's safety chain but for an entire vessel
 * directory rather than a single artifact path.
 *
 * Composition:
 *   1. git_status (preflight clean check)
 *   2. fs_write × 7 (vessel scaffold files — inlined rather than dispatched
 *      because composition-dispatch across goal-host adds latency and reduces
 *      audit-ability; see complete-vessel-scaffold for the standalone template)
 *   3. git_branch_create — substrate-authored/<vesselName>-<timestamp>
 *   4. git_add — full vessel dir + systemd unit
 *   5. git_commit — substrate-authored commit with provenance trailer
 *   6. git_push — refuses protected branches via git_push resolver
 *   7. gh_pr_create — requires Substrate-Authored-By trailer
 *
 * Authored 2026-06-02 in response to the empirical finding that
 * scaffold-new-vessel (exec_zyfoa5y2) successfully wrote 4 files but had no
 * downstream publication path — the substrate could create vessels but not
 * publish them.
 *
 * Constraints inherited from publish-substrate-authored-artifact:
 *   - target_branch must match SUBSTRATE_ALLOWED_BRANCH_PATTERNS
 *   - pr_body must contain "Substrate-Authored-By:" trailer
 *   - git_push refuses main/dev/master/trunk/release
 */
export const SCAFFOLD_AND_PUBLISH_VESSEL_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:scaffold-and-publish-vessel",
  name: "scaffold-and-publish-vessel",
  description:
    "Compose vessel scaffold (full canonical structure) + git branch + commit " +
    "+ push + PR against dev. No destination canonized; caller chooses " +
    "vesselName + target_branch + advertisedShapes.",
  inputShapes: ["cwd"],
  outputShapes: ["branchCreateResult", "gitPushResult", "prCreateResult"],
  tags: [
    "substrate.authored.publication",
    "vessel",
    "scaffold",
    "publish",
    "composition",
    "intent:scaffold",
  ],
  variables: [
    { name: "cwd", description: "Writable super-repo clone path" },
    { name: "vesselName", description: "Vessel name (e.g. 'metric-collector-vessel')" },
    { name: "dirPath", description: "Vessel dir (e.g. <cwd>/repos/<vesselName>)" },
    { name: "unitDirPath", description: "Dir holding systemd units (e.g. <cwd>/scripts/substrate/units)" },
    { name: "unitFilePath", description: "Path to vessel systemd unit file" },
    { name: "advertisedShapes", description: "JSON array of advertised shapes" },
    { name: "description", description: "One-line vessel description" },
    { name: "port", description: "Vessel HTTP port" },
    { name: "target_branch", description: "Branch name (must match SUBSTRATE_ALLOWED_BRANCH_PATTERNS)" },
    { name: "base_branch", description: "Branch to fork from (default dev)" },
    { name: "commit_message", description: "Commit message; should cite trace_id" },
    { name: "owner", description: "GitHub owner" },
    { name: "repo", description: "GitHub repo" },
    { name: "pr_title", description: "PR title" },
    {
      name: "pr_body",
      description: "PR body; MUST contain 'Substrate-Authored-By:' line",
    },
  ],
  tasks: [
    {
      id: "preflight_clean",
      description: "Verify writable clone is clean before staging.",
      resolver: "git_status",
      config: { type: "git_status", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_package_json",
      description: "Vessel package.json",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/package.json",
        content: `{
  "name": "@metabob/{{vesselName}}",
  "type": "module",
  "version": "0.1.0",
  "description": "{{description}}",
  "main": "dist/index.js",
  "scripts": {
    "dev": "bun run src/index.ts",
    "start": "bun run src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5"
  }
}`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_tsconfig",
      description: "Vessel tsconfig.json",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/tsconfig.json",
        content: `{
  "compilerOptions": {
    "target": "ES2020", "module": "ES2020", "lib": ["ES2020"],
    "outDir": "./dist", "rootDir": "./src",
    "strict": true, "skipLibCheck": true, "esModuleInterop": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"], "exclude": ["node_modules", "dist", "**/*.test.ts"]
}`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_config",
      description: "Vessel src/config.ts",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/config.ts",
        content: `export const VESSEL_ID = process.env["VESSEL_ID"] ?? "{{vesselName}}";
export const PORT = parseInt(process.env["PORT"] ?? "{{port}}", 10);
export const HOST = process.env["HOST"] ?? "0.0.0.0";
export const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
export const DISCOVERY_SHAPES: readonly string[] = {{advertisedShapes}};
export const config = {
  vesselId: VESSEL_ID, port: PORT, host: HOST,
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  discovery: {
    shapes: DISCOVERY_SHAPES,
    resolveEndpoint: "/v2/impulses/resolve",
    resolveRequestFormat: "pointer" as const,
    authScheme: "ApiKey" as const,
    resolveTimeoutMs: 10000,
  },
} as const;
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_routes",
      description: "Vessel src/routes/impulses.ts",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/routes/impulses.ts",
        content: `import { Hono } from "hono";
export const impulsesRouter = new Hono();
impulsesRouter.post("/v2/impulses/resolve", async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const ptype = body?.impulse?.pointer?.type;
  if (!ptype) return c.json({ success: false, error: "pointer.type required" }, 400);
  switch (ptype) {
    // TODO: Add cases for {{advertisedShapes}}
    default:
      return c.json({ success: false, error: \`unknown shape: \${ptype}\` }, 400);
  }
});
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_index",
      description: "Vessel src/index.ts",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/index.ts",
        content: `import { Hono } from "hono";
import { config } from "./config.js";
import { impulsesRouter } from "./routes/impulses.js";
import { registerWithDiscovery } from "./discovery-registration.js";
const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", vesselId: config.vesselId }));
app.get("/shapes", (c) => c.json({ shapes: config.discovery.shapes }));
app.route("/", impulsesRouter);
Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch });
console.log(\`[{{vesselName}}] listening on \${config.host}:\${config.port}\`);
registerWithDiscovery().catch((err) =>
  console.warn(\`[{{vesselName}}] discovery registration failed: \${(err as Error).message}\`),
);
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_discovery_registration",
      description: "Vessel src/discovery-registration.ts",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/discovery-registration.ts",
        content: `import { config } from "./config.js";
const HEARTBEAT_INTERVAL_MS = 60_000;
export async function registerWithDiscovery(): Promise<void> {
  const body = {
    vesselId: config.vesselId,
    endpoint: \`http://127.0.0.1:\${config.port}\`,
    shapes: config.discovery.shapes,
    resolverContract: {
      resolve_endpoint: config.discovery.resolveEndpoint,
      resolve_request_format: config.discovery.resolveRequestFormat,
      auth_scheme: config.discovery.authScheme,
      resolve_timeout_ms: config.discovery.resolveTimeoutMs,
    },
  };
  const apiKey = process.env["METABOB_API_KEY"];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: \`ApiKey \${apiKey}\` } : {}),
  };
  try {
    await fetch(\`\${config.discoveryEndpoint}/register\`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* non-fatal */ }
  setInterval(async () => {
    try {
      await fetch(\`\${config.discoveryEndpoint}/heartbeat\`, {
        method: "POST", headers,
        body: JSON.stringify({ vesselId: config.vesselId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch { /* non-fatal */ }
  }, HEARTBEAT_INTERVAL_MS).unref();
}
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_systemd_unit",
      description: "Vessel systemd unit",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{unitFilePath}}",
        content: `[Unit]
Description={{vesselName}}
After=activity-api.service discovery-vessel.service
Requires=activity-api.service

[Service]
Type=simple
EnvironmentFile=/etc/substrate/env
Environment=PORT={{port}}
Environment=HOST=127.0.0.1
Environment=VESSEL_ID={{vesselName}}
WorkingDirectory=/vessels/{{vesselName}}
ExecStart=/root/.bun/bin/bun /vessels/{{vesselName}}/src/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "create_branch",
      description: "Create substrate-authored branch from base_branch.",
      resolver: "git_branch_create",
      config: {
        type: "git_branch_create",
        branch_name: "{{target_branch}}",
        base: "{{base_branch}}",
        cwd: "{{cwd}}",
      },
      outputShapes: ["branchCreateResult"],
    },
    {
      id: "stage_vessel",
      description: "Stage the vessel dir + systemd unit.",
      resolver: "git_add",
      config: {
        type: "git_add",
        paths: ["{{dirPath}}", "{{unitFilePath}}"],
        cwd: "{{cwd}}",
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "commit_vessel",
      description: "Commit staged vessel.",
      resolver: "git_commit",
      config: { type: "git_commit", message: "{{commit_message}}", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "push_branch",
      description: "Push branch (refuses protected refs).",
      resolver: "git_push",
      config: { type: "git_push", branch: "{{target_branch}}", cwd: "{{cwd}}" },
      outputShapes: ["gitPushResult"],
    },
    {
      id: "open_pr",
      description: "Open PR with Substrate-Authored-By trailer.",
      resolver: "gh_pr_create",
      config: {
        type: "gh_pr_create",
        owner: "{{owner}}",
        repo: "{{repo}}",
        source_branch: "{{target_branch}}",
        target_branch: "{{base_branch}}",
        title: "{{pr_title}}",
        body: "{{pr_body}}",
      },
      outputShapes: ["prCreateResult"],
    },
  ],
  authored_from_pattern: {
    pattern_id: "scaffold_publish_vessel_lift_iter_2026_06_02",
    observation_window: "2026-06-02/2026-06-02",
    contrast_examples: 1,
  },
  composition_rationales: [
    {
      task_id: "preflight_clean",
      rationale_class: "essential",
      rationale_text:
        "Mirrors publish-substrate-authored-artifact preflight; a dirty baseline must force operator triage.",
    },
    {
      task_id: "create_branch",
      rationale_class: "essential",
      rationale_text:
        "git_branch_create encodes the substrate-authored prefix gate; bypassing it stages substrate commits on operator branches.",
    },
    {
      task_id: "push_branch",
      rationale_class: "essential",
      rationale_text:
        "git_push encodes the protected-branch refusal client-side until server-side branch protection ships.",
    },
    {
      task_id: "open_pr",
      rationale_class: "essential",
      rationale_text:
        "gh_pr_create enforces the Substrate-Authored-By trailer; a generic HTTP POST would not.",
    },
  ],
};
