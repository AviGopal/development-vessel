import { resolve, relative, dirname, join } from "path";
import { mkdir, readdir, copyFile, readFile, writeFile, stat } from "node:fs/promises";
import type { ResolverResult } from "./types.js";

/**
 * vessel_mitosis_start — operator-side primitive that spawns a parallel-track
 * copy of an existing vessel so two versions can run simultaneously and be
 * evaluated empirically (via authoring_chain_health_report, code_needs_report,
 * etc.) before cutover.
 *
 * This is the keystone of self-modification: instead of operator-fixing a vessel
 * in place, the substrate (or operator) drafts a new track and lets the
 * detectors compare. Cutover happens only when the new track's evidence
 * dominates.
 *
 * Safety:
 *   - Refuses mitosis on H4-load-bearing baselines: discovery-vessel,
 *     identity-vessel.
 *   - mitosis_root MUST NOT overlap base vessel directory.
 *   - source_changes apply only to files within mitosis_root (validated via
 *     workspace-relative path constraint).
 *
 * Immunity-pattern: deterministic, no LLM, single-resolver.
 */

export interface VesselMitosisStartPointer {
  type: "vessel_mitosis_start";
  vessel_name: string;
  intent_summary: string;
  source_changes: Array<{
    target_path: string;
    new_content: string;
  }>;
  base_port: number;
  mitosis_port: number;
  source_root?: string;
  mitosis_root?: string;
}

const PROTECTED_VESSELS = new Set(["discovery-vessel", "identity-vessel"]);
const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return {
    shape: "structuredError",
    body: {
      resolver: "vessel_mitosis_start",
      detail,
      ...(extra ?? {}),
    },
  };
}

async function copyTree(src: string, dst: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dst, { recursive: true });
  for (const ent of entries) {
    if (EXCLUDE_DIRS.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isDirectory()) {
      const sub = await copyTree(s, d);
      files += sub.files;
      bytes += sub.bytes;
    } else if (ent.isFile()) {
      await copyFile(s, d);
      const st = await stat(d);
      files += 1;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isoCompact(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function pathsOverlap(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  if (ra === rb) return true;
  const relAB = relative(ra, rb);
  const relBA = relative(rb, ra);
  return !relAB.startsWith("..") || !relBA.startsWith("..");
}

export async function resolveVesselMitosisStart(
  pointer: VesselMitosisStartPointer,
): Promise<ResolverResult> {
  const {
    vessel_name,
    intent_summary,
    source_changes,
    base_port,
    mitosis_port,
  } = pointer;

  if (!vessel_name || typeof vessel_name !== "string") {
    return structuredError("vessel_name is required");
  }
  if (PROTECTED_VESSELS.has(vessel_name)) {
    return structuredError(
      `refusing mitosis on H4-load-bearing baseline vessel: ${vessel_name}`,
      { protected_vessels: Array.from(PROTECTED_VESSELS) },
    );
  }
  if (!intent_summary || typeof intent_summary !== "string") {
    return structuredError("intent_summary is required");
  }
  if (!Array.isArray(source_changes)) {
    return structuredError("source_changes must be an array");
  }
  if (typeof base_port !== "number" || typeof mitosis_port !== "number") {
    return structuredError("base_port and mitosis_port must be numbers");
  }
  if (base_port === mitosis_port) {
    return structuredError("base_port and mitosis_port must differ");
  }

  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  const defaultSourceRoot = join(
    workspaceRoot,
    "git",
    "super-repo",
    "repos",
    vessel_name,
  );
  const sourceRoot = pointer.source_root
    ? resolve(pointer.source_root)
    : defaultSourceRoot;

  const stamp = isoCompact();
  const defaultMitosisRoot = `${sourceRoot}-mitosis-${stamp}`;
  const mitosisRoot = pointer.mitosis_root
    ? resolve(pointer.mitosis_root)
    : defaultMitosisRoot;

  if (!(await pathExists(sourceRoot))) {
    return structuredError(`base vessel source_root not found: ${sourceRoot}`);
  }

  if (pathsOverlap(sourceRoot, mitosisRoot)) {
    return structuredError(
      `mitosis_root overlaps base source_root — refusing copy`,
      { source_root: sourceRoot, mitosis_root: mitosisRoot },
    );
  }

  if (await pathExists(mitosisRoot)) {
    return structuredError(`mitosis_root already exists: ${mitosisRoot}`);
  }

  // 1. Copy tree.
  const copyStats = await copyTree(sourceRoot, mitosisRoot);

  // 2. Apply source_changes.
  const appliedChanges: string[] = [];
  for (const change of source_changes) {
    if (!change || typeof change.target_path !== "string") {
      return structuredError("each source_changes entry needs target_path string");
    }
    const dst = resolve(mitosisRoot, change.target_path);
    const rel = relative(mitosisRoot, dst);
    if (rel.startsWith("..")) {
      return structuredError(
        `target_path escapes mitosis_root: ${change.target_path}`,
      );
    }
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, change.new_content ?? "");
    appliedChanges.push(change.target_path);
  }

  // 3. Override PORT default in src/config.ts (best-effort regex).
  const configPath = join(mitosisRoot, "src", "config.ts");
  let portRewriteApplied = false;
  if (await pathExists(configPath)) {
    const original = await readFile(configPath, "utf8");
    const portRegex = new RegExp(
      `(PORT\\s*=\\s*parseInt\\(\\s*process\\.env\\["PORT"\\]\\s*\\?\\?\\s*")(\\d+)(")`,
    );
    if (portRegex.test(original)) {
      const updated = original.replace(portRegex, `$1${mitosis_port}$3`);
      await writeFile(configPath, updated);
      portRewriteApplied = true;
    }
  }

  // 4. Generate systemd unit file.
  const version_id = `mitosis-${stamp}`;
  const unitName = `${vessel_name}-mitosis-${stamp}.service`;
  const unitDir = join(
    workspaceRoot,
    "git",
    "super-repo",
    "scripts",
    "substrate",
    "units",
  );
  const unitPath = join(unitDir, unitName);
  const safeIntent = intent_summary.replace(/[\r\n]+/g, " ").slice(0, 200);
  const unitBody = `[Unit]
Description=${vessel_name} (mitosis ${stamp}) — ${safeIntent}
After=activity-api.service
Requires=activity-api.service

[Service]
Type=simple
EnvironmentFile=/etc/substrate/env
Environment=PORT=${mitosis_port}
Environment=HOST=0.0.0.0
Environment=WORKSPACE_ROOT=/workspace
Environment=VESSEL_ID=${vessel_name}-${version_id}
Environment=VESSEL_ENDPOINT=http://127.0.0.1:${mitosis_port}
Environment=MITOSIS_VERSION_ID=${version_id}
Environment=MITOSIS_BASE_VESSEL=${vessel_name}
WorkingDirectory=/vessels/${vessel_name}-mitosis-${stamp}
ExecStart=/root/.bun/bin/bun /vessels/${vessel_name}-mitosis-${stamp}/src/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;

  let unitWritten = false;
  if (await pathExists(unitDir)) {
    await writeFile(unitPath, unitBody);
    unitWritten = true;
  }

  return {
    shape: "vesselMitosisInitiated",
    body: {
      vessel_name,
      version_id,
      base_version_id: "v1",
      intent_summary: safeIntent,
      source_root: sourceRoot,
      mitosis_root: mitosisRoot,
      mitosis_port,
      base_port,
      systemd_unit_path: unitWritten ? unitPath : null,
      systemd_unit_present: unitWritten,
      port_rewrite_applied: portRewriteApplied,
      copy_stats: copyStats,
      applied_changes: appliedChanges,
      initiated_at: new Date().toISOString(),
    },
  };
}
