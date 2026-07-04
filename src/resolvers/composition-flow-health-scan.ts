import type { ResolverResult } from "./types.js";

/**
 * composition_flow_health_scan — detector for composition-graph flow health.
 * Computes connected-component count of the genuine composition graph, genuine
 * edges per cell, and bridges-minted per reached chain, reusing the readers that
 * already exist (learning_transfer_report + the activity_composition_graph and
 * goal_execution_paths tables). Files a substrateGap with the STABLE id
 * gap-composition-flow-components-split when the genuine graph has more than one
 * component (credit cannot mix across components — the standing two-component
 * split finding).
 */
export interface CompositionFlowHealthScanPointer {
  type: "composition_flow_health_scan";
  /** Cap on composition edges scanned. Default 10000. */
  edgeLimit?: number;
  /** Override dev-vessel impulses URL (self-POST). */
  devVesselImpulsesUrl?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
}

function surrealHeaders(): Record<string, string> {
  const user = process.env["SURREALDB_USERNAME"] ?? "root";
  const pass = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "";
  return {
    "Content-Type": "text/plain",
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
    "surreal-ns": process.env["SURREALDB_NAMESPACE"] ?? "activity-system",
    "surreal-db": process.env["SURREALDB_DATABASE"] ?? "learning_loop",
  };
}

async function flowSql(query: string): Promise<Array<Record<string, unknown>>> {
  const url = (process.env["SURREALDB_URL"] ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const res = await fetch(`${url}/sql`, { method: "POST", headers: surrealHeaders(), body: query, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return [];
  const arr = (await res.json()) as Array<{ result?: unknown }>;
  const r = arr[arr.length - 1]?.result;
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}

export async function resolveCompositionFlowHealthScan(
  pointer: CompositionFlowHealthScanPointer,
): Promise<ResolverResult> {
  const edgeLimit = pointer.edgeLimit ?? 10000;
  const dryRun = pointer.dry_run === true;
  const emitUrl = pointer.devVesselImpulsesUrl ?? "http://127.0.0.1:8090/v2/impulses/resolve";
  const edges = await flowSql(`SELECT parent_activity_id, child_activity_id, genuine FROM activity_composition_graph LIMIT ${edgeLimit}`);
  // Union-find over the GENUINE edge graph (credit mixes only along genuine edges).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  let genuineEdges = 0;
  let totalEdges = 0;
  const bridgeNodes = new Set<string>();
  for (const e of edges) {
    const a = String(e["parent_activity_id"] ?? "");
    const b = String(e["child_activity_id"] ?? "");
    if (!a || !b) continue;
    totalEdges += 1;
    if (/auto-bridge/.test(a)) bridgeNodes.add(a);
    if (/auto-bridge/.test(b)) bridgeNodes.add(b);
    if (e["genuine"] === true) {
      genuineEdges += 1;
      union(a, b);
    }
  }
  const roots = new Set<string>();
  for (const k of parent.keys()) roots.add(find(k));
  const components = roots.size;
  const nodesInGenuineGraph = parent.size;
  const reachedRows = await flowSql(`SELECT count() AS n FROM goal_execution_paths WHERE success = true GROUP ALL`);
  const reachedChains = Number(reachedRows[0]?.["n"] ?? 0);
  const cellRows = await flowSql(`SELECT count() AS n FROM variant_performance_metrics GROUP ALL`);
  const cells = Number(cellRows[0]?.["n"] ?? 0);
  const verdict = components > 1 ? "flow_split" : components === 1 ? "flow_connected" : "no_genuine_edges";
  const gapId = components > 1 ? "gap-composition-flow-components-split" : null;
  let posted = false;
  if (gapId && !dryRun) {
    try {
      const apiKey = process.env["METABOB_API_KEY"];
      const resp = await fetch(emitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        body: JSON.stringify({ impulse: { type: "substrateGap_write", pointer: { type: "substrateGap_write", gap: {
          id: gapId,
          category: "learning_loop",
          source: "substrate_detected",
          status: "open",
          summary: `Composition-graph flow is SPLIT: the genuine composition graph has ${components} connected components (${nodesInGenuineGraph} nodes, ${genuineEdges} genuine edges). Credit cannot mix across components, so learning stays local to each island. Author or reuse a producer-consumer composition that joins the components (compose-teacher class), then re-run composition_flow_health_scan to confirm the join.`,
          detected_at: new Date().toISOString(),
          classification_metadata: { kind: "composition_flow_health", components, nodes_in_genuine_graph: nodesInGenuineGraph, genuine_edges: genuineEdges, total_edges: totalEdges, cells, genuine_edges_per_cell: cells > 0 ? genuineEdges / cells : null, bridge_nodes: bridgeNodes.size, reached_chains: reachedChains, bridges_per_reached_chain: reachedChains > 0 ? bridgeNodes.size / reachedChains : null },
        } } } }),
        signal: AbortSignal.timeout(15_000),
      });
      posted = resp.ok;
    } catch (e) {
      console.warn(`[composition-flow-health-scan] gap post failed: ${(e as Error).message}`);
    }
  }
  return {
    shape: "compositionFlowHealthReport",
    body: {
      scanned: true,
      verdict,
      components,
      nodes_in_genuine_graph: nodesInGenuineGraph,
      genuine_edges: genuineEdges,
      total_edges: totalEdges,
      cells,
      genuine_edges_per_cell: cells > 0 ? genuineEdges / cells : null,
      bridge_nodes: bridgeNodes.size,
      reached_chains: reachedChains,
      bridges_per_reached_chain: reachedChains > 0 ? bridgeNodes.size / reachedChains : null,
      gap_id: gapId,
      gap_posted: posted,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
