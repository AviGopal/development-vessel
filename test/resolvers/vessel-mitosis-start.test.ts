import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveVesselMitosisStart } from "../../src/resolvers/vessel-mitosis-start.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});

