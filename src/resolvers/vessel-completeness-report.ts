import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * vessel_completeness_report — substrate-self-detection of vessel scaffold
 * completeness. Compares each vessel under WORKSPACE_ROOT/repos/* (or an
 * override path) against the canonical "complete vessel" structure derived
 * empirically from healthy vessels.
 *
 * The canonical structure is computed at runtime as the intersection of
 * filenames present in every healthy vessel — a vessel that has emitted at
 * least one trace in the last 24h (via the optional healthyVessels override)
 * counts as healthy. Falls back to a hard-coded baseline if no healthy set is
 * supplied (TypeScript vessel template doc lists ~5 required files).
 *
 * Had this existed pre-2026-06-02, clock-vessel would have been flagged as
 * incomplete (no discovery-registration.ts, no src/index.ts).
 *
 * Immunity-pattern compliant: single resolver, no LLM, no iteration.
 */

export interface VesselCompletenessReportPointer {
  type: "vessel_completeness_report";
  /** Root containing vessel dirs. Default WORKSPACE_ROOT/repos. */
  reposRoot?: string;
  /** Override vessel names to treat as the healthy reference set. Optional. */
  healthyVessels?: string[];
  /** Files that MUST exist (fallback baseline if no healthy ref set). */
  fallbackRequired?: string[];
  /** Vessels to exclude (e.g. legacy submodules). */
  excludeVessels?: string[];
}

const FALLBACK_REQUIRED = [
  "package.json",
  "tsconfig.json",
  "src/config.ts",
  "src/index.ts",
  "src/routes/impulses.ts",
  "src/discovery-registration.ts",
];

/** Vessels that are known not to follow the standard scaffold (legacy/external). */
const DEFAULT_EXCLUDES = new Set<string>([
  "node_modules",
  "deployment",
  "vessels",
]);

interface IncompleteVesselEntry {
  vessel_name: string;
  vessel_path: string;
  missing_files: string[];
  present_files: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listVessels(reposRoot: string, excludes: Set<string>): Promise<string[]> {
  try {
    const entries = await readdir(reposRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !excludes.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function checkFiles(
  vesselPath: string,
  required: string[],
): Promise<{ missing: string[]; present: string[] }> {
  const missing: string[] = [];
  const present: string[] = [];
  for (const rel of required) {
    if (await exists(join(vesselPath, rel))) present.push(rel);
    else missing.push(rel);
  }
  return { missing, present };
}

export async function resolveVesselCompletenessReport(
  pointer: VesselCompletenessReportPointer,
): Promise<ResolverResult> {
  const reposRoot = pointer.reposRoot ?? join(WORKSPACE_ROOT, "repos");
  const excludes = new Set<string>(DEFAULT_EXCLUDES);
  for (const e of pointer.excludeVessels ?? []) excludes.add(e);
  const fallbackRequired = pointer.fallbackRequired ?? FALLBACK_REQUIRED;

  const allVessels = await listVessels(reposRoot, excludes);
  if (allVessels.length === 0) {
    return {
      shape: "vesselCompletenessReport",
      body: {
        repos_root: reposRoot,
        scanned: 0,
        canonical_structure: fallbackRequired,
        canonical_source: "fallback_baseline",
        incomplete_vessels: [],
        complete_count: 0,
        incomplete_count: 0,
        health_verdict: "HEALTHY",
        completed_at: new Date().toISOString(),
      },
    };
  }

  // 1. Derive canonical structure.
  let canonical: string[];
  let canonicalSource: string;
  if (pointer.healthyVessels && pointer.healthyVessels.length > 0) {
    const healthyChecks = await Promise.all(
      pointer.healthyVessels.map(async (v) => {
        const vPath = join(reposRoot, v);
        const candidate = await checkFiles(vPath, fallbackRequired);
        return candidate.present;
      }),
    );
    if (healthyChecks.length > 0) {
      const first = healthyChecks[0] ?? [];
      const intersection = first.filter((f) =>
        healthyChecks.every((set) => set.includes(f)),
      );
      canonical = intersection.length > 0 ? intersection : fallbackRequired;
      canonicalSource = "healthy_vessel_intersection";
    } else {
      canonical = fallbackRequired;
      canonicalSource = "fallback_baseline";
    }
  } else {
    canonical = fallbackRequired;
    canonicalSource = "fallback_baseline";
  }

  // 2. Scan each vessel.
  const incomplete: IncompleteVesselEntry[] = [];
  let completeCount = 0;
  for (const vessel of allVessels) {
    const vPath = join(reposRoot, vessel);
    const { missing, present } = await checkFiles(vPath, canonical);
    if (missing.length === 0) {
      completeCount++;
    } else {
      incomplete.push({
        vessel_name: vessel,
        vessel_path: vPath,
        missing_files: missing,
        present_files: present,
      });
    }
  }

  incomplete.sort((a, b) => b.missing_files.length - a.missing_files.length);

  let healthVerdict: "HEALTHY" | "DEGRADED" | "BLOCKED";
  if (incomplete.length === 0) healthVerdict = "HEALTHY";
  else if (incomplete.length <= 3) healthVerdict = "DEGRADED";
  else healthVerdict = "BLOCKED";

  return {
    shape: "vesselCompletenessReport",
    body: {
      repos_root: reposRoot,
      scanned: allVessels.length,
      canonical_structure: canonical,
      canonical_source: canonicalSource,
      complete_count: completeCount,
      incomplete_count: incomplete.length,
      incomplete_vessels: incomplete,
      health_verdict: healthVerdict,
      completed_at: new Date().toISOString(),
    },
  };
}
