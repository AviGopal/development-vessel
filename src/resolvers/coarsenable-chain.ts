/**
 * coarsenable_chain — substrate-authored resolver (Seam ③).
 * Output shape: coarsenableChain
 */

import type { ResolverResult } from "./types.js";

export interface CoarsenableChainPointer {
  type: "coarsenable_chain";
  [key: string]: unknown;
}

export async function resolveCoarsenableChain(pointer: CoarsenableChainPointer): Promise<ResolverResult> {
const activityApi = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const apiKey = process.env.METABOB_API_KEY ?? "";
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
};

const opts = pointer as unknown as {
  minOccurrences?: unknown;
  minSuccessRate?: unknown;
  reportLimit?: unknown;
};
const minOccurrences = typeof opts.minOccurrences === "number" ? opts.minOccurrences : 2;
const minSuccessRate = typeof opts.minSuccessRate === "number" ? opts.minSuccessRate : 0.6;
const reportLimit = typeof opts.reportLimit === "number" ? opts.reportLimit : 25;

const stripId = (s: string): string => s.replace(/^activity:⟨(.+)⟩$/, "$1");

interface EdgeRow {
  parent_activity_id?: unknown;
  child_activity_id?: unknown;
  execution_count?: unknown;
  success_count?: unknown;
  success?: unknown;
  genuine?: unknown;
  edge_kind?: unknown;
}

interface TemplateRow {
  id?: unknown;
  output_shapes?: unknown;
}

// 1. Fetch real composition edges (producer/consumer activity chains).
let edges: EdgeRow[] = [];
try {
  const res = await fetch(`${activityApi}/v2/activities/composition/graph?limit=200`, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (res.ok) {
    const data = (await res.json()) as { edges?: unknown };
    if (Array.isArray(data.edges)) edges = data.edges as EdgeRow[];
  }
} catch (_e) {
  // tolerate transport failure; degrade to empty
}

// 2. Fetch templates to recover the shape-flow each activity produces.
let templates: TemplateRow[] = [];
try {
  const res = await fetch(`${activityApi}/v2/activities/templates?limit=100`, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (res.ok) {
    const data = (await res.json()) as { templates?: unknown };
    if (Array.isArray(data.templates)) templates = data.templates as TemplateRow[];
  }
} catch (_e) {
  // tolerate
}

// activity-id -> output shapes (for shape_flow reconstruction)
const outputShapesOf: Record<string, string[]> = {};
for (const t of templates) {
  const id = typeof t.id === "string" ? stripId(t.id) : "";
  if (!id) continue;
  const shapes = Array.isArray(t.output_shapes)
    ? (t.output_shapes as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (shapes.length > 0) outputShapesOf[id] = shapes;
}

// 3. Build the directed edge map, keeping per-edge occurrence + success stats.
interface EdgeStat {
  child: string;
  occurrences: number;
  successRate: number;
}
const adjacency: Record<string, EdgeStat[]> = {};
const edgeStat: Record<string, EdgeStat> = {};
for (const e of edges) {
  const parent = typeof e.parent_activity_id === "string" ? stripId(e.parent_activity_id) : "";
  const child = typeof e.child_activity_id === "string" ? stripId(e.child_activity_id) : "";
  if (!parent || !child || parent === child) continue;
  const occ = typeof e.execution_count === "number" ? e.execution_count : 0;
  const succ =
    typeof e.success_count === "number"
      ? e.success_count
      : e.success === true
        ? occ
        : 0;
  const rate = occ > 0 ? succ / occ : e.success === true ? 1 : 0;
  const stat: EdgeStat = { child, occurrences: occ, successRate: rate };
  if (!adjacency[parent]) adjacency[parent] = [];
  adjacency[parent].push(stat);
  edgeStat[`${parent}->${child}`] = stat;
}

// 4. Walk chains of length >= 2 (DFS, cycle-guarded, depth-capped) and score them.
interface Candidate {
  chain: string[];
  occurrences: number;
  success_rate: number;
  shape_flow: string[];
  mint_target: string;
}
const candidates: Candidate[] = [];
const MAX_DEPTH = 6;

const walk = (node: string, path: string[], minOcc: number, rateProduct: number, seen: Set<string>): void => {
  const next = adjacency[node];
  // Record the chain so far if it is a genuine multi-step chain.
  if (path.length >= 2) {
    const shapeFlow: string[] = [];
    for (const a of path) {
      for (const s of outputShapesOf[a] ?? []) {
        if (!shapeFlow.includes(s)) shapeFlow.push(s);
      }
    }
    candidates.push({
      chain: [...path],
      occurrences: minOcc === Infinity ? 0 : minOcc,
      success_rate: Number(rateProduct.toFixed(4)),
      shape_flow: shapeFlow,
      mint_target: `coarsen-${path.map(stripId).join("-").slice(0, 80)}`,
    });
  }
  if (!next || path.length >= MAX_DEPTH) return;
  for (const stat of next) {
    if (seen.has(stat.child)) continue;
    seen.add(stat.child);
    walk(
      stat.child,
      [...path, stat.child],
      Math.min(minOcc, stat.occurrences),
      rateProduct * stat.successRate,
      seen,
    );
    seen.delete(stat.child);
  }
};

for (const root of Object.keys(adjacency)) {
  walk(root, [root], Infinity, 1, new Set([root]));
}

// 5. Keep only recurring, high-success coarsening candidates; dedupe by chain.
const byChain: Record<string, Candidate> = {};
for (const c of candidates) {
  if (c.occurrences < minOccurrences) continue;
  if (c.success_rate < minSuccessRate) continue;
  const key = c.chain.join(">");
  const prior = byChain[key];
  if (!prior || c.occurrences > prior.occurrences) byChain[key] = c;
}
const ranked = Object.values(byChain).sort(
  (a, b) => b.occurrences - a.occurrences || b.success_rate - a.success_rate,
);
const top = ranked.slice(0, reportLimit);

return {
  shape: "coarsenableChain",
  body: {
    summary: {
      edges_scanned: edges.length,
      templates_scanned: templates.length,
      chains_walked: candidates.length,
      coarsenable_candidates: ranked.length,
      min_occurrences: minOccurrences,
      min_success_rate: minSuccessRate,
    },
    candidates: top,
    generated_at: new Date().toISOString(),
  },
};

}
