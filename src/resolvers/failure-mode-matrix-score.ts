import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT, FAILURE_MODE_SCENARIOS_DIR } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readdir, readFile, writeFile, mkdir, symlink, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface FailureModeMatrixScorePointer {
  type: "failure_mode_matrix_score";
  scenarios_dir: string;      // absolute, or relative to WORKSPACE_ROOT; default FAILURE_MODE_SCENARIOS_DIR
  label?: string;             // cycle tag, e.g. "cycle-9-auto"
  out_path?: string;          // optional disk write of the report (relative or absolute)
}

interface ScenarioFile {
  id?: string;
  expected_emergence?: {
    activity_signature?: {
      output_shapes_must_include?: string[];
    };
  };
}

interface DiscoverResult {
  activities?: Array<{ id?: string }>;
  total?: number;
}

async function discoverByShapes(
  outputShapes: string[],
  auth: Record<string, string>,
): Promise<{ matched: boolean; firstId: string | null }> {
  if (outputShapes.length === 0) return { matched: false, firstId: null };
  try {
    const res = await fetch(`${METABOB_ENDPOINT}/v2/activities/discover-by-shapes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ required_shapes: outputShapes, mode: "forward", limit: 5 }),
    });
    if (!res.ok) return { matched: false, firstId: null };
    const data = await res.json() as DiscoverResult;
    const activities = data.activities ?? [];
    return {
      matched: activities.length > 0,
      firstId: activities[0]?.id ?? null,
    };
  } catch {
    return { matched: false, firstId: null };
  }
}

/**
 * Resolve scenarios_dir: an absolute path as given, a relative one against WORKSPACE_ROOT.
 * Omitted, or the template placeholder left uninterpolated (literal "{{scenarios_dir}}"), it is the
 * volume queue FAILURE_MODE_SCENARIOS_DIR the bridge writes, not a path under the super-repo clone.
 */
export function resolveScenariosDir(raw: string | undefined): string {
  if (!raw || raw === "{{scenarios_dir}}") return FAILURE_MODE_SCENARIOS_DIR;
  return raw.startsWith("/") ? raw : join(WORKSPACE_ROOT, raw);
}

export async function resolveFailureModeMatrixScore(
  pointer: FailureModeMatrixScorePointer,
): Promise<ResolverResult> {
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };
  const label = pointer.label ?? `auto-${Date.now()}`;
  const generatedAt = new Date().toISOString();

  const scenariosDir = resolveScenariosDir(pointer.scenarios_dir);

  // Read all scenario JSON files
  let files: string[] = [];
  try {
    const entries = await readdir(scenariosDir, { withFileTypes: true });
    files = entries
      .filter(e => e.isFile() && e.name.endsWith(".json"))
      .map(e => e.name);
  } catch {
    const body = {
      generated_at: generatedAt,
      label,
      endpoint: `${METABOB_ENDPOINT}/v2/activities/discover-by-shapes`,
      scenarios_run: 0,
      scenarios: [],
      summary: { reuse: 0, new_variant: 0, gap: 0, error: 0 },
    };
    return { shape: "failureModeReport", body };
  }

  const scenarios: Array<{
    scenario_id: string;
    emergence_class: "reuse" | "new" | "gap" | "error";
    matched_existing_activity_id: string | null;
    required_shapes: string[];
    error_note?: string;
  }> = [];

  for (const fname of files) {
    const fpath = join(scenariosDir, fname);
    const scenarioId = fname.replace(/\.json$/, "");
    let scenarioData: ScenarioFile = {};
    try {
      scenarioData = JSON.parse(await readFile(fpath, "utf-8")) as ScenarioFile;
    } catch (err) {
      scenarios.push({
        scenario_id: scenarioId,
        emergence_class: "error",
        matched_existing_activity_id: null,
        required_shapes: [],
        error_note: `parse error: ${String(err).slice(0, 100)}`,
      });
      continue;
    }

    const requiredShapes =
      scenarioData.expected_emergence?.activity_signature?.output_shapes_must_include ?? [];

    try {
      const { matched, firstId } = await discoverByShapes(requiredShapes, auth);
      scenarios.push({
        scenario_id: scenarioId,
        emergence_class: matched ? "reuse" : "gap",
        matched_existing_activity_id: firstId,
        required_shapes: requiredShapes,
      });
    } catch (err) {
      scenarios.push({
        scenario_id: scenarioId,
        emergence_class: "error",
        matched_existing_activity_id: null,
        required_shapes: requiredShapes,
        error_note: String(err).slice(0, 100),
      });
    }
  }

  const summary = {
    reuse: scenarios.filter(s => s.emergence_class === "reuse").length,
    new_variant: 0, // v1: no distinction between new and gap
    gap: scenarios.filter(s => s.emergence_class === "gap").length,
    error: scenarios.filter(s => s.emergence_class === "error").length,
  };

  const body = {
    generated_at: generatedAt,
    label,
    endpoint: `${METABOB_ENDPOINT}/v2/activities/discover-by-shapes`,
    scenarios_run: scenarios.length,
    scenarios,
    summary,
  };

  // Optional disk write for progression-driver compatibility.
  // Also atomically updates latest-failure-mode-report.json symlink so the
  // boredom-vessel goal[7] always reads the freshest report without manual
  // operator intervention. Eliminates the last hand-off point in the
  // draft-gap-closing-activity → harness → next-cycle autonomous loop.
  if (pointer.out_path) {
    const outPath = pointer.out_path.startsWith("/")
      ? pointer.out_path
      : join(WORKSPACE_ROOT, pointer.out_path);
    try {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(body, null, 2));
      // Update the canonical symlink used by boredom-vessel goal[7].
      const symlinkPath = join(WORKSPACE_ROOT, "validation/results/latest-failure-mode-report.json");
      await mkdir(dirname(symlinkPath), { recursive: true });
      try { await unlink(symlinkPath); } catch { /* ok if not yet present */ }
      await symlink(outPath, symlinkPath);
    } catch { /* non-critical */ }
  }

  return { shape: "failureModeReport", body };
}
