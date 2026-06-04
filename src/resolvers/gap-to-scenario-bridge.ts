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
  limit?: number;
}

interface GapRow {
  id?: unknown;
  category?: unknown;
  source?: unknown;
  summary?: unknown;
  status?: unknown;
  classification_metadata?: Record<string, unknown> | null;
}

function sanitizeId(id: string): string {
  return id.replace(/:/g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function resolveGapToScenarioBridge(
  pointer: GapToScenarioBridgePointer,
): Promise<ResolverResult> {
  const root = workspaceRoot();
  const gapsPath = pointer.gaps_path ?? join(root, "gaps", "gaps.json");
  const scenariosDir = pointer.scenarios_dir ?? join(root, "validation", "failure-modes", "scenarios");
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

  const ALLOWED_SOURCES = new Set(["operator_seed", "substrate_detected"]);
  const out: Array<{ gap_id: string; scenario_path: string }> = [];
  let skippedExisting = 0;
  let examined = 0;

  for (const g of gaps) {
    if (out.length >= limit) break;
    const id = typeof g.id === "string" ? g.id : null;
    const status = typeof g.status === "string" ? g.status : "";
    const source = typeof g.source === "string" ? g.source : "";
    if (!id || status !== "open" || !ALLOWED_SOURCES.has(source)) continue;
    examined += 1;

    const safeId = sanitizeId(id);
    const scenarioPath = join(scenariosDir, `${safeId}.json`);
    if (await exists(scenarioPath)) { skippedExisting += 1; continue; }

    const summary = typeof g.summary === "string" ? g.summary : "";
    const meta = (g.classification_metadata ?? {}) as Record<string, unknown>;
    const category = typeof g.category === "string" ? g.category : "auto";

    const scenario = {
      id: safeId,
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
    const { rename } = await import("node:fs/promises");
    await rename(tmp, scenarioPath);
    out.push({ gap_id: id, scenario_path: scenarioPath });
  }

  return {
    shape: "bridgeResult",
    body: {
      scenarios_written: out.length,
      gaps_skipped_existing: skippedExisting,
      gaps_examined: examined,
      gaps_total: gaps.length,
      scenarios: out,
      completed_at: new Date().toISOString(),
    },
  };
}
