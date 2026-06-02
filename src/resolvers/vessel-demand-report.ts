import type { ResolverResult } from "./types.js";

/**
 * vessel_demand_report — substrate-self-detection of shape demand without
 * supply. For every shape required by ≥N templates with zero vessels
 * producing it via discovery, emit a substrateGap and surface the prioritized
 * demand. Companion to composition_coverage_report (which looks at intra-
 * catalogue coverage) — this one looks at cross-catalogue/vessel coverage.
 *
 * Immunity-pattern compliant: single resolver, no LLM, no iteration; the
 * detector itself produces no demand.
 *
 * Trigger condition for substrate-authored vessel creation:
 *   - shape required by ≥3 templates
 *   - zero vessel advertises it
 *   - → emit `vesselDemand` substrateGap and return prioritized list
 *
 * Algorithm:
 *   1. Fetch templates from activity-api; collect every inputShapes entry.
 *   2. Fetch discovery `/shapes` registry; build advertised-shape set.
 *   3. For each input shape, count templates requiring it; check supply.
 *   4. Shapes with demand >= minTemplates AND zero supply → demand entries.
 *   5. Optionally POST each as substrateGap_write (vesselDemand subtype).
 */

export interface VesselDemandReportPointer {
  type: "vessel_demand_report";
  templatesUrl?: string;
  discoveryShapesUrl?: string;
  devVesselImpulsesUrl?: string;
  /** Minimum templates requiring a shape to count as demand. Default 3. */
  minTemplates?: number;
  dry_run?: boolean;
  maxEmits?: number;
  /** Cap on templates pulled per page. Default 100. */
  pageSize?: number;
  /** Cap on total templates pulled. Default 500. */
  templateFetchCap?: number;
}

const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates";
const DEFAULT_DISCOVERY_URL = "http://127.0.0.1:8100/shapes";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

interface TemplateRow {
  id?: unknown;
  inputShapes?: unknown;
  input_shapes?: unknown;
}

interface DemandEntry {
  shape: string;
  template_count: number;
  sample_template_ids: string[];
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
  post_error?: string;
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

export async function resolveVesselDemandReport(
  pointer: VesselDemandReportPointer,
): Promise<ResolverResult> {
  const templatesUrlBase = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const discoveryUrl = pointer.discoveryShapesUrl ?? DEFAULT_DISCOVERY_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const minTemplates = pointer.minTemplates ?? 3;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? 20;
  const pageSize = pointer.pageSize ?? 100;
  const templateFetchCap = pointer.templateFetchCap ?? 500;

  const apiKey = process.env["METABOB_API_KEY"];
  const auth: Record<string, string> = apiKey
    ? { Authorization: `ApiKey ${apiKey}` }
    : {};

  // 1. Pull templates.
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
        resolver: "vessel_demand_report",
        detail: `templates fetch failed: ${(err as Error).message}`,
      },
    };
  }

  // 2. Pull discovery /shapes.
  const advertised = new Set<string>();
  try {
    const resp = await fetch(discoveryUrl, {
      headers: { ...auth },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const json = (await resp.json()) as Record<string, unknown>;
      // /shapes returns { shapes: [...] } or { <shape>: [...vessels...] } — accept both.
      if (Array.isArray((json as { shapes?: unknown }).shapes)) {
        for (const s of (json as { shapes: unknown[] }).shapes) {
          if (typeof s === "string") advertised.add(s);
        }
      } else {
        for (const k of Object.keys(json)) advertised.add(k);
      }
    }
  } catch {
    // Graceful — if discovery is down, treat advertised set as empty (everything = demand).
    // This will surface more demand than reality, which is conservatively useful.
  }

  // 3. Demand counts.
  const demand = new Map<string, Set<string>>();
  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    for (const shape of inputShapesOf(tpl)) {
      let set = demand.get(shape);
      if (!set) {
        set = new Set<string>();
        demand.set(shape, set);
      }
      set.add(tid);
    }
  }

  // 4. Build demand entries — unmet & above threshold.
  const today = new Date().toISOString().slice(0, 10);
  const entries: DemandEntry[] = [];
  for (const [shape, templateIds] of demand.entries()) {
    if (templateIds.size < minTemplates) continue;
    if (advertised.has(shape)) continue;
    entries.push({
      shape,
      template_count: templateIds.size,
      sample_template_ids: Array.from(templateIds).slice(0, 5),
      gap_id: `vessel-demand-${shape}-${today}`,
      posted: false,
    });
  }
  entries.sort((a, b) => b.template_count - a.template_count);

  // 5. Emit demand gaps unless dry_run.
  const toPost = entries.slice(0, maxEmits);
  if (!dryRun) {
    for (const entry of toPost) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: entry.gap_id,
              category: "missing_capability",
              source: "substrate_detected",
              summary:
                `Shape '${entry.shape}' required by ${entry.template_count} templates ` +
                `but no vessel advertises it. Candidate for substrate-authored vessel.`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "vessel_demand",
                shape: entry.shape,
                template_count: entry.template_count,
                sample_template_ids: entry.sample_template_ids,
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        entry.post_status = resp.status;
        entry.posted = resp.ok;
        if (!resp.ok) {
          entry.post_error = (await resp.text()).slice(0, 200);
        }
      } catch (err) {
        entry.post_status = "error";
        entry.post_error = (err as Error).message;
      }
    }
  }

  return {
    shape: "vesselDemandReport",
    body: {
      templates_scanned: templates.length,
      advertised_shape_count: advertised.size,
      demand_threshold_min_templates: minTemplates,
      demand_entry_count: entries.length,
      demand_entries: entries,
      top_priority: entries[0] ?? null,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
