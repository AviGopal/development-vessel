import type { ResolverResult } from "./types.js";

/**
 * composition_coverage_report — substrate-self-detection of intra-catalogue
 * composability. Looks at the producer/consumer graph implicit in the
 * activity-api template catalogue and flags:
 *   - orphan_producers: templates whose output_shapes have no consumer
 *   - orphan_consumers: templates whose inputShapes have no producer
 *   - unconnected_pairs: shapes with both producer and consumer that have
 *     never appeared in the same composition_chain
 *
 * Had this existed pre-2026-06-02, it would have flagged that
 * scaffold-new-vessel emits commandResult × 4 with no template consuming
 * those into git_commit / git_push, surfacing the need for
 * scaffold-and-publish-vessel autonomously.
 *
 * Immunity-pattern compliant: single resolver, no LLM, no iteration; the
 * detector itself is structurally exempt from preflight rejection.
 */

export interface CompositionCoverageReportPointer {
  type: "composition_coverage_report";
  templatesUrl?: string;
  /** Templates pulled per page. Default 100. */
  pageSize?: number;
  /** Cap on total templates pulled. Default 1000. */
  templateFetchCap?: number;
  /** Cap on each list in the response. Default 25. */
  reportLimit?: number;
}

const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates";

interface TemplateRow {
  id?: unknown;
  inputShapes?: unknown;
  input_shapes?: unknown;
  outputShapes?: unknown;
  output_shapes?: unknown;
}

interface OrphanProducer {
  template_id: string;
  output_shapes: string[];
  why_orphan: string;
}

interface OrphanConsumer {
  template_id: string;
  missing_input_shapes: string[];
}

interface UnconnectedPair {
  shape: string;
  producer_template_id: string;
  consumer_template_id: string;
}

function templateIdOf(t: TemplateRow): string {
  if (typeof t.id === "string" && t.id.length > 0) {
    return t.id.replace(/^activity:⟨(.+)⟩$/, "$1");
  }
  return "unknown_template";
}

function inputShapesOf(t: TemplateRow): string[] {
  const candidate = Array.isArray(t.inputShapes)
    ? t.inputShapes
    : Array.isArray(t.input_shapes)
      ? t.input_shapes
      : [];
  return (candidate as unknown[]).filter((s): s is string => typeof s === "string");
}

function outputShapesOf(t: TemplateRow): string[] {
  const candidate = Array.isArray(t.outputShapes)
    ? t.outputShapes
    : Array.isArray(t.output_shapes)
      ? t.output_shapes
      : [];
  return (candidate as unknown[]).filter((s): s is string => typeof s === "string");
}

export async function resolveCompositionCoverageReport(
  pointer: CompositionCoverageReportPointer,
): Promise<ResolverResult> {
  const templatesUrlBase = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const pageSize = pointer.pageSize ?? 100;
  const templateFetchCap = pointer.templateFetchCap ?? 1000;
  const reportLimit = pointer.reportLimit ?? 25;

  const apiKey = process.env["METABOB_API_KEY"];
  const auth: Record<string, string> = apiKey
    ? { Authorization: `ApiKey ${apiKey}` }
    : {};

  const templates: TemplateRow[] = [];
  let offset = 0;
  try {
    while (templates.length < templateFetchCap) {
      const url = `${templatesUrlBase}?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, {
        headers: { ...auth },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) break;
      const json = (await resp.json()) as { templates?: unknown };
      const rows = Array.isArray(json.templates) ? (json.templates as TemplateRow[]) : [];
      templates.push(...rows);
      if (rows.length < pageSize) break;
      offset += rows.length;
    }
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "composition_coverage_report",
        detail: `templates fetch failed: ${(err as Error).message}`,
      },
    };
  }

  // Build producer & consumer maps: shape → set of template ids.
  const producers = new Map<string, Set<string>>();
  const consumers = new Map<string, Set<string>>();

  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    for (const s of outputShapesOf(tpl)) {
      let set = producers.get(s);
      if (!set) {
        set = new Set<string>();
        producers.set(s, set);
      }
      set.add(tid);
    }
    for (const s of inputShapesOf(tpl)) {
      let set = consumers.get(s);
      if (!set) {
        set = new Set<string>();
        consumers.set(s, set);
      }
      set.add(tid);
    }
  }

  // Orphan producers: template emits a shape with zero consumer.
  const orphanProducers: OrphanProducer[] = [];
  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    const outs = outputShapesOf(tpl);
    if (outs.length === 0) continue;
    const unconsumedShapes = outs.filter((s) => !consumers.has(s));
    if (unconsumedShapes.length > 0 && unconsumedShapes.length === outs.length) {
      orphanProducers.push({
        template_id: tid,
        output_shapes: outs,
        why_orphan: `none of ${outs.length} output_shapes have a consumer in catalogue`,
      });
    }
  }

  // Orphan consumers: template needs an input with zero producer.
  const orphanConsumers: OrphanConsumer[] = [];
  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    const ins = inputShapesOf(tpl);
    if (ins.length === 0) continue;
    const unproducedShapes = ins.filter((s) => !producers.has(s));
    if (unproducedShapes.length > 0) {
      orphanConsumers.push({
        template_id: tid,
        missing_input_shapes: unproducedShapes,
      });
    }
  }

  // Unconnected pairs: shape has both producer & consumer; we don't probe
  // composition_chain history (would require a separate query); a heuristic
  // signal is enough to expose composability candidates.
  const unconnectedPairs: UnconnectedPair[] = [];
  for (const [shape, prodSet] of producers.entries()) {
    const consSet = consumers.get(shape);
    if (!consSet) continue;
    // Skip shapes already covered by a real composition (heuristic: leave
    // these for the compositionChain-aware detector when available). Right
    // now, just emit one pair per (shape) for visibility.
    const prodArr = Array.from(prodSet);
    const consArr = Array.from(consSet);
    const prod = prodArr[0];
    const cons = consArr[0];
    if (prod && cons && prod !== cons) {
      unconnectedPairs.push({
        shape,
        producer_template_id: prod,
        consumer_template_id: cons,
      });
    }
  }
  unconnectedPairs.sort((a, b) => a.shape.localeCompare(b.shape));

  const orphanCount = orphanProducers.length + orphanConsumers.length;
  let healthVerdict: "WELL_CONNECTED" | "PARTIAL" | "FRAGMENTED";
  if (orphanCount === 0) healthVerdict = "WELL_CONNECTED";
  else if (orphanCount <= 10) healthVerdict = "PARTIAL";
  else healthVerdict = "FRAGMENTED";

  return {
    shape: "compositionCoverageReport",
    body: {
      templates_scanned: templates.length,
      distinct_producer_shapes: producers.size,
      distinct_consumer_shapes: consumers.size,
      orphan_producers: orphanProducers.slice(0, reportLimit),
      orphan_producer_total: orphanProducers.length,
      orphan_consumers: orphanConsumers.slice(0, reportLimit),
      orphan_consumer_total: orphanConsumers.length,
      unconnected_pairs: unconnectedPairs.slice(0, reportLimit),
      unconnected_pair_total: unconnectedPairs.length,
      health_verdict: healthVerdict,
      completed_at: new Date().toISOString(),
    },
  };
}
