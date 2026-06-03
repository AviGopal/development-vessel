import { resolve, join, dirname } from "path";
import { rename, mkdir, stat, unlink, readFile, writeFile } from "node:fs/promises";
import type { ResolverResult } from "./types.js";

/**
 * vessel_mitosis_cutover — promotes a mitosis track to the canonical position
 * after evaluation returns FAVORABLE. Refuses on any other verdict, and on
 * H4-load-bearing baseline version_ids (v0 / baseline / *-original).
 *
 * Operations (when dry_run=false):
 *   1. Stop + disable the base systemd unit.
 *   2. Move base source to repos/<vessel>/archive/<base_version_id>/.
 *   3. Move mitosis source to canonical repos/<vessel>/.
 *   4. Rewrite the (now-canonical) systemd unit so the canonical unit name
 *      points at the canonical path on the original (base) port.
 *   5. Start the newly-canonical unit.
 *
 * In test environments systemctl is mocked via the SYSTEMCTL_CMD env var
 * (default: `systemctl`); when unset and not in a container, we still emit
 * the planned commands but tolerate execution failure.
 *
 * Immunity-pattern: deterministic, no LLM, single resolver.
 */

export interface VesselMitosisCutoverPointer {
  type: "vessel_mitosis_cutover";
  vessel_name: string;
  base_version_id: string;
  mitosis_version_id: string;
  base_root?: string;
  mitosis_root?: string;
  base_unit_name?: string;
  mitosis_unit_name?: string;
  unit_dir?: string;
  evaluation_evidence: {
    verdict: string;
    base_success_rate: number;
    mitosis_success_rate: number;
    cited_trace_ids: string[];
  };
  dry_run?: boolean;
}

const PROTECTED_BASES = new Set(["v0", "baseline"]);
const PROTECTED_VESSELS = new Set(["discovery-vessel", "identity-vessel"]);

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return {
    shape: "structuredError",
    body: {
      resolver: "vessel_mitosis_cutover",
      detail,
      ...(extra ?? {}),
    },
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function runSystemctl(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const cmd = process.env["SYSTEMCTL_CMD"] ?? "systemctl";
  if (process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] === "1") {
    return { exitCode: 0, stderr: "(skipped via env)" };
  }
  try {
    const proc = Bun.spawnSync([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    return { exitCode: proc.exitCode ?? 1, stderr };
  } catch (err) {
    return { exitCode: -1, stderr: (err as Error).message };
  }
}

export async function resolveVesselMitosisCutover(
  pointer: VesselMitosisCutoverPointer,
): Promise<ResolverResult> {
  const {
    vessel_name,
    base_version_id,
    mitosis_version_id,
    evaluation_evidence,
  } = pointer;

  if (!vessel_name || PROTECTED_VESSELS.has(vessel_name)) {
    return structuredError(
      `refusing cutover on protected vessel: ${vessel_name}`,
      { protected_vessels: Array.from(PROTECTED_VESSELS) },
    );
  }
  if (!base_version_id || !mitosis_version_id) {
    return structuredError("base_version_id and mitosis_version_id are required");
  }
  if (
    PROTECTED_BASES.has(base_version_id) ||
    base_version_id === `${vessel_name}-original`
  ) {
    return structuredError(
      `refusing cutover from operator-anchor baseline: ${base_version_id}`,
      { protected_bases: Array.from(PROTECTED_BASES) },
    );
  }
  if (!evaluation_evidence || typeof evaluation_evidence !== "object") {
    return structuredError("evaluation_evidence is required");
  }
  if (evaluation_evidence.verdict !== "FAVORABLE") {
    return structuredError(
      `refusing cutover: verdict must be FAVORABLE (got ${evaluation_evidence.verdict})`,
      { evaluation_evidence },
    );
  }
  if (
    !Array.isArray(evaluation_evidence.cited_trace_ids) ||
    evaluation_evidence.cited_trace_ids.length === 0
  ) {
    return structuredError("evaluation_evidence.cited_trace_ids must be non-empty");
  }

  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  const reposRoot = join(workspaceRoot, "git", "super-repo", "repos");
  const baseRoot = pointer.base_root
    ? resolve(pointer.base_root)
    : join(reposRoot, vessel_name);
  const mitosisRoot = pointer.mitosis_root
    ? resolve(pointer.mitosis_root)
    : null;

  if (!mitosisRoot) {
    return structuredError("mitosis_root is required (cannot infer)");
  }

  if (!(await pathExists(baseRoot))) {
    return structuredError(`base_root not found: ${baseRoot}`);
  }
  if (!(await pathExists(mitosisRoot))) {
    return structuredError(`mitosis_root not found: ${mitosisRoot}`);
  }

  const baseUnitName = pointer.base_unit_name ?? `${vessel_name}.service`;
  const mitosisUnitName =
    pointer.mitosis_unit_name ?? `${vessel_name}-${mitosis_version_id}.service`;
  const unitDir =
    pointer.unit_dir ??
    join(workspaceRoot, "git", "super-repo", "scripts", "substrate", "units");

  const archiveDir = join(baseRoot, "..", `${vessel_name}-archive-${base_version_id}`);

  const plan = {
    stop_base: `${baseUnitName}`,
    disable_base: `${baseUnitName}`,
    move_base_to_archive: archiveDir,
    move_mitosis_to_canonical: baseRoot,
    rewrite_unit: join(unitDir, baseUnitName),
    start_canonical: baseUnitName,
  };

  if (pointer.dry_run) {
    return {
      shape: "vesselMitosisCutoverPlan",
      body: {
        vessel_name,
        base_version_id,
        mitosis_version_id,
        plan,
        verdict_acknowledged: evaluation_evidence.verdict,
      },
    };
  }

  const operations: Array<{ op: string; status: string; detail?: string }> = [];

  // 1. Stop base unit.
  const stop = await runSystemctl(["stop", baseUnitName]);
  operations.push({
    op: `systemctl stop ${baseUnitName}`,
    status: stop.exitCode === 0 ? "ok" : "warn",
    detail: stop.exitCode === 0 ? undefined : stop.stderr.slice(0, 200),
  });

  // 2. Disable base unit (best-effort; not fatal).
  const disable = await runSystemctl(["disable", baseUnitName]);
  operations.push({
    op: `systemctl disable ${baseUnitName}`,
    status: disable.exitCode === 0 ? "ok" : "warn",
    detail: disable.exitCode === 0 ? undefined : disable.stderr.slice(0, 200),
  });

  // 3. Move base to archive.
  try {
    await mkdir(dirname(archiveDir), { recursive: true });
    await rename(baseRoot, archiveDir);
    operations.push({ op: `mv base->archive`, status: "ok", detail: archiveDir });
  } catch (err) {
    operations.push({
      op: `mv base->archive`,
      status: "fail",
      detail: (err as Error).message,
    });
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_cutover",
        detail: `archive move failed: ${(err as Error).message}`,
        operations,
      },
    };
  }

  // 4. Move mitosis to canonical.
  try {
    await rename(mitosisRoot, baseRoot);
    operations.push({ op: `mv mitosis->canonical`, status: "ok", detail: baseRoot });
  } catch (err) {
    operations.push({
      op: `mv mitosis->canonical`,
      status: "fail",
      detail: (err as Error).message,
    });
    // Try to roll back: move archive back to base.
    try {
      await rename(archiveDir, baseRoot);
      operations.push({ op: `rollback archive->base`, status: "ok" });
    } catch (rerr) {
      operations.push({
        op: `rollback archive->base`,
        status: "fail",
        detail: (rerr as Error).message,
      });
    }
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_cutover",
        detail: `canonical move failed: ${(err as Error).message}`,
        operations,
      },
    };
  }

  // 5. Rewrite the unit file so canonical name points at canonical path.
  const canonicalUnitPath = join(unitDir, baseUnitName);
  const mitosisUnitPath = join(unitDir, mitosisUnitName);
  try {
    let unitBody: string | null = null;
    if (await pathExists(mitosisUnitPath)) {
      unitBody = await readFile(mitosisUnitPath, "utf8");
    } else if (await pathExists(canonicalUnitPath)) {
      unitBody = await readFile(canonicalUnitPath, "utf8");
    }
    if (unitBody) {
      const rewritten = unitBody
        .replace(/WorkingDirectory=.*/g, `WorkingDirectory=/vessels/${vessel_name}`)
        .replace(
          /ExecStart=([^\n]+?)\/src\/index\.ts/,
          `ExecStart=$1/src/index.ts`,
        )
        .replace(
          new RegExp(`/vessels/${vessel_name}-mitosis-[^/\n ]+`, "g"),
          `/vessels/${vessel_name}`,
        );
      await writeFile(canonicalUnitPath, rewritten);
      operations.push({ op: `rewrite unit ${baseUnitName}`, status: "ok" });
      if (mitosisUnitPath !== canonicalUnitPath && (await pathExists(mitosisUnitPath))) {
        try {
          await unlink(mitosisUnitPath);
          operations.push({ op: `remove mitosis unit`, status: "ok" });
        } catch (err) {
          operations.push({
            op: `remove mitosis unit`,
            status: "warn",
            detail: (err as Error).message,
          });
        }
      }
    } else {
      operations.push({ op: `rewrite unit ${baseUnitName}`, status: "warn", detail: "no source unit found" });
    }
  } catch (err) {
    operations.push({
      op: `rewrite unit ${baseUnitName}`,
      status: "warn",
      detail: (err as Error).message,
    });
  }

  // 6. daemon-reload + start.
  const reload = await runSystemctl(["daemon-reload"]);
  operations.push({
    op: `systemctl daemon-reload`,
    status: reload.exitCode === 0 ? "ok" : "warn",
    detail: reload.exitCode === 0 ? undefined : reload.stderr.slice(0, 200),
  });
  const start = await runSystemctl(["start", baseUnitName]);
  operations.push({
    op: `systemctl start ${baseUnitName}`,
    status: start.exitCode === 0 ? "ok" : "warn",
    detail: start.exitCode === 0 ? undefined : start.stderr.slice(0, 200),
  });

  return {
    shape: "vesselMitosisCutoverResult",
    body: {
      vessel_name,
      base_version_id,
      mitosis_version_id,
      promoted_to: baseRoot,
      archived_at: archiveDir,
      unit_path: canonicalUnitPath,
      operations,
      cited_evidence: {
        verdict: evaluation_evidence.verdict,
        base_success_rate: evaluation_evidence.base_success_rate,
        mitosis_success_rate: evaluation_evidence.mitosis_success_rate,
        cited_trace_ids: evaluation_evidence.cited_trace_ids.slice(0, 10),
      },
      completed_at: new Date().toISOString(),
    },
  };
}
