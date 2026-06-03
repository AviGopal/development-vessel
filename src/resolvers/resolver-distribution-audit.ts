import type { ResolverResult } from "./types.js";

/**
 * resolver_distribution_audit — horizon-detector (resolver-distribution horizon).
 *
 * Stage 1.D of openspec change
 *   2026-06-03-pre-lift-bootstrap-and-architecture-aware-loop
 *
 * Reads discovery-vessel's /shapes registry + recent traces + the catalogue
 * of templates. Detects:
 *
 *   1. shape_orphan        shape advertised but never invoked in recent traces
 *   2. demand_supply_mismatch
 *                          shape required by >= N templates (inputShapes) yet
 *                          zero vessel advertises it as outputShapes
 *   3. responsibility_imbalance
 *                          one vessel advertises shapes whose names match a
 *                          principle's `forbidden_pattern_regex` with a
 *                          `target_vessel` clause — i.e. resolver-distribution
 *                          violates a structural principle
 *
 * Companion to vessel_demand_report but consults architectural principles
 * to flag responsibility-imbalance (which vessel-demand-report does not).
 *
 * Immunity-pattern compliant: empty inputShapes, single resolver, no LLM.
 */

const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates";
const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_DISCOVERY_URL = "http://127.0.0.1:8100/shapes";
const DEFAULT_CONCEPT_DB_URL = "http://127.0.0.1:8260/concepts/search";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface ResolverDistributionAuditPointer {
  type: "resolver_distribution_audit";
  templatesUrl?: string;
  tracesUrl?: string;
  discoveryShapesUrl?: string;
  conceptDbUrl?: string;
  devVesselImpulsesUrl?: string;
  /** Min templates demanding a shape for demand_supply_mismatch. Default 3. */
  minDemandTemplates?: number;
  /** Cap on traces queried. Default 500. */
  traceFetchCap?: number;
  /** Emit cap. Default 5. */
  emitCap?: number;
  dry_run?: boolean;
}

interface DiscoveryShapesResponse {
  shapes?: unknown;
}

interface PrincipleMetadata {
  severity?: string;
  principle_name?: string;
  check_hints?: Array<{
    target_vessel?: string;
    forbidden_pattern_regex?: string;
    detail?: string;
  }>;
}

interface PrincipleConcept {
  id: string;
  metadata?: PrincipleMetadata;
  pointer?: { metadata?: PrincipleMetadata };
}

function principleMetadata(p: PrincipleConcept): PrincipleMetadata {
  if (p.metadata && typeof p.metadata === "object") return p.metadata;
  if (p.pointer && p.pointer.metadata && typeof p.pointer.metadata === "object") {
    return p.pointer.metadata;
  }
  return {};
}

interface Finding {
  subtype: "shape_orphan" | "demand_supply_mismatch" | "responsibility_imbalance";
  shape?: string;
  detail: string;
  evidence: Record<string, unknown>;
  cited_principle?: string;
  gap_id: string;
  emitted: boolean;
  emit_status?: number | "error" | "skipped";
}

interface TraceRow {
  metadata?: unknown;
}

interface TemplateRow {
  id?: unknown;
  inputShapes?: unknown;
  outputShapes?: unknown;
}

async function fetchJson<T>(url: string, apiKey: string, timeoutMs: number): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/**
 * /shapes can return one of two formats:
 *   { "shapes": ["shapeA", "shapeB", ...] }     (legacy)
 *   { "shapeA": [{vessel_id, ...}, ...], ... }   (registry form)
 *
 * Returns Map<shape, vessel_ids[]> when registry form, or Map<shape, []>
 * (empty vessel list) when legacy form.
 */
function parseShapeRegistry(json: Record<string, unknown> | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!json) return out;
  if (Array.isArray((json as DiscoveryShapesResponse).shapes)) {
    for (const s of (json as { shapes: unknown[] }).shapes) {
      if (typeof s === "string") out.set(s, []);
    }
    return out;
  }
  for (const [shape, value] of Object.entries(json)) {
    if (typeof shape !== "string") continue;
    const vessels: string[] = [];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          const vid = (entry as { vessel_id?: unknown }).vessel_id;
          if (typeof vid === "string") vessels.push(vid);
        } else if (typeof entry === "string") {
          vessels.push(entry);
        }
      }
    }
    out.set(shape, vessels);
  }
  return out;
}

function templateIdOf(t: TemplateRow): string {
  if (typeof t.id === "string" && t.id.length > 0) {
    return t.id.replace(/^activity:⟨(.+)⟩$/, "$1");
  }
  return "unknown_template";
}

function inputShapesOf(t: TemplateRow): string[] {
  if (Array.isArray(t.inputShapes)) {
    return (t.inputShapes as unknown[]).filter((s): s is string => typeof s === "string");
  }
  return [];
}

function outputShapesOf(t: TemplateRow): string[] {
  if (Array.isArray(t.outputShapes)) {
    return (t.outputShapes as unknown[]).filter((s): s is string => typeof s === "string");
  }
  return [];
}

async function emitGap(
  emitUrl: string,
  apiKey: string,
  finding: Finding,
): Promise<void> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: finding.gap_id,
          category: "resolver_distribution",
          source: "substrate_detected",
          summary: `resolver_distribution ${finding.subtype}: ${finding.detail}`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "resolver_distribution_audit",
            subtype: finding.subtype,
            shape: finding.shape ?? null,
            evidence: finding.evidence,
            cited_principle: finding.cited_principle ?? null,
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  const resp = await fetch(emitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  finding.emit_status = resp.status;
  finding.emitted = resp.ok;
}

export async function resolveResolverDistributionAudit(
  pointer: ResolverDistributionAuditPointer,
): Promise<ResolverResult> {
  const templatesUrl = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const tracesUrl = pointer.tracesUrl ?? DEFAULT_TRACES_URL;
  const discoveryUrl = pointer.discoveryShapesUrl ?? DEFAULT_DISCOVERY_URL;
  const conceptDbUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const minDemand = pointer.minDemandTemplates ?? 3;
  const traceFetchCap = pointer.traceFetchCap ?? 500;
  const emitCap = pointer.emitCap ?? 5;
  const dryRun = pointer.dry_run === true;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  // 1. Discovery shape registry.
  const discoveryJson = await fetchJson<Record<string, unknown>>(discoveryUrl, apiKey, 10_000);
  const shapeRegistry = parseShapeRegistry(discoveryJson);

  // 2. Templates.
  const templatesJson = await fetchJson<{ templates?: unknown }>(
    `${templatesUrl}?limit=500`,
    apiKey,
    15_000,
  );
  const templates: TemplateRow[] = Array.isArray(templatesJson?.templates)
    ? (templatesJson?.templates as TemplateRow[])
    : [];

  // 3. Traces (for invoked-shape calculation).
  const tracesJson = await fetchJson<{ executions?: unknown; traces?: unknown }>(
    `${tracesUrl}?limit=${traceFetchCap}`,
    apiKey,
    15_000,
  );
  const traces: TraceRow[] = Array.isArray(tracesJson?.executions)
    ? (tracesJson?.executions as TraceRow[])
    : Array.isArray(tracesJson?.traces)
      ? (tracesJson?.traces as TraceRow[])
      : [];

  // Build template_id → shapes set, then trace template_ids → invoked shapes.
  const templateInputs = new Map<string, string[]>();
  const templateOutputs = new Map<string, string[]>();
  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    templateInputs.set(tid, inputShapesOf(tpl));
    templateOutputs.set(tid, outputShapesOf(tpl));
  }

  const invokedShapes = new Set<string>();
  for (const t of traces) {
    const md = t.metadata as { template_id?: unknown } | undefined;
    if (!md || typeof md.template_id !== "string") continue;
    const tid = md.template_id.replace(/^activity:⟨(.+)⟩$/, "$1");
    const ins = templateInputs.get(tid) ?? [];
    const outs = templateOutputs.get(tid) ?? [];
    for (const s of ins) invokedShapes.add(s);
    for (const s of outs) invokedShapes.add(s);
  }

  // 4. Principles (for responsibility_imbalance).
  const principlesJson = await fetchJson<{ concepts?: unknown }>(
    `${conceptDbUrl}?source_type=architectural_pattern_principle&limit=100`,
    apiKey,
    10_000,
  );
  const principles: PrincipleConcept[] = Array.isArray(principlesJson?.concepts)
    ? (principlesJson?.concepts as PrincipleConcept[])
    : [];

  // === Pattern 1: shape_orphan ===
  const findings: Finding[] = [];
  const orphans: string[] = [];
  for (const [shape] of shapeRegistry.entries()) {
    if (!invokedShapes.has(shape)) orphans.push(shape);
  }
  // Don't emit one gap per orphan — emit one aggregate gap with the count
  // and a sample (otherwise we flood the gap-drain pipeline).
  if (orphans.length > 0) {
    findings.push({
      subtype: "shape_orphan",
      detail:
        `${orphans.length}/${shapeRegistry.size} advertised shapes never invoked in recent ` +
        `${traces.length} traces. Catalogue carries setup cost for unused shapes.`,
      evidence: {
        total_advertised: shapeRegistry.size,
        orphan_count: orphans.length,
        sample_orphan_shapes: orphans.slice(0, 12),
      },
      cited_principle: "per_dispatch_full_state_capture_is_o_n_memory",
      gap_id: `resolver-dist-orphans-${Date.now()}`,
      emitted: false,
    });
  }

  // === Pattern 2: demand_supply_mismatch ===
  const demand = new Map<string, Set<string>>();
  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    for (const s of inputShapesOf(tpl)) {
      let set = demand.get(s);
      if (!set) {
        set = new Set();
        demand.set(s, set);
      }
      set.add(tid);
    }
  }
  for (const [shape, templateIds] of demand.entries()) {
    if (templateIds.size < minDemand) continue;
    if (shapeRegistry.has(shape)) continue;
    findings.push({
      subtype: "demand_supply_mismatch",
      shape,
      detail:
        `${templateIds.size} templates require '${shape}' but no vessel advertises it ` +
        `(demand ≥ ${minDemand}, supply = 0).`,
      evidence: {
        shape,
        demand_count: templateIds.size,
        sample_demanding_templates: Array.from(templateIds).slice(0, 5),
      },
      cited_principle: "resolvers_live_where_data_lives",
      gap_id: `resolver-dist-demand-${shape}-${Date.now()}`,
      emitted: false,
    });
    if (findings.length >= emitCap * 3) break;
  }

  // === Pattern 3: responsibility_imbalance ===
  // For each principle with a target_vessel and forbidden_pattern_regex,
  // check whether the registry exposes shapes matching the regex IN THE
  // target_vessel's advertised set. The signal is "vessel X advertises a
  // shape whose name suggests it belongs to another vessel's responsibility".
  for (const principle of principles) {
    const md = principleMetadata(principle);
    if (md.severity !== "structural") continue;
    const hints = md.check_hints ?? [];
    for (const hint of hints) {
      if (!hint.target_vessel || !hint.forbidden_pattern_regex) continue;
      let regex: RegExp;
      try {
        regex = new RegExp(hint.forbidden_pattern_regex);
      } catch {
        continue;
      }
      // Find shapes advertised by target_vessel whose name matches the regex.
      const matchedShapes: string[] = [];
      for (const [shape, vessels] of shapeRegistry.entries()) {
        if (!regex.test(shape)) continue;
        if (vessels.length === 0) continue;
        if (vessels.some((v) => v.includes(hint.target_vessel!))) {
          matchedShapes.push(shape);
        }
      }
      if (matchedShapes.length === 0) continue;
      findings.push({
        subtype: "responsibility_imbalance",
        detail:
          `vessel ${hint.target_vessel} advertises shapes matching ` +
          `principle '${md.principle_name ?? principle.id}' forbidden pattern.`,
        evidence: {
          target_vessel: hint.target_vessel,
          forbidden_pattern_regex: hint.forbidden_pattern_regex,
          matched_shapes: matchedShapes.slice(0, 8),
          principle_detail: hint.detail ?? null,
        },
        cited_principle: md.principle_name ?? principle.id,
        gap_id: `resolver-dist-imbalance-${hint.target_vessel}-${Date.now()}`,
        emitted: false,
      });
    }
  }

  // Emit (capped).
  const toEmit = findings.slice(0, emitCap);
  if (!dryRun) {
    for (const f of toEmit) {
      try {
        await emitGap(emitUrl, apiKey, f);
      } catch (err) {
        f.emit_status = "error";
        f.emitted = false;
        (f as Finding & { emit_error?: string }).emit_error = (err as Error).message;
      }
    }
  } else {
    for (const f of toEmit) f.emit_status = "skipped";
  }

  return {
    shape: "resolverDistributionAudit",
    body: {
      total_advertised_shapes: shapeRegistry.size,
      total_invoked_shapes_in_window: invokedShapes.size,
      total_templates_scanned: templates.length,
      total_traces_scanned: traces.length,
      orphan_count: orphans.length,
      sample_orphans: orphans.slice(0, 10),
      finding_count: findings.length,
      findings,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
