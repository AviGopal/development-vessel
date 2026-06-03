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
 * v0.2 (2026-06-03): When a base systemd unit is present (under
 * scripts/substrate/units/<vessel>.service), parse it and PRESERVE all
 * Environment=, Memory*, Restart*, After=, and Requires= directives from
 * the base unit into the generated mitosis unit. This closes the parity
 * gap the first goal-host mitosis exposed (mitosis ran uncapped + without
 * LLM_VESSEL_ENDPOINT). Mitosis-specific overrides (PORT, VESSEL_ID,
 * VESSEL_ENDPOINT, WorkingDirectory, ExecStart, Description) still win.
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
  base_unit_path?: string;
}

const PROTECTED_VESSELS = new Set(["discovery-vessel", "identity-vessel"]);
const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

// Directives whose values mitosis must override (not inherit). Everything
// else found in the base unit's [Service] section is preserved verbatim.
const MITOSIS_OVERRIDE_SERVICE_KEYS = new Set([
  "WorkingDirectory",
  "ExecStart",
  // PORT, VESSEL_ID, VESSEL_ENDPOINT, MITOSIS_* are Environment= entries
  // handled specially in mergeEnvironment.
]);

// Environment keys mitosis must own. Any base Environment=KEY=... that
// matches one of these is dropped in favor of the mitosis value.
const MITOSIS_OWNED_ENV_KEYS = new Set([
  "PORT",
  "VESSEL_ID",
  "VESSEL_ENDPOINT",
  "WORKSPACE_ROOT",
  "MITOSIS_VERSION_ID",
  "MITOSIS_BASE_VESSEL",
]);

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

// ---- Systemd unit parsing + merge (v0.2) ----

interface ParsedUnitLine {
  raw: string;        // original line as-written (for comments/blanks)
  key?: string;       // directive key if "Key=Value"
  value?: string;     // directive value
}

interface ParsedUnit {
  // Order-preserving line list per section, plus the section's header line.
  // Sections appear in insertion order; lines preserved verbatim.
  sectionsOrder: string[];
  sections: Map<string, ParsedUnitLine[]>;
}

function parseUnitFile(content: string): ParsedUnit {
  const sectionsOrder: string[] = [];
  const sections = new Map<string, ParsedUnitLine[]>();
  let current: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine;
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sec = sectionMatch[1] ?? "";
      current = sec;
      if (!sections.has(sec)) {
        sectionsOrder.push(sec);
        sections.set(sec, []);
      }
      continue;
    }
    if (!current) continue; // ignore preamble (shouldn't exist in systemd units)
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      sections.get(current)!.push({ raw: line });
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) {
      sections.get(current)!.push({ raw: line });
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1);
    sections.get(current)!.push({ raw: line, key, value });
  }
  return { sectionsOrder, sections };
}

function serializeUnit(unit: ParsedUnit): string {
  const out: string[] = [];
  for (const section of unit.sectionsOrder) {
    out.push(`[${section}]`);
    const lines = unit.sections.get(section) ?? [];
    for (const l of lines) {
      out.push(l.raw);
    }
    // Ensure blank separator between sections if not already trailing.
    const last = out[out.length - 1];
    if (last !== undefined && last.trim() !== "") out.push("");
  }
  // Trim trailing extra blank lines, leave one final newline.
  while (
    out.length > 1 &&
    out[out.length - 1] === "" &&
    out[out.length - 2] === ""
  ) {
    out.pop();
  }
  if (out[out.length - 1] !== "") out.push("");
  return out.join("\n");
}

/**
 * Merge a base unit with mitosis overrides:
 *  - Preserve all base [Unit] directives (After=, Requires=, Description= base value).
 *  - Override Description= in [Unit] by appending mitosis stamp + intent.
 *  - Preserve all base [Service] directives EXCEPT:
 *      - WorkingDirectory, ExecStart → replaced
 *      - Environment=KEY=... where KEY ∈ MITOSIS_OWNED_ENV_KEYS → dropped
 *  - Append mitosis-specific overrides at end of [Service].
 *  - Preserve [Install] verbatim.
 */
function mergeUnitForMitosis(
  base: ParsedUnit,
  overrides: {
    description: string;
    workingDirectory: string;
    execStart: string;
    addedEnv: Array<{ key: string; value: string }>;
  },
): ParsedUnit {
  // Deep-ish copy.
  const merged: ParsedUnit = {
    sectionsOrder: [...base.sectionsOrder],
    sections: new Map(),
  };
  for (const [sec, lines] of base.sections) {
    merged.sections.set(sec, lines.map((l) => ({ ...l })));
  }

  // Ensure required sections.
  for (const sec of ["Unit", "Service", "Install"]) {
    if (!merged.sections.has(sec)) {
      merged.sectionsOrder.push(sec);
      merged.sections.set(sec, []);
    }
  }

  // [Unit] — override Description.
  const unitLines = merged.sections.get("Unit")!;
  let descSet = false;
  for (const l of unitLines) {
    if (l.key === "Description") {
      l.raw = `Description=${overrides.description}`;
      l.value = overrides.description;
      descSet = true;
      break;
    }
  }
  if (!descSet) {
    unitLines.unshift({ raw: `Description=${overrides.description}`, key: "Description", value: overrides.description });
  }

  // [Service] — drop overridden keys + owned Environment entries.
  const serviceLines = merged.sections.get("Service")!;
  const filteredService: ParsedUnitLine[] = [];
  for (const l of serviceLines) {
    if (l.key && MITOSIS_OVERRIDE_SERVICE_KEYS.has(l.key)) continue;
    if (l.key === "Environment" && typeof l.value === "string") {
      // Drop owned env keys.
      const eq = l.value.indexOf("=");
      const envKey = eq >= 0 ? l.value.slice(0, eq).trim() : l.value.trim();
      if (MITOSIS_OWNED_ENV_KEYS.has(envKey)) continue;
    }
    filteredService.push(l);
  }
  // Append mitosis-owned directives.
  const lastService = filteredService[filteredService.length - 1];
  if (lastService !== undefined && lastService.raw.trim() !== "") {
    filteredService.push({ raw: "" });
  }
  filteredService.push({ raw: "# --- mitosis overrides (v0.2 vessel_mitosis_start) ---" });
  for (const env of overrides.addedEnv) {
    const raw = `Environment=${env.key}=${env.value}`;
    filteredService.push({ raw, key: "Environment", value: `${env.key}=${env.value}` });
  }
  filteredService.push({ raw: `WorkingDirectory=${overrides.workingDirectory}`, key: "WorkingDirectory", value: overrides.workingDirectory });
  filteredService.push({ raw: `ExecStart=${overrides.execStart}`, key: "ExecStart", value: overrides.execStart });
  merged.sections.set("Service", filteredService);

  // Ensure [Install] has at least WantedBy=multi-user.target if empty.
  const installLines = merged.sections.get("Install")!;
  const hasWantedBy = installLines.some((l) => l.key === "WantedBy");
  if (!hasWantedBy) {
    installLines.push({ raw: "WantedBy=multi-user.target", key: "WantedBy", value: "multi-user.target" });
  }

  return merged;
}

// Exposed for tests.
export const __test = {
  parseUnitFile,
  serializeUnit,
  mergeUnitForMitosis,
};

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

  // 4. Generate systemd unit file — v0.2 merge path.
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
  const description = `${vessel_name} (mitosis ${stamp}) — ${safeIntent}`;
  const workDir = `/vessels/${vessel_name}-mitosis-${stamp}`;
  const execStart = `/root/.bun/bin/bun ${workDir}/src/index.ts`;
  const mitosisEnv = [
    { key: "PORT", value: String(mitosis_port) },
    { key: "WORKSPACE_ROOT", value: "/workspace" },
    { key: "VESSEL_ID", value: `${vessel_name}-${version_id}` },
    { key: "VESSEL_ENDPOINT", value: `http://127.0.0.1:${mitosis_port}` },
    { key: "MITOSIS_VERSION_ID", value: version_id },
    { key: "MITOSIS_BASE_VESSEL", value: vessel_name },
  ];

  // Locate the base unit. Caller may override; default is
  // <unitDir>/<vessel_name>.service.
  const baseUnitPath = pointer.base_unit_path
    ? resolve(pointer.base_unit_path)
    : join(unitDir, `${vessel_name}.service`);

  let unitBody: string;
  let baseUnitMerged = false;
  let preservedDirectives: Record<string, number> = {};
  if (await pathExists(baseUnitPath)) {
    try {
      const baseContent = await readFile(baseUnitPath, "utf8");
      const parsed = parseUnitFile(baseContent);
      const merged = mergeUnitForMitosis(parsed, {
        description,
        workingDirectory: workDir,
        execStart,
        addedEnv: mitosisEnv,
      });
      unitBody = serializeUnit(merged);
      baseUnitMerged = true;
      // Summarise preserved directives (for the result body).
      const serviceLines = merged.sections.get("Service") ?? [];
      const counts: Record<string, number> = {};
      for (const l of serviceLines) {
        if (l.key) counts[l.key] = (counts[l.key] ?? 0) + 1;
      }
      preservedDirectives = counts;
    } catch (err) {
      // Fall back to minimal unit. Log via result body; do not throw.
      console.warn(
        `[vessel_mitosis_start] base unit parse failed (${err instanceof Error ? err.message : err}); falling back to minimal unit`,
      );
      unitBody = buildMinimalUnit({
        description,
        workDir,
        execStart,
        mitosisEnv,
      });
    }
  } else {
    unitBody = buildMinimalUnit({
      description,
      workDir,
      execStart,
      mitosisEnv,
    });
  }

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
      base_unit_path: baseUnitPath,
      base_unit_merged: baseUnitMerged,
      preserved_service_directives: preservedDirectives,
      port_rewrite_applied: portRewriteApplied,
      copy_stats: copyStats,
      applied_changes: appliedChanges,
      mitosis_resolver_version: "v0.2",
      initiated_at: new Date().toISOString(),
    },
  };
}

function buildMinimalUnit(args: {
  description: string;
  workDir: string;
  execStart: string;
  mitosisEnv: Array<{ key: string; value: string }>;
}): string {
  const envLines = args.mitosisEnv
    .map((e) => `Environment=${e.key}=${e.value}`)
    .join("\n");
  return `[Unit]
Description=${args.description}
After=activity-api.service
Requires=activity-api.service

[Service]
Type=simple
EnvironmentFile=/etc/substrate/env
${envLines}
Environment=HOST=0.0.0.0
WorkingDirectory=${args.workDir}
ExecStart=${args.execStart}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}
