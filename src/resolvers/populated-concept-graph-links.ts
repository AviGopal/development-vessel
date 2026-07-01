/**
 * populated_concept_graph_links — producer for populated_concept_graph_links (capability-gap autoclosure).
 * Output shape: populated_concept_graph_links
 */

import type { ResolverResult } from "./types.js";

export interface PopulatedConceptGraphLinksPointer {
  type: "populated_concept_graph_links";
  [key: string]: unknown;
}

export async function resolvePopulatedConceptGraphLinks(pointer: PopulatedConceptGraphLinksPointer): Promise<ResolverResult> {
const activityEndpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const devVesselEndpoint = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const apiKey = process.env.METABOB_API_KEY ?? "";
const headers = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

try {
  // Fetch activity templates to get nodes (activities) and their output shapes
  const templatesRes = await fetch(
    `${activityEndpoint}/v2/activities/templates?limit=100`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  if (!templatesRes.ok) {
    return { shape: "populated_concept_graph_links", body: { error: `templates http ${templatesRes.status}` } };
  }
  const templatesData = (await templatesRes.json()) as any;
  const templates: any[] = Array.isArray(templatesData?.templates) ? templatesData.templates : [];

  // Fetch composition graph edges (producer→consumer shape flow)
  const graphRes = await fetch(
    `${activityEndpoint}/v2/activities/composition/graph?limit=200`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const graphData = graphRes.ok ? ((await graphRes.json()) as any) : {};
  const edges: any[] = Array.isArray(graphData?.edges)
    ? graphData.edges
    : Array.isArray(graphData?.links)
    ? graphData.links
    : Array.isArray(graphData?.nodes)
    ? []
    : [];

  // Fetch substrate gaps (unsatisfied shape demands) from dev-vessel
  const gapsRes = await fetch(`${devVesselEndpoint}/v2/impulses/resolve`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      impulse: { pointer: { type: "substrateGap", status: "open", limit: 200 } },
    }),
  });
  const gapsData = gapsRes.ok ? ((await gapsRes.json()) as any) : {};
  const gaps: any[] = Array.isArray(gapsData?.body?.gaps)
    ? gapsData.body.gaps
    : Array.isArray(gapsData?.gaps)
    ? gapsData.gaps
    : [];

  // Build concept nodes from templates
  const conceptNodes: Record<string, {
    id: string;
    label: string;
    successRate: number;
    thompsonAlpha: number;
    thompsonBeta: number;
    outputShapes: string[];
  }> = {};

  for (const t of templates) {
    const id: string = String(t?.id ?? "unknown");
    const metrics = t?.metrics ?? {};
    const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    conceptNodes[id] = {
      id,
      label: String(t?.name ?? t?.id ?? "unknown"),
      successRate: Number(metrics?.success_rate ?? 0),
      thompsonAlpha: Number(metrics?.thompson_alpha ?? 1),
      thompsonBeta: Number(metrics?.thompson_beta ?? 1),
      outputShapes,
    };
  }

  // Build shape → producer mapping from templates
  const shapeProducers: Record<string, string[]> = {};
  for (const t of templates) {
    const id: string = String(t?.id ?? "unknown");
    const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    for (const shape of outputShapes) {
      const s = String(shape);
      if (!shapeProducers[s]) {
        shapeProducers[s] = [];
      }
      shapeProducers[s]?.push(id);
    }
  }

  // Populate graph links from composition edges
  const populatedLinks: Array<{
    source: string;
    target: string;
    sourceShape: string;
    targetShape: string;
    weight: number;
    sourceSuccessRate: number;
    targetSuccessRate: number;
  }> = [];

  for (const edge of edges) {
    const source: string = String(edge?.source ?? edge?.producer ?? edge?.from ?? "");
    const target: string = String(edge?.target ?? edge?.consumer ?? edge?.to ?? "");
    const sourceShape: string = String(edge?.source_shape ?? edge?.output_shape ?? edge?.shape ?? "");
    const targetShape: string = String(edge?.target_shape ?? edge?.input_shape ?? "");
    const weight: number = Number(edge?.weight ?? edge?.count ?? 1);

    const sourceNode = conceptNodes[source];
    const targetNode = conceptNodes[target];

    populatedLinks.push({
      source,
      target,
      sourceShape,
      targetShape,
      weight,
      sourceSuccessRate: sourceNode?.successRate ?? 0,
      targetSuccessRate: targetNode?.successRate ?? 0,
    });
  }

  // If no edges returned from composition graph, synthesise links from shape co-occurrence in templates
  if (populatedLinks.length === 0) {
    for (const t of templates) {
      const producerId: string = String(t?.id ?? "unknown");
      const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
      for (const shape of outputShapes) {
        const consumers = shapeProducers[String(shape)] ?? [];
        for (const consumerId of consumers) {
          if (consumerId !== producerId) {
            const sourceNode = conceptNodes[producerId];
            const targetNode = conceptNodes[consumerId];
            populatedLinks.push({
              source: producerId,
              target: consumerId,
              sourceShape: String(shape),
              targetShape: String(shape),
              weight: 1,
              sourceSuccessRate: sourceNode?.successRate ?? 0,
              targetSuccessRate: targetNode?.successRate ?? 0,
            });
          }
        }
      }
    }
  }

  // Annotate gaps onto the graph
  const gapShapes: string[] = [];
  for (const g of gaps) {
    const gapShape: string = String(g?.shape ?? g?.output_shape ?? g?.type ?? "");
    if (gapShape) {
      gapShapes.push(gapShape);
    }
  }

  // Compute graph-level statistics
  const totalLinks = populatedLinks.length;
  const nodeIds = Object.keys(conceptNodes);
  const totalNodes = nodeIds.length;

  const avgSuccessRate =
    totalNodes > 0
      ? nodeIds.reduce((sum, id) => {
          const node = conceptNodes[id];
          return sum + (node?.successRate ?? 0);
        }, 0) / totalNodes
      : 0;

  // Shape coverage: how many unique shapes are represented as sourceShape in links
  const coveredShapes = new Set<string>();
  for (const link of populatedLinks) {
    if (link.sourceShape) coveredShapes.add(link.sourceShape);
    if (link.targetShape) coveredShapes.add(link.targetShape);
  }

  // Identify which gap shapes have no producer links
  const unlinkedGapShapes: string[] = [];
  for (const gs of gapShapes) {
    if (!coveredShapes.has(gs)) {
      unlinkedGapShapes.push(gs);
    }
  }

  // Build final node list with enrichment
  const enrichedNodes = nodeIds.map((id) => {
    const node = conceptNodes[id];
    return {
      id,
      label: node?.label ?? id,
      successRate: node?.successRate ?? 0,
      thompsonAlpha: node?.thompsonAlpha ?? 1,
      thompsonBeta: node?.thompsonBeta ?? 1,
      outputShapes: node?.outputShapes ?? [],
    };
  });

  return {
    shape: "populated_concept_graph_links",
    body: {
      totalNodes,
      totalLinks,
      avgSuccessRate,
      coveredShapeCount: coveredShapes.size,
      coveredShapes: Array.from(coveredShapes),
      gapShapes,
      unlinkedGapShapes,
      nodes: enrichedNodes,
      links: populatedLinks,
    },
  };
} catch (e) {
  return { shape: "populated_concept_graph_links", body: { error: String(e) } };
}
}
