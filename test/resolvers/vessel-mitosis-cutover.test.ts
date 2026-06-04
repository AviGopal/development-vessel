import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveVesselMitosisCutover } from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let workspaceRoot: string;
let originalWS: string | undefined;
let originalSkip: string | undefined;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "mitosis-cut-"));
  workspaceRoot = tmpRoot;
  originalWS = process.env["WORKSPACE_ROOT"];
  originalSkip = process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"];
  process.env["WORKSPACE_ROOT"] = workspaceRoot;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
});

afterEach(async () => {
  if (originalWS === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = originalWS;
  if (originalSkip === undefined) delete process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"];
  else process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = originalSkip;
  await rm(tmpRoot, { recursive: true, force: true });
});

async function setupForCutover(): Promise<{
  baseRoot: string;
  mitosisRoot: string;
  unitDir: string;
  baseSha: string;
}> {
  const reposRoot = join(workspaceRoot, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, "development-vessel");
  const mitosisRoot = join(reposRoot, "development-vessel-mitosis-2026-06-03T00-00-00Z");
  await mkdir(join(baseRoot, "src"), { recursive: true });
  await mkdir(join(mitosisRoot, "src"), { recursive: true });
  await writeFile(join(baseRoot, "src", "marker.txt"), "base-content");
  await writeFile(join(mitosisRoot, "src", "marker.txt"), "mitosis-content");
  // Stage B.2: write a base index.ts so the cutover freshness gate has
  // something to hash. We also compute its SHA so tests can pass a matching
  // staged_base_sha by default.
  const baseIndexContent = `// base index for cutover test\nexport const v = "base";\n`;
  await writeFile(join(baseRoot, "src", "index.ts"), baseIndexContent);
  const { createHash } = await import("node:crypto");
  const baseSha = createHash("sha256").update(baseIndexContent).digest("hex").slice(0, 12);
  const unitDir = join(workspaceRoot, "git", "super-repo", "scripts", "substrate", "units");
  await mkdir(unitDir, { recursive: true });
  await writeFile(
    join(unitDir, "development-vessel-mitosis-2026-06-03T00-00-00Z.service"),
    `[Unit]\nDescription=dev-vessel mitosis\n[Service]\nWorkingDirectory=/vessels/development-vessel-mitosis-2026-06-03T00-00-00Z\nExecStart=/root/.bun/bin/bun /vessels/development-vessel-mitosis-2026-06-03T00-00-00Z/src/index.ts\nEnvironment=PORT=8091\n[Install]\nWantedBy=multi-user.target\n`,
  );
  return { baseRoot, mitosisRoot, unitDir, baseSha };
}

const FAVORABLE_EVIDENCE = {
  verdict: "FAVORABLE",
  base_success_rate: 0.2,
  mitosis_success_rate: 1.0,
  cited_trace_ids: ["exec_a", "exec_b"],
};

describe("vessel_mitosis_cutover", () => {
  it("refuses cutover when verdict != FAVORABLE", async () => {
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
      mitosis_root: "/tmp/x",
      evaluation_evidence: { ...FAVORABLE_EVIDENCE, verdict: "NEUTRAL" },
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("FAVORABLE");
  });

  it("refuses cutover on protected vessel", async () => {
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "discovery-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
      mitosis_root: "/tmp/x",
      evaluation_evidence: FAVORABLE_EVIDENCE,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("discovery-vessel");
  });

  it("refuses cutover from operator-anchor baseline (v0)", async () => {
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v0",
      mitosis_version_id: "mitosis-X",
      mitosis_root: "/tmp/x",
      evaluation_evidence: FAVORABLE_EVIDENCE,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("operator-anchor");
  });

  it("refuses cutover from <vessel>-original baseline", async () => {
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "development-vessel-original",
      mitosis_version_id: "mitosis-X",
      mitosis_root: "/tmp/x",
      evaluation_evidence: FAVORABLE_EVIDENCE,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("operator-anchor");
  });

  it("dry_run returns plan without moving anything", async () => {
    const { baseRoot, mitosisRoot, baseSha } = await setupForCutover();
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-2026-06-03T00-00-00Z",
      mitosis_root: mitosisRoot,
      staged_base_sha: baseSha,
      evaluation_evidence: FAVORABLE_EVIDENCE,
      dry_run: true,
    });
    expect(r.shape).toBe("vesselMitosisCutoverPlan");
    // Nothing moved.
    const baseMarker = await readFile(join(baseRoot, "src/marker.txt"), "utf8");
    expect(baseMarker).toBe("base-content");
    const mitosisMarker = await readFile(join(mitosisRoot, "src/marker.txt"), "utf8");
    expect(mitosisMarker).toBe("mitosis-content");
  });

  it("performs cutover: archive base, promote mitosis, rewrite unit", async () => {
    const { baseRoot, mitosisRoot, unitDir, baseSha } = await setupForCutover();
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-2026-06-03T00-00-00Z",
      mitosis_root: mitosisRoot,
      staged_base_sha: baseSha,
      evaluation_evidence: FAVORABLE_EVIDENCE,
    });
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    const body = r.body as {
      promoted_to: string;
      archived_at: string;
      operations: Array<{ op: string; status: string }>;
    };
    // Mitosis content is now at canonical baseRoot.
    const promoted = await readFile(join(baseRoot, "src/marker.txt"), "utf8");
    expect(promoted).toBe("mitosis-content");
    // Original base is at archive.
    const archived = await readFile(join(body.archived_at, "src/marker.txt"), "utf8");
    expect(archived).toBe("base-content");
    // Mitosis path no longer exists.
    let mitosisStillThere = true;
    try {
      await stat(mitosisRoot);
    } catch {
      mitosisStillThere = false;
    }
    expect(mitosisStillThere).toBe(false);
    // Canonical unit file rewritten to point at canonical path.
    const canonicalUnit = await readFile(
      join(unitDir, "development-vessel.service"),
      "utf8",
    );
    expect(canonicalUnit).toContain("WorkingDirectory=/vessels/development-vessel");
    expect(canonicalUnit).not.toContain("mitosis-2026-06-03T00-00-00Z");
    // Cited evidence in body.
    expect(JSON.stringify(r.body)).toContain("exec_a");
  });

  // ---- Stage B.2: mitosis freshness gate ----

  it("freshness gate: refuses cutover when staged_base_sha is missing", async () => {
    const { mitosisRoot } = await setupForCutover();
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-2026-06-03T00-00-00Z",
      mitosis_root: mitosisRoot,
      // staged_base_sha intentionally omitted
      evaluation_evidence: FAVORABLE_EVIDENCE,
    });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { detail: string; kind?: string; gap_id?: string };
    expect(body.detail).toContain("mitosis_freshness_violation");
    expect(body.detail).toContain("missing_base_sha");
    expect(body.kind).toBe("mitosis_freshness_violation");
    // Gap landed in WORKSPACE_ROOT/gaps/gaps.json.
    const gapsPath = join(workspaceRoot, "gaps", "gaps.json");
    const gaps = JSON.parse(await readFile(gapsPath, "utf8")) as Array<Record<string, unknown>>;
    expect(gaps.length).toBeGreaterThan(0);
    const cite = gaps.find(
      (g) =>
        ((g["classification_metadata"] ?? {}) as Record<string, unknown>)["cite_principle"] ===
        "resilient_against_unintended_changes",
    );
    expect(cite).toBeDefined();
  });

  it("freshness gate: refuses cutover when staged_base_sha mismatches live", async () => {
    const { mitosisRoot } = await setupForCutover();
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-2026-06-03T00-00-00Z",
      mitosis_root: mitosisRoot,
      staged_base_sha: "deadbeef0000", // wrong
      evaluation_evidence: FAVORABLE_EVIDENCE,
    });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { detail: string; kind?: string };
    expect(body.detail).toContain("mitosis_freshness_violation");
    expect(body.detail).toContain("base_sha_mismatch");
  });

  it("requires non-empty cited_trace_ids", async () => {
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
      mitosis_root: "/tmp/x",
      evaluation_evidence: { ...FAVORABLE_EVIDENCE, cited_trace_ids: [] },
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("cited_trace_ids");
  });

  // ---- Git-aware cutover (2026-06-04) ----

  async function setupForGitCutover(): Promise<{
    baseRoot: string;
    mitosisRoot: string;
    hostRepoRoot: string;
    baseSha: string;
    appliedLog: string;
  }> {
    // Independent setup — no extraneous files in mitosis dir, so the
    // scope-creep gate stays quiet for the happy path.
    const reposRoot = join(workspaceRoot, "git", "super-repo", "repos");
    const baseRoot = join(reposRoot, "development-vessel");
    const mitosisRoot = join(
      reposRoot,
      "development-vessel-mitosis-git-2026-06-04",
    );
    await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
    await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
    // Freshness gate hashes <baseRoot>/src/index.ts. Provide one + compute SHA.
    const baseIndexContent = `// base index for git cutover test\n`;
    await writeFile(join(baseRoot, "src", "index.ts"), baseIndexContent);
    const { createHash } = await import("node:crypto");
    const baseSha = createHash("sha256")
      .update(baseIndexContent)
      .digest("hex")
      .slice(0, 12);
    // Live vessel runtime path has the OLD content; it'll get mirrored.
    await writeFile(
      join(baseRoot, "src", "resolvers", "target.ts"),
      "// original (live)\n",
    );
    // Mitosis dir contains ONLY the staged file with new content.
    await writeFile(
      join(mitosisRoot, "src", "resolvers", "target.ts"),
      "// patched by substrate\n",
    );
    // Host git repo with the same original baseline.
    const hostRepoRoot = join(workspaceRoot, "host-repo");
    await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
    await writeFile(
      join(hostRepoRoot, "src", "resolvers", "target.ts"),
      "// original\n",
    );
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init", "-b", "dev"], { cwd: hostRepoRoot });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: hostRepoRoot,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: hostRepoRoot });
    spawnSync("git", ["add", "."], { cwd: hostRepoRoot });
    spawnSync("git", ["commit", "-m", "baseline"], { cwd: hostRepoRoot });
    const appliedLog = join(workspaceRoot, "mitosis-applied.jsonl");
    return { baseRoot, mitosisRoot, hostRepoRoot, baseSha, appliedLog };
  }

  it("git-aware cutover: applies staged files, commits, mirrors to /vessels, emits cutoverApplied", async () => {
    const { baseRoot, mitosisRoot, hostRepoRoot, baseSha, appliedLog } =
      await setupForGitCutover();
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-2026-06-03T00-00-00Z",
      mitosis_root: mitosisRoot,
      base_root: baseRoot,
      host_repo_root: hostRepoRoot,
      staged_base_sha: baseSha,
      staged_files: ["src/resolvers/target.ts"],
      proposal_id: "proposal-test-1",
      gap_id: "gap-test-1",
      evaluation_evidence: FAVORABLE_EVIDENCE,
      skip_push: true,
      skip_restart: true,
      applied_log_path: appliedLog,
    });
    expect(r.shape).toBe("cutoverApplied");
    const body = r.body as {
      new_git_sha: string;
      push_status: string;
      staged_files_applied: string[];
      mode: string;
      vessel_restarted: boolean;
    };
    expect(body.mode).toBe("git_aware");
    expect(body.new_git_sha.length).toBeGreaterThanOrEqual(40);
    expect(body.push_status).toBe("skipped");
    expect(body.staged_files_applied).toEqual(["src/resolvers/target.ts"]);
    expect(body.vessel_restarted).toBe(false); // skip_restart=true
    // Host repo got the new content.
    const hostContent = await readFile(
      join(hostRepoRoot, "src", "resolvers", "target.ts"),
      "utf8",
    );
    expect(hostContent).toBe("// patched by substrate\n");
    // Live vessel got mirrored content.
    const liveContent = await readFile(
      join(baseRoot, "src", "resolvers", "target.ts"),
      "utf8",
    );
    expect(liveContent).toBe("// patched by substrate\n");
    // Applied log has a cutoverApplied entry.
    const logRaw = await readFile(appliedLog, "utf8");
    expect(logRaw).toContain("cutoverApplied");
    expect(logRaw).toContain("proposal-test-1");
  });

  it("git-aware cutover: scope_creep_detected when mitosis dir has extra files", async () => {
    const { baseRoot, mitosisRoot, hostRepoRoot, baseSha, appliedLog } =
      await setupForGitCutover();
    // Plant an extra file not in staged_files.
    await writeFile(
      join(mitosisRoot, "src", "resolvers", "extra.ts"),
      "// unexpected\n",
    );
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-2026-06-03T00-00-00Z",
      mitosis_root: mitosisRoot,
      base_root: baseRoot,
      host_repo_root: hostRepoRoot,
      staged_base_sha: baseSha,
      staged_files: ["src/resolvers/target.ts"],
      proposal_id: "proposal-test-2",
      gap_id: "gap-test-2",
      evaluation_evidence: FAVORABLE_EVIDENCE,
      skip_push: true,
      skip_restart: true,
      applied_log_path: appliedLog,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("scope_creep_detected");
    expect((r.body as { kind: string }).kind).toBe("scope_creep_detected");
  });

  it("git-aware cutover: dry_run returns plan without modifying files", async () => {
    const { baseRoot, mitosisRoot, hostRepoRoot, baseSha, appliedLog } =
      await setupForGitCutover();
    const r = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: "development-vessel",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-2026-06-03T00-00-00Z",
      mitosis_root: mitosisRoot,
      base_root: baseRoot,
      host_repo_root: hostRepoRoot,
      staged_base_sha: baseSha,
      staged_files: ["src/resolvers/target.ts"],
      evaluation_evidence: FAVORABLE_EVIDENCE,
      skip_push: true,
      skip_restart: true,
      applied_log_path: appliedLog,
      dry_run: true,
    });
    expect(r.shape).toBe("vesselMitosisCutoverPlan");
    expect((r.body as { mode: string }).mode).toBe("git_aware");
    // Host file untouched.
    const hostContent = await readFile(
      join(hostRepoRoot, "src", "resolvers", "target.ts"),
      "utf8",
    );
    expect(hostContent).toBe("// original\n");
  });
});
