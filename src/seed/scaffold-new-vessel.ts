import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const SCAFFOLD_NEW_VESSEL_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:scaffold-new-vessel",
  name: "scaffold-new-vessel",
  description:
    "Create a new vessel scaffold with package.json, tsconfig.json, src/config.ts (with advertised shapes), and src/routes/impulses.ts (with dispatch stubs).",
  inputShapes: ["cwd"],
  outputShapes: ["vesselScaffolded"],
  tags: ["vessel", "scaffold", "create"],
  variables: [
    {
      name: "vesselName",
      description: "Name of the new vessel (e.g., 'my-analysis-vessel')",
    },
    {
      name: "dirPath",
      description: "Directory path where the vessel will be created",
    },
    {
      name: "advertisedShapes",
      description: "JSON array of shape names the vessel will advertise",
    },
    {
      name: "description",
      description: "One-line description of the vessel's purpose",
    },
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
    "lint": "tsc --noEmit && bun run scripts/check-shape-dispatch.ts"
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
      description: "Create tsconfig.json with strict settings",
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
    "declarationMap": true,
    "sourceMap": true,
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
      description: "Create src/config.ts with advertised shapes",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/config.ts",
        content: `import type { VesselConfig } from "@avigopal/ias-executor-ts";

export const DISCOVERY_SHAPES: string[] = {{advertisedShapes}};

export const VESSEL_CONFIG: VesselConfig = {
  discovery: {
    shapes: DISCOVERY_SHAPES,
    resolverContract: {
      resolve_endpoint: "/v2/impulses/resolve",
      resolve_request_format: "pointer",
      auth_scheme: "ApiKey",
      resolve_timeout_ms: 10000,
    },
  },
};
`,
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_routes",
      description: "Create src/routes/impulses.ts with dispatch stubs",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{dirPath}}/src/routes/impulses.ts",
        content: `import type { Impulse } from "@avigopal/ias-executor-ts";

export async function resolveDispatch(
  pointer: { type: string } & Record<string, unknown>
): Promise<Impulse> {
  switch (pointer.type) {
    // TODO: Add case arms for each advertised shape
    // Advertised shapes from config: {{advertisedShapes}}
    default:
      return {
        shape: "error",
        body: { message: \`unknown shape: \${pointer.type}\` },
      };
  }
}
`,
      },
      outputShapes: ["commandResult"],
    },
  ],
};
