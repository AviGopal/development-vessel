import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveVesselMitosisStart, __test } from "../../src/resolvers/vessel-mitosis-start.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseUnitFile, serializeUnit, mergeUnitForMitosis } = __test;

let tmpRoot: string;
let workspaceRoot: string;
let originalWS: string | undefined;

async function setupVesselTree(vesselName: string, port: number): Promise<string> {
  const root = join(workspaceRoot, "git", "super-repo", "repos", vesselName);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "src", "resolvers"), { recursive: true });
  await mkdir(join(root, "node_modules", "lodash"), { recursive: true });
  await writeFile(join(root, "node_modules", "lodash", "index.js"), "// huge");
  await writeFile(
    join(root, "src", "config.ts"),
    `export const PORT = parseInt(process.env["PORT"] ?? "${port}", 10);\nexport const HOST = "0.0.0.0";\n`,
  );
  await writeFile(join(root, "src", "index.ts"), "// stub\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: vesselName }));
  return root;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "mitosis-start-"));
  workspaceRoot = tmpRoot;
  originalWS = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = workspaceRoot;
  await mkdir(join(workspaceRoot, "git", "super-repo", "scripts", "substrate", "units"), {
    recursive: true,
  });
});

afterEach(async () => {
  if (originalWS === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = originalWS;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("vessel_mitosis_start", () => {
  it("refuses mitosis on H4 baseline vessels", async () => {
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "discovery-vessel",
      intent_summary: "test",
      source_changes: [],
      base_port: 8100,
      mitosis_port: 8101,
    });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { detail: string };
    expect(body.detail).toContain("discovery-vessel");
  });

  it("refuses when base_port == mitosis_port", async () => {
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "development-vessel",
      intent_summary: "test",
      source_changes: [],
      base_port: 8090,
      mitosis_port: 8090,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("must differ");
  });

  it("refuses when source_root does not exist", async () => {
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "nonexistent-vessel",
      intent_summary: "test",
      source_changes: [],
      base_port: 8090,
      mitosis_port: 8091,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("not found");
  });

  it("copies tree, excludes node_modules, applies source_changes, rewrites PORT, writes unit", async () => {
    const baseRoot = await setupVesselTree("development-vessel", 8090);
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "development-vessel",
      intent_summary: "fix #140 by replacing X with Y",
      source_changes: [
        { target_path: "src/resolvers/new-thing.ts", new_content: "export const x = 1;\n" },
      ],
      base_port: 8090,
      mitosis_port: 8091,
    });
    expect(r.shape).toBe("vesselMitosisInitiated");
    const body = r.body as {
      version_id: string;
      mitosis_root: string;
      systemd_unit_path: string;
      systemd_unit_present: boolean;
      port_rewrite_applied: boolean;
      copy_stats: { files: number };
      applied_changes: string[];
    };

    expect(body.version_id).toMatch(/^mitosis-/);
    expect(body.applied_changes).toContain("src/resolvers/new-thing.ts");
    expect(body.port_rewrite_applied).toBe(true);
    expect(body.systemd_unit_present).toBe(true);

    // Mitosis root has the change applied.
    const changed = await readFile(join(body.mitosis_root, "src/resolvers/new-thing.ts"), "utf8");
    expect(changed).toContain("export const x = 1;");

    // PORT rewrite landed.
    const cfg = await readFile(join(body.mitosis_root, "src/config.ts"), "utf8");
    expect(cfg).toContain('"8091"');
    expect(cfg).not.toContain('"8090"');

    // node_modules excluded.
    const entries = await readdir(body.mitosis_root);
    expect(entries).not.toContain("node_modules");

    // Unit file written.
    const unit = await readFile(body.systemd_unit_path, "utf8");
    expect(unit).toContain("PORT=8091");
    expect(unit).toContain("fix #140");
    expect(unit).toContain("MITOSIS_VERSION_ID=");

    // Base untouched.
    const baseCfg = await readFile(join(baseRoot, "src/config.ts"), "utf8");
    expect(baseCfg).toContain('"8090"');
  });

  it("refuses overlapping source_root and mitosis_root", async () => {
    const baseRoot = await setupVesselTree("development-vessel", 8090);
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "development-vessel",
      intent_summary: "test",
      source_changes: [],
      base_port: 8090,
      mitosis_port: 8091,
      source_root: baseRoot,
      mitosis_root: join(baseRoot, "subdir"),
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("overlaps");
  });

  it("refuses when mitosis_root already exists", async () => {
    const baseRoot = await setupVesselTree("development-vessel", 8090);
    const mitosisRoot = `${baseRoot}-existing`;
    await mkdir(mitosisRoot, { recursive: true });
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "development-vessel",
      intent_summary: "test",
      source_changes: [],
      base_port: 8090,
      mitosis_port: 8091,
      source_root: baseRoot,
      mitosis_root: mitosisRoot,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("already exists");
  });

  it("refuses target_path escaping mitosis_root", async () => {
    await setupVesselTree("development-vessel", 8090);
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "development-vessel",
      intent_summary: "test",
      source_changes: [{ target_path: "../escape.ts", new_content: "x" }],
      base_port: 8090,
      mitosis_port: 8091,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("escapes");
  });

  it("v0.2 — merges base unit, preserving Memory* + base Environment, applying mitosis overrides", async () => {
    const baseRoot = await setupVesselTree("development-vessel", 8090);
    // Write a base unit modelled on goal-host-vessel.service (the empirical
    // motivator for v0.2: first mitosis ran uncapped + without LLM_VESSEL_ENDPOINT).
    const unitDir = join(workspaceRoot, "git", "super-repo", "scripts", "substrate", "units");
    const baseUnitPath = join(unitDir, "development-vessel.service");
    await writeFile(
      baseUnitPath,
      `[Unit]
Description=development-vessel
After=activity-api.service llm-resolver-vessel.service
Requires=activity-api.service

[Service]
Type=simple
EnvironmentFile=/etc/substrate/env
Environment=PORT=8090
Environment=HOST=127.0.0.1
Environment=LLM_VESSEL_ENDPOINT=http://127.0.0.1:8220
Environment=ACTIVITY_API_ENDPOINT=http://127.0.0.1:8080
WorkingDirectory=/vessels/development-vessel
ExecStart=/root/.bun/bin/bun /vessels/development-vessel/src/index.ts
Restart=on-failure
RestartSec=5
MemoryHigh=2G
MemoryMax=3G
RestartSteps=3
RestartMaxDelaySec=30

[Install]
WantedBy=multi-user.target
`,
    );

    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "development-vessel",
      intent_summary: "v0.2 unit-merge regression",
      source_changes: [],
      base_port: 8090,
      mitosis_port: 8091,
    });
    expect(r.shape).toBe("vesselMitosisInitiated");
    const body = r.body as {
      systemd_unit_path: string;
      base_unit_merged: boolean;
      mitosis_resolver_version: string;
      preserved_service_directives: Record<string, number>;
    };

    expect(body.base_unit_merged).toBe(true);
    expect(body.mitosis_resolver_version).toBe("v0.3");

    const unit = await readFile(body.systemd_unit_path, "utf8");
    // Memory caps preserved (the key v0.2 fix).
    expect(unit).toContain("MemoryHigh=2G");
    expect(unit).toContain("MemoryMax=3G");
    expect(unit).toContain("RestartSteps=3");
    expect(unit).toContain("RestartMaxDelaySec=30");
    // Base env preserved (LLM_VESSEL_ENDPOINT in particular).
    expect(unit).toContain("LLM_VESSEL_ENDPOINT=http://127.0.0.1:8220");
    expect(unit).toContain("ACTIVITY_API_ENDPOINT=http://127.0.0.1:8080");
    // Mitosis-owned env applied.
    expect(unit).toContain("Environment=PORT=8091");
    expect(unit).toContain("MITOSIS_VERSION_ID=");
    expect(unit).toContain("MITOSIS_BASE_VESSEL=development-vessel");
    // Base PORT dropped.
    expect(unit).not.toContain("Environment=PORT=8090");
    // After= preserved.
    expect(unit).toContain("After=activity-api.service llm-resolver-vessel.service");
  });

  it("v0.2 — falls back to minimal unit when base unit absent", async () => {
    await setupVesselTree("development-vessel", 8090);
    // No base unit file written → resolver should still succeed with minimal.
    const r = await resolveVesselMitosisStart({
      type: "vessel_mitosis_start",
      vessel_name: "development-vessel",
      intent_summary: "no base unit",
      source_changes: [],
      base_port: 8090,
      mitosis_port: 8092,
    });
    expect(r.shape).toBe("vesselMitosisInitiated");
    const body = r.body as { base_unit_merged: boolean; systemd_unit_path: string };
    expect(body.base_unit_merged).toBe(false);
    const unit = await readFile(body.systemd_unit_path, "utf8");
    expect(unit).toContain("PORT=8092");
    expect(unit).toContain("MITOSIS_VERSION_ID=");
  });
});

describe("vessel_mitosis_start — systemd unit merge primitives (v0.2)", () => {
  const BASE_UNIT = `[Unit]
Description=goal-host-vessel
After=activity-api.service
Requires=activity-api.service

[Service]
Type=simple
Environment=PORT=8210
Environment=LLM_VESSEL_ENDPOINT=http://127.0.0.1:8220
Environment=ACTIVITY_API_ENDPOINT=http://127.0.0.1:8080
WorkingDirectory=/vessels/goal-host-vessel
ExecStart=/root/.bun/bin/bun /vessels/goal-host-vessel/src/index.ts
Restart=on-failure
MemoryHigh=2G
MemoryMax=3G

[Install]
WantedBy=multi-user.target
`;

  const OVERRIDES = {
    description: "goal-host-vessel (mitosis) — streaming v2",
    workingDirectory: "/vessels/goal-host-mitosis",
    execStart: "/root/.bun/bin/bun /vessels/goal-host-mitosis/src/index.ts",
    addedEnv: [
      { key: "PORT", value: "8211" },
      { key: "VESSEL_ID", value: "goal-host-vessel-mitosis-test" },
      { key: "MITOSIS_VERSION_ID", value: "mitosis-test" },
      { key: "MITOSIS_BASE_VESSEL", value: "goal-host-vessel" },
    ],
  };

  it("parseUnitFile preserves section order", () => {
    const parsed = parseUnitFile(BASE_UNIT);
    expect(parsed.sectionsOrder).toEqual(["Unit", "Service", "Install"]);
  });

  it("merged unit contains both MemoryMax AND LLM_VESSEL_ENDPOINT AND new PORT", () => {
    const parsed = parseUnitFile(BASE_UNIT);
    const merged = mergeUnitForMitosis(parsed, OVERRIDES);
    const out = serializeUnit(merged);
    // The regression criterion from the goal: must contain BOTH base memory
    // caps AND base LLM port AND mitosis-owned PORT.
    expect(out).toContain("MemoryMax=3G");
    expect(out).toContain("LLM_VESSEL_ENDPOINT=http://127.0.0.1:8220");
    expect(out).toContain("Environment=PORT=8211");
    expect(out).toContain("MITOSIS_VERSION_ID=mitosis-test");
    // And does NOT contain the base PORT.
    expect(out).not.toContain("Environment=PORT=8210");
  });
});

