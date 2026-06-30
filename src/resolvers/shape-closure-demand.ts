/**
 * shape_closure_demand — substrate-authored resolver (Seam ③).
 * Output shape: shapeClosureDemand
 */

import type { ResolverResult } from "./types.js";

export interface ShapeClosureDemandPointer {
  type: "shape_closure_demand";
  [key: string]: unknown;
}

export async function resolveShapeClosureDemand(pointer: ShapeClosureDemandPointer): Promise<ResolverResult> {
  // shape_closure_demand — aggregate unsatisfied-shape demand into a ranked closure queue.
  // Reads OPEN substrateGaps (kind=capability_gap; each names a missing_shape with no producer)
  // plus composition-graph orphans, ranks each shape by demand_count x recency x how-blocking.
  const p = pointer as { devVesselUrl?: string; activityApiUrl?: string; apiKey?: string; limit?: number };
  const DEV = p.devVesselUrl ?? "http://127.0.0.1:8090/v2/impulses/resolve";
  const ACT = p.activityApiUrl ?? "http://127.0.0.1:8080";
  const API_KEY = p.apiKey ?? process.env.METABOB_API_KEY ?? "";
  const LIMIT = typeof p.limit === "number" ? p.limit : 200;
  const now = Date.now();

  type Gap = {
    id?: string;
    category?: string;
    summary?: string;
    detected_at?: string;
    created_at?: string;
    classification_metadata?: { kind?: string; missing_shape?: string };
  };

  // 1. Fetch OPEN substrate gaps from the dev-vessel substrateGap resolver.
  let gaps: Gap[] = [];
  try {
    const r = await fetch(DEV, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ impulse: { pointer: { type: "substrateGap", status: "open", limit: LIMIT } } }),
    });
    if (r.ok) {
      const j: any = await r.json();
      gaps = (j?.body?.gaps ?? []) as Gap[];
    }
  } catch {
    // fail soft — proceed with whatever we have
  }

  // 2. Fetch composition-graph edges to detect orphan (childless / dead-end) shapes.
  let edges: Array<{ parent_activity_id?: string; child_activity_id?: string; genuine?: boolean }> = [];
  try {
    const r2 = await fetch(`${ACT}/v2/activities/composition/graph?limit=${LIMIT}`, {
      headers: API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {},
    });
    if (r2.ok) {
      const j2: any = await r2.json();
      edges = (j2?.edges ?? []) as typeof edges;
    }
  } catch {
    // fail soft
  }

  // 3. Aggregate demand per missing shape from capability_gap gaps.
  const demand = new Map<string, { shape: string; demand_count: number; blocking_gaps: string[]; latest: number }>();
  for (const g of gaps) {
    const kind = g.classification_metadata?.kind ?? g.category;
    if (kind !== "capability_gap") continue;
    const shape = g.classification_metadata?.missing_shape;
    if (!shape) continue;
    const ts = Date.parse(g.detected_at ?? g.created_at ?? "") || now;
    const entry = demand.get(shape) ?? { shape, demand_count: 0, blocking_gaps: [], latest: 0 };
    entry.demand_count += 1;
    if (g.id) entry.blocking_gaps.push(g.id);
    if (ts > entry.latest) entry.latest = ts;
    demand.set(shape, entry);
  }

  // 4. how-blocking: a parent activity referencing the shape with no genuine outgoing edge is more blocking.
  const childWithGenuine = new Set<string>();
  for (const e of edges) {
    if (e.genuine && e.parent_activity_id) childWithGenuine.add(e.parent_activity_id);
  }

  // 5. Rank: priority_score = demand_count * recency_factor * blocking_factor.
  const DAY = 24 * 60 * 60 * 1000;
  const ranked = Array.from(demand.values())
    .map((e) => {
      const ageDays = Math.max(0, (now - e.latest) / DAY);
      const recency = 1 / (1 + ageDays); // 1.0 fresh, decays with age
      const blocking = e.blocking_gaps.length > 1 ? 1.5 : 1.0;
      const priority_score = Number((e.demand_count * recency * blocking).toFixed(4));
      return {
        shape: e.shape,
        demand_count: e.demand_count,
        blocking_gaps: e.blocking_gaps.slice(0, 10),
        priority_score,
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score);

  return {
    shape: "shapeClosureDemand",
    body: {
      generated_at: new Date(now).toISOString(),
      total_open_gaps: gaps.length,
      capability_gaps_considered: ranked.length,
      composition_edges_considered: edges.length,
      ranked,
    },
  };
}
