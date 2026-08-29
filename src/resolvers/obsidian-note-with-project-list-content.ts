/**
 * obsidian_note_with_project_list_content — producer for obsidian:note with project list content (capability-gap autoclosure).
 * Output shape: obsidian:note with project list content
 */

import type { ResolverResult } from "./types.js";

export interface ObsidianNoteWithProjectListContentPointer {
  type: "obsidian_note_with_project_list_content";
  [key: string]: unknown;
}

export async function resolveObsidianNoteWithProjectListContent(pointer: ObsidianNoteWithProjectListContentPointer): Promise<ResolverResult> {
const endpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const devEndpoint = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const apiKey = process.env.METABOB_API_KEY ?? "";
const limit = Number((pointer as Record<string, unknown>).limit ?? 200);

const headers = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

try {
  // Each source below is individually "tolerated" so one outage cannot break the report. That
  // is right, but tolerating silently was not: with all three down the body was zero templates,
  // zero edges, zero gaps and NO marker — a total outage rendered identical to a healthy but
  // empty substrate, and the reader had no way to tell. Record WHICH source degraded, matching
  // the convention already used by error.ts (degraded/reason) and vessel-health-report
  // (fetch_error).
  const sourceErrors: Record<string, string> = {};

  // ── 1. Fetch activity templates ──────────────────────────────────────────
  let templates: any[] = [];
  try {
    const tRes = await fetch(
      `${endpoint}/v2/activities/templates?limit=${limit}`,
      { headers, signal: AbortSignal.timeout(20000) }
    );
    if (tRes.ok) {
      const tData = (await tRes.json()) as any;
      templates = Array.isArray(tData?.templates) ? tData.templates : [];
    }
  } catch (e) {
    // tolerate — continue with empty, but SAY SO
    sourceErrors["templates"] = e instanceof Error ? e.message : String(e);
  }

  // ── 2. Fetch composition graph ───────────────────────────────────────────
  let edges: any[] = [];
  try {
    const gRes = await fetch(
      `${endpoint}/v2/activities/composition/graph?limit=${limit}`,
      { headers, signal: AbortSignal.timeout(20000) }
    );
    if (gRes.ok) {
      const gData = (await gRes.json()) as any;
      edges = Array.isArray(gData?.edges)
        ? gData.edges
        : Array.isArray(gData?.graph)
        ? gData.graph
        : [];
    }
  } catch (e) {
    // tolerate — continue with empty, but SAY SO
    sourceErrors["compositionGraph"] = e instanceof Error ? e.message : String(e);
  }

  // ── 3. Fetch substrate gaps from dev-vessel ──────────────────────────────
  let gaps: any[] = [];
  try {
    const gapRes = await fetch(`${devEndpoint}/v2/impulses/resolve`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        impulse: {
          pointer: { type: "substrateGap", status: "open", limit: 200 },
        },
      }),
    });
    if (gapRes.ok) {
      const gapData = (await gapRes.json()) as any;
      gaps = Array.isArray(gapData?.body?.gaps) ? gapData.body.gaps : [];
    }
  } catch (e) {
    // tolerate — continue with empty, but SAY SO
    sourceErrors["substrateGaps"] = e instanceof Error ? e.message : String(e);
  }

  // ── 4. Aggregate templates into project-list entries ────────────────────
  const projects: Array<{
    id: string;
    outputShapes: string[];
    successRate: number;
    thompsonAlpha: number;
    thompsonBeta: number;
    consumerCount: number;
    producerCount: number;
  }> = [];

  for (const row of templates) {
    const id: string = typeof row?.id === "string" ? row.id : String(row?.id ?? "unknown");
    const outputShapes: string[] = Array.isArray(row?.output_shapes)
      ? (row.output_shapes as any[]).map((s) => (typeof s === "string" ? s : String(s ?? "")))
      : [];
    const metrics = row?.metrics ?? {};
    const successRate: number =
      typeof metrics?.success_rate === "number" ? metrics.success_rate : 0;
    const thompsonAlpha: number =
      typeof metrics?.thompson_alpha === "number" ? metrics.thompson_alpha : 0;
    const thompsonBeta: number =
      typeof metrics?.thompson_beta === "number" ? metrics.thompson_beta : 0;

    // count edges where this template is consumer or producer
    let consumerCount = 0;
    let producerCount = 0;
    for (const edge of edges) {
      if (edge?.consumer === id || edge?.consumer_id === id) consumerCount += 1;
      if (edge?.producer === id || edge?.producer_id === id) producerCount += 1;
    }

    projects.push({
      id,
      outputShapes,
      successRate,
      thompsonAlpha,
      thompsonBeta,
      consumerCount,
      producerCount,
    });
  }

  // ── 5. Sort by success rate descending for the note ─────────────────────
  projects.sort((a, b) => b.successRate - a.successRate);

  // ── 6. Summarise gap shapes ──────────────────────────────────────────────
  const gapShapes: string[] = [];
  for (const g of gaps) {
    const shape = typeof g?.shape === "string" ? g.shape : typeof g?.type === "string" ? g.type : null;
    if (shape !== null && !gapShapes.includes(shape)) {
      gapShapes.push(shape);
    }
  }

  // ── 7. Build the composition-edge summary ───────────────────────────────
  const edgeSummary: Array<{ from: string; to: string; shape: string }> = [];
  for (const edge of edges) {
    edgeSummary.push({
      from: typeof edge?.producer === "string" ? edge.producer : String(edge?.producer ?? ""),
      to: typeof edge?.consumer === "string" ? edge.consumer : String(edge?.consumer ?? ""),
      shape:
        typeof edge?.shape === "string"
          ? edge.shape
          : typeof edge?.output_shape === "string"
          ? edge.output_shape
          : "",
    });
  }

  // ── 8. Compute aggregate stats for the note summary ─────────────────────
  let totalSuccessRate = 0;
  for (const p of projects) {
    totalSuccessRate += p.successRate;
  }
  const avgSuccessRate =
    projects.length > 0 ? totalSuccessRate / projects.length : 0;

  const report = {
    title: "Project List — Activity Substrate Overview",
    summary: {
      totalProjects: projects.length,
      totalCompositionEdges: edges.length,
      totalOpenGaps: gaps.length,
      averageSuccessRate: Math.round(avgSuccessRate * 10000) / 10000,
    },
    projects,
    compositionEdges: edgeSummary,
    openGapShapes: gapShapes,
    // Absent when every source answered; present and named when any did not.
    ...(Object.keys(sourceErrors).length > 0
      ? { degraded: true, source_errors: sourceErrors }
      : {}),
  };

  return {
    shape: "obsidian:note with project list content",
    body: report,
  };
} catch (e) {
  return {
    shape: "obsidian:note with project list content",
    body: { error: String(e) },
  };
}
}
