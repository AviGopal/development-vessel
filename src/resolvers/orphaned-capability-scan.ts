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
  config?: { type?: string; activity_task_field?: string };
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

/**
 * Output/result shapes (`…Result`) are PRODUCED by a resolver, not invoked as
 * one — an activity never has `resolver: "codeReadResult"`. Excluded so we only
 * flag genuine resolver-entry capabilities. (A resolver advertises both its
 * trigger shape and its produced shapes in discovery; the produced ones are not
 * orphaned capabilities — they are outputs.)
 */
const OUTPUT_SHAPE_RE = /Result$/;

/**
 * activity-api owns the trace store + learning loop; its write/mutation shapes
 * are internal bookkeeping, not outward capability. Also the camelCase READ
 * shapes that duplicate an invoked snake_case resolver (e.g. `git_status` is
 * invoked and produces `gitStatus`; the latter is not an orphaned capability).
 */
const ACTIVITY_API_WRITE = new Set<string>([
  "activityExecutionTrace_write", "activityExecutionTrace_delete", "activityFeedback_write",
  "activityComposition_write", "activityTemplate_write", "activityTemplate_update",
  "activityTemplate_deprecate", "activityVariant_write", "impulseRelevance_write",
  "toolUsage_write", "toolArgumentPattern_write", "executionSequences_write",
  "shapeScore_write", "shapeGapResolution_write", "similarState_write",
  "goalSeeking_write", "execution_write", "compositionEdge_write",
  "goal_verification_label_write",
]);

const OUTPUT_READ_DUPLICATE = new Set<string>([
  // camelCase produced/read shapes whose snake_case resolver is invoked, or
  // pure read shapes owned by activity-api / local-tools / concept-db.
  "gitStatus", "gitDiff", "fileContent", "conceptGraph", "relatedConcepts",
  "conceptUsageStats", "conceptSequence", "impulseCooccurrenceEdges",
  "impulseSignatureConcept", "interactorObservation",
]);

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
  if (OUTPUT_SHAPE_RE.test(shape)) return false;          // produced output, not a resolver
  if (ACTIVITY_API_WRITE.has(shape)) return false;        // trace-store / learning bookkeeping
  if (OUTPUT_READ_DUPLICATE.has(shape)) return false;     // read/output dup of an invoked resolver
  // Remaining *_write are genuine outward capability writes (concept-db, ui,
  // stateful-ui, sensitivity) and are kept.
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
      // An `auto-bridge-<shape>` activity EXISTS precisely to invoke a previously-
      // orphaned resolver. Count the shape as expressed from the bridge's existence,
      // not only from a task whose resolver field the loop happens to recognise —
      // author_producer's bridge may invoke the resolver in a form (compose/subActivity)
      // this scan doesn't parse, so without this the shape stayed "orphaned" forever and
      // the loop churned mint→close→re-flag on it (e.g. repairPolicy re-minted 5×/90m,
      // starving every other gap incl. operator requests). (2026-07-01)
      const tid = String((t as { id?: string }).id ?? "").replace(/^activity:⟨/, "").replace(/⟩$/, "");
      const bm = tid.match(/^auto-bridge-(.+)$/);
      if (bm && bm[1]) invoked.add(bm[1]);
    }
    offset += templates.length;
  }
  return firstPageEmpty ? null : invoked;
}

/**
 * Files that already REFERENCE this shape — the candidate consumers a rewire would point at.
 *
 * REWIRE BEFORE MINT (law 3, 2026-08-29). Every orphan gap this scan emitted said "Author an
 * activity that invokes resolver X" — 114 of 114 measured. That prescription satisfies the orphan
 * METRIC by creating a consumer that exists only to consume, which is the documented
 * poison_producer path (12 such gaps open, and the category itself sits at 346 attempts / 0 lands).
 *
 * The real shape of these defects is a producer/consumer SURFACE MISMATCH: an intended consumer
 * already exists and reads a different key, tree, file or window. Three verified instances from one
 * session, every one repaired by rewiring and none by minting — solicitation_outcome_scan read
 * obsidian episodes keyed on solicitation_ids while answers landed in stateful-ui keyed on
 * panel_id; mitosis cutover checked freshness against /vessels while committing into the push
 * clone; reuse lineage was written to parent_* fields whose CC1 assertion rejected it.
 *
 * A rewire needs to know WHO already references the shape. The gap could not say, so it asked for
 * the only repair it could describe. This supplies the missing half.
 *
 * Best-effort and bounded: grep is cheap, the result is advisory, and on any failure the gap simply
 * carries no candidates and falls back to the author-a-consumer wording.
 */
function findCandidateConsumers(shape: string): string[] {
  try {
    const root = process.env["WORKSPACE_ROOT"] ?? "/workspace";
    const out = Bun.spawnSync(
      ["grep", "-rl", "--include=*.ts", "--exclude-dir=node_modules", shape, `${root}/repos`],
      { stdout: "pipe", stderr: "pipe" },
    );
    return new TextDecoder()
      .decode(out.stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes(".test."))
      .map((l) => l.replace(`${root}/`, ""))
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function emitOrphanGap(
  emitUrl: string,
  apiKey: string,
  shape: string,
  liveCount: number,
  invokedCount: number,
): Promise<boolean> {
  const candidateConsumers = findCandidateConsumers(shape);
  const hasCandidates = candidateConsumers.length > 0;
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
            `(${invokedCount}/${liveCount} live resolvers are ever invoked). ` +
            (hasCandidates
              ? `REWIRE BEFORE MINT (law 3): these files already reference "${shape}" and are the likely ` +
                `intended consumers — ${candidateConsumers.join(", ")}. Check whether one of them reads a ` +
                `DIFFERENT surface than the producer writes (a different key, tree, file or window); that ` +
                `mismatch, not an absent consumer, is the usual cause. Point the existing consumer at the ` +
                `producer's actual surface. Only if none of them is meant to consume this shape should a new ` +
                `activity be authored.`
              : `No file outside tests references "${shape}", so no rewire target was found. Author an ` +
                `activity that invokes it (deterministic tier — NOT an LLM re-derivation) and routes its ` +
                `output onward, so the substrate expresses the capability surface it advertises.`),
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "orphaned_capability_scan",
            cite_principle: "substrate_expresses_the_full_capability_surface_it_advertises",
            shape,
            live_resolver: true,
            invocation_count: 0,
            candidate_consumers: candidateConsumers,
            repair_direction: hasCandidates ? "rewire" : "mint",
            suggested_remediation: hasCandidates
              ? `Inspect the candidate consumers (${candidateConsumers.join(", ")}) for a surface mismatch ` +
                `against the producer of "${shape}" — wrong key, wrong tree, wrong file, wrong window — and ` +
                `repair the CONSUMER to read what the producer actually writes. Minting a new activity to ` +
                `invoke this resolver satisfies the orphan count while adding a consumer nobody wanted ` +
                `(law 3, and the poison_producer class).`
              : "No existing consumer references this shape. Dispatch draft-gap-closing-activity / " +
                "gap-compose to author a bridge activity whose task invokes this resolver directly. " +
                "Prefer the deterministic resolver over an llm_completion_dispatch re-derivation.",
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

// Shapes whose `orphaned-capability-<shape>` gap is already CLOSED = a bridge was minted
// (capability expressed). Read from our own gap store, because the invoked-set (built from
// the legacy activity_template endpoint) CANNOT see auto-bridge-<shape> activities — they
// land in the `activity` paradigm table. Without this the scan re-flagged already-bridged
// shapes every cycle → the loop churned mint→close→re-flag (repairPolicy re-minted 5×/90m,
// starving all other gaps). Best-effort; empty set on failure. (2026-07-01)
async function fetchClosedOrphanShapes(emitUrl: string, apiKey: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const r = await fetch(emitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
      body: JSON.stringify({ impulse: { pointer: { type: "substrateGap", status: "closed", category: "orphaned_capability", limit: 500 } } }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json()) as { body?: { gaps?: Array<{ id?: string }> } };
    for (const g of j.body?.gaps ?? []) {
      const m = String(g.id ?? "").match(/^orphaned-capability-(.+)$/);
      if (m && m[1]) out.add(m[1]);
    }
  } catch { /* best-effort */ }
  return out;
}

// Reachability pre-filter (unified selection at the goal horizon): an open
// orphaned_capability gap whose shape has NO live producer has VoI 0 — no dispatch
// of it can author a bridge — so retire it (open -> rejected) and every drain
// (all of which filter status=="open") stops re-dispatching it for free. Reuses
// the live-producer signal (liveSet from the discovery registry). Self-heals: when
// the producer re-registers, the emit loop re-writes the gap open. Caller guards on
// !degraded && liveSet.size>0 so a registry outage never rejects the corpus.
async function rejectUnreachableOrphanGaps(emitUrl: string, apiKey: string, liveSet: Set<string>): Promise<string[]> {
  const rejected: string[] = [];
  try {
    const r = await fetch(emitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
      body: JSON.stringify({ impulse: { pointer: { type: "substrateGap", status: "open", category: "orphaned_capability", limit: 500 } } }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json()) as { body?: { gaps?: Array<{ id?: string; classification_metadata?: { shape?: string } }> } };
    for (const g of j.body?.gaps ?? []) {
      const id = String(g.id ?? "");
      const shape = g.classification_metadata?.shape ?? id.replace(/^orphaned-capability-/, "");
      if (!shape || liveSet.has(shape)) continue; // mintable — keep open
      await fetch(emitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: { id, status: "rejected", classification_metadata: { shape, unreachable_reason: "no_live_producer" } } } } }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
      rejected.push(id);
    }
  } catch { /* best-effort */ }
  return rejected;
}

export async function resolveOrphanedCapabilityScan(
  pointer: OrphanedCapabilityScanPointer,
): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const discoveryUrl = pointer.discoveryEndpoint ?? DISCOVERY_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const apiKey = pointer.apiKey ?? process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;
  const emit =
    pointer.emit_gaps !== false &&
    (pointer as { emit_gap?: boolean }).emit_gap !== false &&
    (pointer as { dry_run?: boolean }).dry_run !== true;
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
  // The count the report and gap summaries should use: invoked resolvers that are ALSO live.
  const invokedLive = liveShapes.filter((s) => invokedSet.has(s)).length;
  // Drop shapes already expressed by a minted bridge (closed orphan gap) — see
  // fetchClosedOrphanShapes: the invoked-set can't see paradigm-table auto-bridges,
  // so this is what actually stops the mint→close→re-flag churn.
  const bridged = await fetchClosedOrphanShapes(emitUrl, apiKey).catch(() => new Set<string>());
  // CONSUMPTION HAS TWO SURFACES, NOT ONE (2026-08-29). The invoked-set counts ACTIVITY-mediated
  // invocation only, so a resolver consumed directly by ANOTHER RESOLVER was invisible and kept
  // being reported as an orphan. Proven live: solicitation_outcome_scan consumes the uiQuestion
  // read shape on every bare dispatch (it self-supplies ids from it and returned 85 outcomes), and
  // orphaned-capability-uiQuestion was STILL emitted afterwards. The detector could not see a
  // repair that had already happened — the same wrong-surface defect it exists to find, in itself.
  //
  // Reuses findCandidateConsumers rather than adding a second scanner (law 3). Bounded by
  // construction: it runs only over shapes that already passed isOutwardCapability and the bridged
  // filter — tens of shapes, not the full 389 — and each call is one grep.
  //
  // A false NEGATIVE here is cheap (a real orphan goes unreported for a cycle); a false POSITIVE is
  // expensive, because it manufactures the worklist that fed 346 attempts at 0 lands. So the
  // widening is deliberate: any non-test file referencing the shape is enough to say "someone reads
  // this", and the rewire prescription then names those files.
  const capabilityOrphans = orphanCandidates
    .filter(isOutwardCapability)
    .filter((s) => !bridged.has(s))
    .filter((s) => findCandidateConsumers(s).length === 0)
    .sort();

  let gapsEmitted = 0;
  const emitted: string[] = [];
  if (emit && !degraded) {
    for (const shape of capabilityOrphans) {
      if (gapsEmitted >= maxEmit) break;
      // Pass the RECONCILED count, not invoked.size — the gap summary renders it as
      // "(N/M live resolvers are ever invoked)", and invoked.size is drawn from a different
      // population, which is how that sentence came to print 394/389.
      const ok = await emitOrphanGap(emitUrl, apiKey, shape, liveShapes.length, invokedLive);
      if (ok) {
        gapsEmitted += 1;
        emitted.push(shape);
      }
    }
  }

  // Retire VoI-0 orphan gaps whose shape has no live producer (see above).
  const liveSet = new Set(liveShapes);
  let rejectedUnreachable: string[] = [];
  if (emit && !degraded && liveSet.size > 0) {
    rejectedUnreachable = await rejectUnreachableOrphanGaps(emitUrl, apiKey, liveSet);
  }

  return {
    shape: "orphanedCapabilityReport",
    body: {
      live_shape_count: liveShapes.length,
      // RECONCILED (2026-08-29). invokedSet counts every resolver seen invoked ANYWHERE, which is
      // not the population liveShapes is drawn from — so the report printed "394/389 live resolvers
      // are ever invoked", a numerator exceeding its denominator, and neither the ratio nor the
      // orphan count could be trusted as a worklist. Report the INTERSECTION, which is the quantity
      // the sentence actually claims, and keep the raw total separately so nothing is hidden.
      invoked_resolver_count: invokedLive,
      invoked_anywhere_count: invokedSet.size,
      orphan_candidate_count: orphanCandidates.length,
      capability_orphan_count: capabilityOrphans.length,
      degraded,
      gaps_emitted: gapsEmitted,
      emitted_shapes: emitted,
      rejected_unreachable: rejectedUnreachable,
      capability_orphans: capabilityOrphans.slice(0, 80),
      generated_at: new Date().toISOString(),
    },
  };
}
