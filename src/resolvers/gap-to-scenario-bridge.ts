/**
 * gap_to_scenario_bridge — gap → drafter input boundary bridge.
 *
 * Detector-derived substrateGap impulses land in WORKSPACE_ROOT/gaps/gaps.json,
 * but draft-gap-closing-activity reads scenario JSON files from
 * WORKSPACE_ROOT/validation/failure-modes/scenarios/<id>.json. Without a
 * bridge, the drafter never absorbs operator-seeded or detector-emitted gaps.
 *
 * This resolver scans gaps.json for status=="open" gaps with source in
 * (operator_seed, substrate_detected), and for each gap that does NOT yet
 * have a scenario file, writes one in the shape the drafter expects (mirrors
 * the existing auto-*.json scenarios already on disk).
 *
 * Idempotent: skips if scenarios/<sanitized-gap-id>.json already exists.
 * Bounded: limit (default 10) per invocation so a large backlog drains over
 * many ticks without bursting.
 *
 * Companion seed template: gap-to-scenario-bridge-tick (single-task wrapper).
 */

import { WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

function workspaceRoot(): string {
  return process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
}

export interface GapToScenarioBridgePointer {
  type: "gap_to_scenario_bridge";
  gaps_path?: string;
  scenarios_dir?: string;
  /** Queue for vessel-authoring scenarios (missing_capability gaps). */
  vessel_scenarios_dir?: string;
  limit?: number;
}

// Categories the recombination drafter (draft-gap-closing-activity) cannot
// close: by construction it only recombines EXISTING resolvers, so a gap whose
// fix requires a NEW resolver/vessel ("no vessel advertises shape X") will
// never be satisfied by a drafted template (SUBSTRATE_AS_MDP §8.5). These are
// routed to a separate queue tagged for the vessel-authoring path instead of
// being funnelled into the drafter's scenario folder, where they would churn
// the drafter's rate-limit + Thompson budget on a structurally-unclosable gap.
const VESSEL_AUTHORING_CATEGORIES = new Set<string>(["missing_capability"]);

// The activity a routed gap recommends as its consumer. Mirrors the
// `target_template_id` routing convention used by enact-orthogonal-decisions.
const RECOMBINATION_TARGET = "development-vessel:draft-gap-closing-activity";
const VESSEL_AUTHORING_TARGET = "development-vessel:scaffold-and-publish-vessel";

interface GapRow {
  id?: unknown;
  category?: unknown;
  source?: unknown;
  summary?: unknown;
  status?: unknown;
  created_at?: unknown;
  classification_metadata?: Record<string, unknown> | null;
}

// Architecture-class gap categories drained before trace_quality / incidental.
// Order within the list is also a tiebreaker (earlier = higher priority).
const PRIORITY_CATEGORIES: string[] = [
  "architectural_pattern",
  "resolver_distribution",
  "responsibility_misallocation",
  "missing_capability",
  "activity_lifecycle",
  "missing_concept",
  "detector_output_shape_mismatch",
];

function rankOf(g: GapRow): number {
  const cat = typeof g.category === "string" ? g.category : "";
  const idx = PRIORITY_CATEGORIES.indexOf(cat);
  return idx === -1 ? PRIORITY_CATEGORIES.length : idx;
}

function sanitizeId(id: string): string {
  return id.replace(/:/g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Collapse a sanitized gap-id to its CLASS by cutting at the first timestamp or
 * exec-id marker. e.g. `arch-pattern-catalogue-bloat-1781426564164` and
 * `dispatch-target-drift-exec_h14758l3-1781007064750` both reduce to their bare
 * class name. Detectors re-emit the same gap CLASS with a fresh timestamp every
 * window; without class-level dedup the bridge materialised thousands of
 * near-duplicate scenarios (7860 files over ~50 classes observed 2026-06-14),
 * which dilutes the drafter's random pick so a genuinely NEW gap class waits
 * O(file_count) ticks to be authored. Class dedup keeps one scenario per class
 * so new classes surface immediately. Falls back to the full id if stripping
 * would over-collapse (id is all timestamp).
 */
function classKey(sanitizedId: string): string {
  const cut = sanitizedId.replace(/([-_]exec_|[-_][0-9]{10,}).*$/i, "");
  return cut.length >= 4 ? cut : sanitizedId;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Existing scenario CLASSES already on disk in `dir` (for class-level dedup). */
async function existingClasses(dir: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const { readdir } = await import("node:fs/promises");
    for (const f of await readdir(dir)) {
      if (f.endsWith(".json")) set.add(classKey(f.slice(0, -5)));
    }
  } catch { /* dir absent yet */ }
  return set;
}

export async function resolveGapToScenarioBridge(
  pointer: GapToScenarioBridgePointer,
): Promise<ResolverResult> {
  const root = workspaceRoot();
  const gapsPath = pointer.gaps_path ?? join(root, "gaps", "gaps.json");
  const scenariosDir = pointer.scenarios_dir ?? join(root, "validation", "failure-modes", "scenarios");
  const vesselScenariosDir =
    pointer.vessel_scenarios_dir ?? join(root, "validation", "failure-modes", "vessel-scenarios");
  const limit = Math.min(Math.max(pointer.limit ?? 10, 1), 100);

  let gaps: GapRow[] = [];
  try {
    const raw = await readFile(gapsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) gaps = parsed as GapRow[];
  } catch {
    return {
      shape: "bridgeResult",
      body: {
        scenarios_written: 0,
        gaps_skipped_existing: 0,
        gaps_examined: 0,
        scenarios: [],
        note: `gaps file unreadable: ${gapsPath}`,
      },
    };
  }

  await mkdir(scenariosDir, { recursive: true });
  await mkdir(vesselScenariosDir, { recursive: true });

  // Class-level dedup state: one scenario per gap CLASS (not per timestamped id).
  const seenClasses = await existingClasses(scenariosDir);
  const seenVesselClasses = await existingClasses(vesselScenariosDir);
  let skippedClassDup = 0;

  const ALLOWED_SOURCES = new Set(["operator_seed", "substrate_detected"]);
  const out: Array<{ gap_id: string; scenario_path: string }> = [];
  const vesselOut: Array<{ gap_id: string; scenario_path: string }> = [];
  const priorityBreakdown: Record<string, number> = {};
  let skippedExisting = 0;
  let examined = 0;

  // Sort by (priority rank ascending, then created_at ascending so older
  // priority gaps drain first). Stable on equal keys.
  const sorted = [...gaps].sort((a, b) => {
    const pa = rankOf(a);
    const pb = rankOf(b);
    if (pa !== pb) return pa - pb;
    const ta = typeof a.created_at === "string" ? a.created_at : "";
    const tb = typeof b.created_at === "string" ? b.created_at : "";
    return ta.localeCompare(tb);
  });

  const { rename } = await import("node:fs/promises");

  for (const g of sorted) {
    if (out.length + vesselOut.length >= limit) break;
    const id = typeof g.id === "string" ? g.id : null;
    const status = typeof g.status === "string" ? g.status : "";
    const source = typeof g.source === "string" ? g.source : "";
    if (!id || status !== "open" || !ALLOWED_SOURCES.has(source)) continue;
    examined += 1;

    const summary = typeof g.summary === "string" ? g.summary : "";
    const meta = (g.classification_metadata ?? {}) as Record<string, unknown>;
    const category = typeof g.category === "string" ? g.category : "auto";
    const isVesselAuthoring = VESSEL_AUTHORING_CATEGORIES.has(category);

    const safeId = sanitizeId(id);
    const targetDir = isVesselAuthoring ? vesselScenariosDir : scenariosDir;
    const scenarioPath = join(targetDir, `${safeId}.json`);
    if (await exists(scenarioPath)) { skippedExisting += 1; continue; }

    // Class-level dedup: if a scenario of this gap CLASS already exists, the
    // drafter is already covering it — re-materialising a fresh-timestamped
    // duplicate only dilutes the drafter's pick. Skip it.
    const ck = classKey(safeId);
    const classSet = isVesselAuthoring ? seenVesselClasses : seenClasses;
    if (classSet.has(ck)) { skippedClassDup += 1; continue; }

    // Capability gaps ("no vessel advertises shape X") need a NEW resolver,
    // not a recombination of existing ones — route them to the vessel-authoring
    // path. Carry the demanded shape + sample consumers so the downstream
    // dispatcher (scaffold-and-publish-vessel) has actionable inputs.
    const scenario = isVesselAuthoring
      ? {
          id: safeId,
          routing_class: "vessel_authoring",
          target_template_id: VESSEL_AUTHORING_TARGET,
          mode_class: category,
          stage: "vessel_authoring",
          outcome_class: "gap",
          title: summary.slice(0, 120) || `Capability gap ${safeId}`,
          description: summary,
          goal_text: summary,
          capability_shape:
            typeof meta["shape"] === "string" ? meta["shape"] : null,
          demanding_template_count:
            typeof meta["template_count"] === "number" ? meta["template_count"] : null,
          sample_template_ids: Array.isArray(meta["sample_template_ids"])
            ? meta["sample_template_ids"]
            : [],
          gap_subtype: typeof meta["gap_subtype"] === "string" ? meta["gap_subtype"] : null,
          cite_principle: typeof meta["cite_principle"] === "string" ? meta["cite_principle"] : null,
          operator_seed: false,
          bridge_source: "gap_to_scenario_bridge",
          source_gap_id: id,
          source_gap_source: source,
        }
      : {
          id: safeId,
          routing_class: "recombination",
          target_template_id: RECOMBINATION_TARGET,
          mode_class: category,
          stage: "detection",
          outcome_class: "gap",
          title: summary.slice(0, 120) || `Gap ${safeId}`,
          description: summary,
          goal_text: summary,
          expected_input_shapes: [] as string[],
          expected_output_shapes: [] as string[],
          cite_principle: typeof meta["cite_principle"] === "string" ? meta["cite_principle"] : null,
          target_file_paths: Array.isArray(meta["cited_evidence"]) ? meta["cited_evidence"] : [],
          operator_seed: false,
          bridge_source: "gap_to_scenario_bridge",
          source_gap_id: id,
          source_gap_source: source,
        };

    const tmp = `${scenarioPath}.tmp`;
    await writeFile(tmp, JSON.stringify(scenario, null, 2), "utf-8");
    await rename(tmp, scenarioPath);
    classSet.add(ck);
    (isVesselAuthoring ? vesselOut : out).push({ gap_id: id, scenario_path: scenarioPath });
    priorityBreakdown[category] = (priorityBreakdown[category] ?? 0) + 1;
  }

  return {
    shape: "bridgeResult",
    body: {
      // V7 (2026-06-05): explicit idempotency counts. Existing fields kept
      // for back-compat; `created` / `already_present` are the canonical
      // labels surfaced to observers + the probe harness so successive
      // dispatches with the same gap set show created=0.
      // `created` is the canonical TOTAL across both routing classes so a tick
      // that only emitted vessel-authoring scenarios still reports created>0.
      created: out.length + vesselOut.length,
      already_present: skippedExisting,
      // Class-duplicate gaps skipped: same gap CLASS already has a scenario
      // (detectors re-emit the class with a fresh timestamp every window).
      skipped_class_duplicate: skippedClassDup,
      // Back-compat: scenarios_written / scenarios remain recombination-only,
      // since existing observers + tests key on the drafter's scenario folder.
      scenarios_written: out.length,
      vessel_authoring_scenarios_written: vesselOut.length,
      gaps_skipped_existing: skippedExisting,
      gaps_examined: examined,
      gaps_total: gaps.length,
      scenarios: out,
      vessel_scenarios: vesselOut,
      vessel_scenarios_dir: vesselScenariosDir,
      priority_breakdown: priorityBreakdown,
      completed_at: new Date().toISOString(),
    },
  };
}
