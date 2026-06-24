/**
 * orphaned_capability_scan — the DEMAND-DRIVEN half of the substrate's
 * capability find-stage (complements the failure-driven capability_gap_audit).
 *
 * capability_gap_audit mines FAILURE traces, so it only sees capability the
 * substrate WANTED and lacked. It is blind to the opposite, larger defect:
 * capability the substrate HAS (a live registered resolver) but no activity
 * ever invokes. An orphaned capability never fails — it is never called — so
 * it produces no failure trace and the reactive detector never fires.
 *
 * Measured 2026-06-23: 262 live resolvers, 28 ever invoked, 250 orphaned —
 * the entire outward surface (git, code-analysis, concept-graph, obsidian,
 * filesystem writes, llm_completion) is invoked by zero activities. This
 * resolver makes that observable so the EXISTING author/compose loop
 * (drain-pending-substrate-gaps → draft-gap-closing-activity → gap-compose)
 * can author bridge activities that express the advertised capability surface.
 *
 * Signal: live_resolver_shapes (discovery /registry/shapes) MINUS
 * invoked_resolvers (every activity task's resolver / config.type). The
 * difference is filtered to the OUTWARD-CAPABILITY surface (internal
 * tick/observer/scan/audit machinery is invoked by its own tick template, so
 * it drops out of the difference automatically; the residual meta shapes are
 * removed by the filter below). One `orphaned_capability` substrateGap is
 * emitted per orphan (stable id → idempotent upsert), and the existing loop
 * drains it.
 *
 * Constitutional principle: the substrate expresses the full capability
 * surface it advertises. An advertised-but-unexpressed resolver is a gap.
 *
 * cheap tier (HTTP-only, no LLM).
 */

import { METABOB_ENDPOINT, METABOB_API_KEY, DISCOVERY_ENDPOINT } from "../config.js";
import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface OrphanedCapabilityScanPointer {
  type: "orphaned_capability_scan";
  metabobEndpoint?: string;
  discoveryEndpoint?: string;
  devVesselImpulsesUrl?: string;
  apiKey?: string;
  /** When false, classify only — emit no gaps. Default true. */
  emit_gaps?: boolean;
  /** Template fetch page size. Default 2000. */
  template_limit?: number;
  /** Safety cap on gaps emitted per run. Default 40. */
  max_emit?: number;
}

interface TemplateTask {
  resolver?: string;
  resolver_id?: string;
  config?: { type?: string };
}
interface Template {
  tasks?: TemplateTask[];
}

/**
 * Internal-machinery shapes that survive the live−invoked difference but are
 * NOT outward capabilities (substrate self-governance resolvers that happen to
 * be unwrapped by a tick, plus discovery/activity-api meta + learning shapes).
 * Encoded as data so the filter is auditable without logic changes.
 */
const INTERNAL_SUFFIX_RE = /(_tick|_observer|_scan|_audit|_report|_registry|_matrix_score|_health_observer)$/;

const META_DENY = new Set<string>([
  // dev-vessel self-governance / orchestration meta
  "substrateGap", "substrateGap_write", "memoryNote", "memoryNote_write",
  "loadAttribution", "loadAttribution_write", "load_attribution_report",
  "intervention_evaluate", "interventionRefused", "interventionRefused_write",
  "pick_priority_scenario", "compute_state_signature", "dispatch_goal",
  "boredom_enqueue", "propagate_judgment", "json_path_extract",
  "vessel_register_passthrough", "activity_fetch", "activity_create_variant",
  "activity_recommend", "activity_discover_by_shapes", "systemd_restart",
  "apply_proposal_as_patch", "patch_with_tools", "dispatch_latest_auto_draft",
  "variant_promote", "gap_to_scenario_bridge", "prior_failed_attempts",
  "prior_successful_attempts", "comprehensibility_check", "convergent_validity_check",
  "json_schema_validate", "credit_primed_concepts", "credit_vessel_shapes",
  "author_new_resolver", "add_resolver_to_vessel", "lift_demo_noop",
  "vessel_gap_to_cluster", "code_needs_report", "concept_select_for_prompt",
  "concept_search_by_source", "concept_usage_record", "build_signature_detector",
  // vessel-mitosis machinery
  "vessel_mitosis_start", "vessel_mitosis_evaluate", "vessel_mitosis_cutover",
  "cutoverApplied", "surrealdb_export", "surrealdb_import", "gh_repo_create",
  // discovery meta
  "vesselCapability", "vesselEndpoint", "vesselHealth", "vesselRegistry",
  // activity-api learning / read shapes (owned, not outward capability)
  "activityExecutionTrace", "activityTemplate", "activityMetrics",
  "executionTraceList", "variantMetricsSummary", "thompson_posterior",
  "shape_gap_resolution", "shape_producer_inventory", "activityTemplateRecommendation",
  "activityTemplatesByMetrics", "executionTraces", "goal", "toolRiskProfile",
  "compositionSuccess", "impulseRelevance", "preValidationResult", "templateAuditReport",
  "executionTraceWithSignatures", "contextThompsonScores", "mcpTool",
  "discoverByShapesQuery", "activity_search", "trace_search", "tool_pattern_search",
  "goal_execution", "activity_execution", "code_introspect",
  // obsidian INTERNAL learning shapes (the OUTWARD obsidian: capability stays)
  "obsidian_command_gate", "obsidian_execute_gated", "obsidian_learn_commands",
  "obsidian_reflect", "obsidian_deliver_assist", "obsidian_verify_output",
  // test scaffolding
  "test_registration", "test_registration_write", "test_report", "test_report_write",
  "test_audit_report", "test_audit_report_write", "detector_yield_registry",
  "learned_topology_snapshot", "reachable_unlearned_report", "unknown_shape_report",
  "coverage_tick", "compose_topology_tick", "failure_mode_matrix_score",
  "resolver_pattern_report", "markdown_split_sections", "stale_pointer_emit",
  "http_fetch", "fs_read",
]);

/** A shape is an outward capability iff it survives the difference AND is not
 * internal machinery. Write shapes that perform genuine outward mutation
 * (concept_create_write, conceptLink_write, …) are KEPT. */
function isOutwardCapability(shape: string): boolean {
  if (META_DENY.has(shape)) return false;
  if (INTERNAL_SUFFIX_RE.test(shape)) return false;
  // *_write that is a substrate-learning write (not an outward mutation) is denied
  // explicitly above; remaining *_write are capability writes and are kept.
  return true;
}

async function fetchRegistryShapes(discoveryUrl: string): Promise<string[]> {
  try {
    const r = await fetch(`${discoveryUrl.replace(/\/+$/, "")}/registry/shapes`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { shapes?: string[] };
    return j.shapes ?? [];
  } catch {
    return [];
  }
}

/** The templates endpoint caps each page at 100 regardless of `limit`, so we
 * MUST paginate by offset to see the whole corpus — otherwise resolvers invoked
 * only by later-page templates would be reported as false orphans. Returns
 * `null` on any page failure so the caller can flag `degraded` and NOT emit
 * (an incomplete invoked-set would manufacture false orphan gaps). */
async function fetchInvokedResolvers(
  endpoint: string,
  apiKey: string,
  cap: number,
): Promise<Set<string> | null> {
  const invoked = new Set<string>();
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  const base = endpoint.replace(/\/+$/, "");
  const pageSize = 100;
  let offset = 0;
  let total = Infinity;
  let firstPageEmpty = true;
  while (offset < total && offset < cap) {
    let page: { templates?: Template[]; total?: number };
    try {
      const r = await fetch(
        `${base}/v2/activities/templates?limit=${pageSize}&offset=${offset}`,
        { headers, signal: AbortSignal.timeout(20_000) },
      );
      if (!r.ok) return null; // incomplete corpus → caller flags degraded
      page = (await r.json()) as { templates?: Template[]; total?: number };
    } catch {
      return null;
    }
    const templates = page.templates ?? [];
    if (typeof page.total === "number") total = page.total;
    if (templates.length === 0) break;
    firstPageEmpty = false;
    for (const t of templates) {
      for (const task of t.tasks ?? []) {
        const r1 = task.resolver_id ?? task.resolver ?? task.config?.type;
        if (r1) invoked.add(r1);
      }
    }
    offset += templates.length;
  }
  return firstPageEmpty ? null : invoked;
}

async function emitOrphanGap(
  emitUrl: string,
  apiKey: string,
  shape: string,
  liveCount: number,
  invokedCount: number,
): Promise<boolean> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `orphaned-capability-${shape}`,
          category: "orphaned_capability",
          source: "substrate_detected",
          summary:
            `Resolver "${shape}" is a live registered capability but is invoked by 0 of the activity corpus ` +
            `(${invokedCount}/${liveCount} live resolvers are ever invoked). Author an activity that invokes ` +
            `resolver "${shape}" (deterministic tier — NOT an LLM re-derivation) and routes its output onward, ` +
            `so the substrate expresses the capability surface it advertises.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "orphaned_capability_scan",
            cite_principle: "substrate_expresses_the_full_capability_surface_it_advertises",
            shape,
            live_resolver: true,
            invocation_count: 0,
            suggested_remediation:
              "Dispatch draft-gap-closing-activity / gap-compose against this gap to author a bridge " +
              "activity whose task invokes this resolver directly. Prefer the deterministic resolver " +
              "over an llm_completion_dispatch re-derivation of the same capability.",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolveOrphanedCapabilityScan(
  pointer: OrphanedCapabilityScanPointer,
): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const discoveryUrl = pointer.discoveryEndpoint ?? DISCOVERY_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const apiKey = pointer.apiKey ?? process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;
  const emit = pointer.emit_gaps !== false;
  const templateLimit = pointer.template_limit ?? 2000;
  const maxEmit = pointer.max_emit ?? 40;

  const [liveShapes, invoked] = await Promise.all([
    fetchRegistryShapes(discoveryUrl),
    fetchInvokedResolvers(endpoint, apiKey, templateLimit),
  ]);

  // Guard: if discovery returned nothing, or the template corpus could not be
  // fully paginated (invoked === null), do NOT emit — an incomplete invoked-set
  // would manufacture false orphan gaps. Report so the condition is visible.
  const degraded = liveShapes.length === 0 || invoked === null || invoked.size === 0;
  const invokedSet = invoked ?? new Set<string>();

  const orphanCandidates = liveShapes.filter((s) => !invokedSet.has(s));
  const capabilityOrphans = orphanCandidates.filter(isOutwardCapability).sort();

  let gapsEmitted = 0;
  const emitted: string[] = [];
  if (emit && !degraded) {
    for (const shape of capabilityOrphans) {
      if (gapsEmitted >= maxEmit) break;
      const ok = await emitOrphanGap(emitUrl, apiKey, shape, liveShapes.length, invoked.size);
      if (ok) {
        gapsEmitted += 1;
        emitted.push(shape);
      }
    }
  }

  return {
    shape: "orphanedCapabilityReport",
    body: {
      live_shape_count: liveShapes.length,
      invoked_resolver_count: invokedSet.size,
      orphan_candidate_count: orphanCandidates.length,
      capability_orphan_count: capabilityOrphans.length,
      degraded,
      gaps_emitted: gapsEmitted,
      emitted_shapes: emitted,
      capability_orphans: capabilityOrphans.slice(0, 80),
      generated_at: new Date().toISOString(),
    },
  };
}
