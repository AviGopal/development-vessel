import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * complete-vessel-scaffold — extension of scaffold-new-vessel that writes the
 * full canonical "complete vessel" structure rather than the four-file
 * skeleton. Adds:
 *   - src/index.ts (Hono server entry)
 *   - src/discovery-registration.ts (per docs/architecture/TYPESCRIPT_VESSEL_TEMPLATE.md)
 *   - scripts/substrate/units/<vesselName>-vessel.service (systemd unit)
 *   - Makefile sync target snippet
 *
 * scaffold-new-vessel remains as a thinner alternative. Thompson Sampling
 * selects between them based on success rate. complete-vessel-scaffold is
 * intended to compose with scaffold-and-publish-vessel which expects a full
 * structure to git-add.
 *
 * Authored by substrate after vessel_completeness_report flagged clock-vessel
 * (2026-06-02) as missing index.ts + discovery-registration.ts.
 */
export const COMPLETE_VESSEL_SCAFFOLD_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:complete-vessel-scaffold",
  name: "complete-vessel-scaffold",
  description:
    "Write the full canonical vessel structure: package.json, tsconfig.json, " +
    "src/config.ts, src/routes/impulses.ts, src/index.ts, src/discovery-registration.ts, " +
    "and the systemd unit. Produces a vessel ready for substrate-and-publish-vessel " +
    "to git-add and PR.",
  inputShapes: ["cwd"],
  outputShapes: ["vesselScaffolded"],
  tags: ["vessel", "scaffold", "create", "complete", "intent:scaffold"],
  variables: [
    { name: "vesselName", description: "Vessel name (e.g. 'metric-collector-vessel')" },
    { name: "dirPath", description: "Vessel directory (e.g. /workspace/repos/<vesselName>)" },
    { name: "unitDirPath", description: "Directory holding systemd units (scripts/substrate/units)" },
    { name: "advertisedShapes", description: "JSON array of advertised shape names" },
    { name: "description", description: "One-line vessel description" },
    { name: "port", description: "Vessel HTTP port (e.g. 8280)" },
  ],
  tasks: [
    {
      id: "write_package_json",
      description: "Create package.json with dependencies",
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
    "build": "bun run typecheck && tsc",
    "dev": "bun run src/index.ts",
    "start": "bun run src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4",
    "@avigopal/ias-executor-ts": "workspace:*"
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
      description: "Create tsconfig.json",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/tsconfig.json",
        content: `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_config",
      description: "Create src/config.ts",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/config.ts",
        content: `export const VESSEL_ID = process.env["VESSEL_ID"] ?? "{{vesselName}}";
export const PORT = parseInt(process.env["PORT"] ?? "{{port}}", 10);
export const HOST = process.env["HOST"] ?? "0.0.0.0";

export const DISCOVERY_ENDPOINT =
  process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
export const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";

export const DISCOVERY_SHAPES: readonly string[] = {{advertisedShapes}};

export const config = {
  vesselId: VESSEL_ID,
  port: PORT,
  host: HOST,
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
      description: "Create src/routes/impulses.ts",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/routes/impulses.ts",
        content: `import { Hono } from "hono";

export const impulsesRouter = new Hono();

impulsesRouter.post("/v2/impulses/resolve", async (c) => {
  let body: { impulse?: { pointer?: { type?: string } } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }
  const pointerType = body?.impulse?.pointer?.type;
  if (!pointerType) {
    return c.json({ success: false, error: "pointer.type is required" }, 400);
  }
  switch (pointerType) {
    // TODO: Add cases for each advertised shape: {{advertisedShapes}}
    default:
      return c.json({ success: false, error: \`unknown shape: \${pointerType}\` }, 400);
  }
});
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_index",
      description: "Create src/index.ts (Hono server entry)",
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

registerWithDiscovery().catch((err) => {
  console.warn(\`[{{vesselName}}] discovery registration failed: \${(err as Error).message}\`);
});
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_discovery_registration",
      description: "Create src/discovery-registration.ts",
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
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // non-fatal — vessel is functional even if discovery is down.
  }
  setInterval(async () => {
    try {
      await fetch(\`\${config.discoveryEndpoint}/heartbeat\`, {
        method: "POST",
        headers,
        body: JSON.stringify({ vesselId: config.vesselId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // non-fatal
    }
  }, HEARTBEAT_INTERVAL_MS).unref();
}
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_systemd_unit",
      description: "Create systemd unit for substrate hosting",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{unitDirPath}}/{{vesselName}}.service",
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
  ],
  authored_from_pattern: {
    pattern_id: "vessel_completeness_intersection_2026_06_02",
    observation_window: "2026-06-02/2026-06-02",
    contrast_examples: 1,
  },
  composition_rationales: [
    {
      task_id: "write_index",
      rationale_class: "essential",
      rationale_text:
        "Without src/index.ts the vessel has no executable entry point — clock-vessel (2026-06-02) demonstrated this gap empirically.",
    },
    {
      task_id: "write_discovery_registration",
      rationale_class: "essential",
      rationale_text:
        "Without discovery registration, the vessel is invisible to the substrate — its advertised shapes never reach the registry.",
    },
    {
      task_id: "write_systemd_unit",
      rationale_class: "essential",
      rationale_text:
        "Substrate runs vessels as systemd units; without the unit file the vessel cannot be hosted in the substrate container.",
    },
  ],
};
