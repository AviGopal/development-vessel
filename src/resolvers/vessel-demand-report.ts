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

/**
 * looksLikeCapabilityShape — refined classifier for vessel-demand filtering.
 *
 * The unrefined demand-report surfaced 16 entries with top shapes `goal`,
 * `trace`, `error`, `source_code`, `activity_template` — these are domain
 * entities the substrate already models, not resolver capabilities a new
 * vessel should produce. A vessel that "advertises shape `goal`" makes no
 * sense; a vessel that "advertises shape `compositionCoverageReport`" does.
 *
 * Heuristic: a capability shape is one a RESOLVER produces. Patterns observed
 * across the dev-vessel catalogue (precondition_rejection_scan, phantom_trace_scan,
 * resolver_pattern_report, system_load_report, comprehensibility_check,
 * convergent_validity_check, stale_pointer_emit, vesselDemand, traceFailurePatternReport, ...):
 *   - snake_case ending in {_report, _scan, _check, _emit, _result, _summary,
 *     _snapshot, _tick, _dispatch, _signature, _validity, _matrix}
 *   - camelCase ending in {Report, Scan, Check, Result, Summary, Snapshot,
 *     Signature, Validity, Verdict, Pattern, Outcome}
 *   - Suffix "_write" (writer pointer)
 * Domain entities filter to false: short common nouns (`goal`, `trace`,
 * `error`, `tool`, `source_code`, `test_suite`, `activity_template`).
 */
const CAPABILITY_SUFFIX_PATTERNS: readonly RegExp[] = [
  // snake_case capability suffixes
  /_(report|scan|check|emit|result|summary|snapshot|tick|dispatch|signature|validity|matrix|write|fetch|extract|sections|propagate|judgment|introspect|noop|topology|attribution|reachable|advance|recommend|discover|delete|update|deprecate|by_shapes|by_signature)$/,
  // camelCase capability suffixes
  /(Report|Scan|Check|Result|Summary|Snapshot|Signature|Validity|Verdict|Pattern|Outcome|Reaction|Evaluation|Refused|Health|Trace|Relevance|Metrics|Demand|Audit|Status|Action|Sequence|Graph|Verdict|Stats|Profile|Tree|Map|Record)$/,
  // Two-word camelCase compounds (capability shapes like activityTemplate, executionTrace)
  // — must have at least two capitalized segments AND a "noun-like" combined length
  /^[a-z][a-z0-9]+[A-Z][a-zA-Z0-9]{4,}$/,
];

const DOMAIN_ENTITY_DENYLIST = new Set<string>([
  "goal",
  "trace",
  "error",
  "tool",
  "source_code",
  "test_suite",
  "activity_template",
  "execution_trace",
  "activity_metrics",
  "impulse",
  "task",
  "vessel",
  "config",
  "metadata",
  "context",
  "input",
  "output",
  "request",
  "response",
  "user",
  "message",
  "string",
  "number",
  "object",
]);

function looksLikeCapabilityShape(shape: string): boolean {
  if (DOMAIN_ENTITY_DENYLIST.has(shape)) return false;
  // Very short shapes are almost always domain entities.
  if (shape.length < 6) return false;
  // Match any capability suffix pattern.
  for (const pat of CAPABILITY_SUFFIX_PATTERNS) {
    if (pat.test(shape)) return true;
  }
  return false;
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

  // 4. Build demand entries — unmet & above threshold AND capability-shaped.
  // The capability filter excludes domain entities (goal, trace, error, …) that
  // are not resolver outputs — they're operator-level concepts the substrate
  // already models, not gaps a new vessel should fill.
  const today = new Date().toISOString().slice(0, 10);
  const entries: DemandEntry[] = [];
  const entries_filtered_as_domain: { shape: string; template_count: number }[] = [];
  for (const [shape, templateIds] of demand.entries()) {
    if (templateIds.size < minTemplates) continue;
    if (advertised.has(shape)) continue;
    if (!looksLikeCapabilityShape(shape)) {
      entries_filtered_as_domain.push({ shape, template_count: templateIds.size });
      continue;
    }
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
      filtered_as_domain_entity_count: entries_filtered_as_domain.length,
      filtered_as_domain_entity_samples: entries_filtered_as_domain.slice(0, 8),
      top_priority: entries[0] ?? null,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
