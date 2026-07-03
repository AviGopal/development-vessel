import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { resolveSubstrateGap } from "./substrate-gap.js";
import { resolveActivityFetch } from "./activity-fetch.js";
import { resolveActivityDiscoverByShapes } from "./activity-discover-by-shapes.js";
import { normalizeActivityId } from "./template-repair.js";
import type { ResolverResult } from "./types.js";

/**
 * reachability_gap_repair — Part-1 step 2: the TEMPLATE-MUTATION repair action
 * for an `unreachable_producer` substrateGap (filed by goal-host's
 * `fileReachabilityGap`, classification_metadata.kind === "reachability_gap").
 *
 * The gap already names the unreachable producer (`unreachable_producer_id`)
 * and the required input shapes that made it cold-infeasible
 * (`producer_required_inputs`, captured at gap-file time from
 * discover-by-shapes' `input_schema.required_shapes`). This resolver closes
 * the loop:
 *
 *   1. FETCH the producer template.
 *   2. For each of its required inputs, check (one level, via discover-by-
 *      shapes forward mode) whether THAT shape itself has any producer.
 *   3. CLASSIFY:
 *      - gating_input_infeasible: >=1 required input has ZERO producers — the
 *        producer's resolver is being gated on data the walk can never cold-
 *        produce. Repair: move those inputs from `input_shapes` to
 *        `optional_input_shapes` via `activityTemplate_update` (the exact fix
 *        pattern used to retire `repair-activity-from-failures`'s unreachable
 *        `trace_failure_pattern_report` dependency, migration 154). Safe only
 *        when the producer's resolver self-grounds — that is an existing,
 *        pre-verified property of the primitive, not re-derived here.
 *      - chain_reachable: every required input already has a producer, so the
 *        target shape IS reachable via a longer chain — this is NOT a template
 *        defect, so no mutation is made (verdict NOT_APPLICABLE). Mutating a
 *        producer that isn't broken would be an unjustified template edit.
 *
 * MINTS/MUTATES only what the classification calls for. Never touches a
 * producer whose inputs are all satisfiable.
 */

export interface ReachabilityGapRepairPointer {
  type: "reachability_gap_repair";
  /** substrateGap id to read producer/inputs from (preferred path). */
  gap_id?: string;
  /** Direct override — target producer template id (skips the gap read). */
  unreachable_producer_id?: string;
  /** Direct override — the producer's required input shapes to classify. */
  producer_required_inputs?: string[];
  /** When true, classify + report but do not call activityTemplate_update. */
  dry_run?: boolean;
}

interface GapRecord {
  id?: string;
  classification_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

async function readGap(gapId: string): Promise<GapRecord | null> {
  try {
    const r = await resolveSubstrateGap({ type: "substrateGap", id: gapId, limit: 1 } as never);
    const gaps = ((r?.body as { gaps?: GapRecord[] } | undefined)?.gaps) ?? [];
    return gaps.find((g) => g.id === gapId) ?? gaps[0] ?? null;
  } catch {
    return null;
  }
}

/** Does `shape` have at least one discoverable producer? One-level check. */
async function hasProducer(shape: string): Promise<boolean> {
  if (!shape) return false;
  try {
    const r = await resolveActivityDiscoverByShapes({
      type: "activity_discover_by_shapes",
      required_shapes: [shape],
      mode: "forward",
    });
    const activities = (r?.body as { activities?: unknown[] } | undefined)?.activities ?? [];
    return Array.isArray(activities) && activities.length > 0;
  } catch {
    // Fail open toward "has a producer" — an unclassifiable shape should not
    // be treated as a confirmed gating blocker off a transport error.
    return true;
  }
}

async function postImpulse(type: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${METABOB_ENDPOINT}/v2/impulses/resolve`, {
    method: "POST",
    headers: { Authorization: `ApiKey ${METABOB_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pointer: { type, ...body } }),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}

export async function resolveReachabilityGapRepair(
  pointer: ReachabilityGapRepairPointer,
): Promise<ResolverResult> {
  let gapId = "";
  let producerIdRaw = pointer.unreachable_producer_id ?? "";
  let requiredInputs = pointer.producer_required_inputs ?? [];

  if (!producerIdRaw && pointer.gap_id) {
    gapId = pointer.gap_id;
    const gap = await readGap(pointer.gap_id);
    if (!gap) {
      return {
        shape: "reachabilityGapRepairReport",
        body: { verdict: "UNFAVORABLE", gap_id: gapId, summary: `gap '${gapId}' not found`, error: "gap not found" },
      };
    }
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    producerIdRaw = String(meta["unreachable_producer_id"] ?? "").trim();
    requiredInputs = Array.isArray(meta["producer_required_inputs"])
      ? (meta["producer_required_inputs"] as unknown[]).map(String)
      : [];
  } else if (pointer.gap_id) {
    gapId = pointer.gap_id;
  }

  if (!producerIdRaw) {
    return {
      shape: "reachabilityGapRepairReport",
      body: {
        verdict: "UNFAVORABLE",
        gap_id: gapId,
        summary: "no unreachable_producer_id (gap carried none, or gap_id lookup failed)",
        error: "unreachable_producer_id required",
      },
    };
  }
  const producerId = normalizeActivityId(producerIdRaw);

  const fetched = await resolveActivityFetch({ type: "activity_fetch", templateId: producerId });
  if (fetched.shape !== "activity_template") {
    return {
      shape: "reachabilityGapRepairReport",
      body: {
        verdict: "UNFAVORABLE",
        gap_id: gapId,
        producer_id: producerId,
        summary: `could not fetch producer template '${producerId}'`,
        error: `template not found: ${producerId}`,
      },
    };
  }
  const template = (fetched.body ?? {}) as Record<string, unknown>;
  const currentInputs = Array.isArray(template["input_shapes"]) ? (template["input_shapes"] as unknown[]).map(String) : [];
  const currentOptional = Array.isArray(template["optional_input_shapes"]) ? (template["optional_input_shapes"] as unknown[]).map(String) : [];
  // Classify against the template's OWN current input_shapes when the gap
  // didn't carry any (or the template has since changed) — never invent inputs.
  const inputsToClassify = requiredInputs.length > 0 ? requiredInputs : currentInputs;

  const infeasible: string[] = [];
  for (const shape of inputsToClassify) {
    if (!currentInputs.includes(shape)) continue; // already not gating (e.g. prior repair)
    if (!(await hasProducer(shape))) infeasible.push(shape);
  }

  if (infeasible.length === 0) {
    return {
      shape: "reachabilityGapRepairReport",
      body: {
        verdict: "NOT_APPLICABLE",
        gap_id: gapId,
        producer_id: producerId,
        classification: "chain_reachable",
        checked_inputs: inputsToClassify,
        summary:
          `producer '${producerId}'s required inputs (${inputsToClassify.join(", ") || "none"}) all have ` +
          `existing producers — the target shape is reachable via a longer walk chain, not a template defect. No mutation made.`,
      },
    };
  }

  // Safety guard: bulk-clearing every required input on a many-input producer
  // is a qualitatively different, riskier action than the primitive's proven
  // case (ONE gating input made optional, e.g. repair-activity-from-failures'
  // trace_failure_pattern_report). Observed live: a producer required 5 plain
  // scalar params (path, oldString, newString, cwd, message) — none is a real
  // data shape with a producer, so all 5 classify "infeasible", but declaring
  // them all optional would leave the producer selectable with NOTHING bound,
  // likely a mis-inferred-goal-target artifact rather than a genuine
  // reachability defect. Cap at 2 infeasible inputs (or when they are not the
  // producer's ENTIRE gating contract) so a wholesale clear is refused rather
  // than silently applied.
  const wouldClearEntireContract = infeasible.length === currentInputs.length && currentInputs.length > 2;
  if (wouldClearEntireContract) {
    return {
      shape: "reachabilityGapRepairReport",
      body: {
        verdict: "NOT_APPLICABLE",
        gap_id: gapId,
        producer_id: producerId,
        classification: "bulk_clear_refused",
        infeasible_inputs: infeasible,
        summary:
          `'${producerId}' gates on ${infeasible.length} required inputs (${infeasible.join(", ")}), ` +
          `none with a producer — but that is ALL of its declared inputs, so optionalizing them wholesale ` +
          `would leave it selectable with nothing bound. Likely a mis-inferred goal-target or template-authoring ` +
          `issue, not a single-input reachability defect this repair targets. No mutation made.`,
      },
    };
  }

  const newInputShapes = currentInputs.filter((s) => !infeasible.includes(s));
  const newOptionalShapes = Array.from(new Set([...currentOptional, ...infeasible]));

  if (pointer.dry_run) {
    return {
      shape: "reachabilityGapRepairReport",
      body: {
        verdict: "FAVORABLE",
        gap_id: gapId,
        producer_id: producerId,
        classification: "gating_input_infeasible",
        infeasible_inputs: infeasible,
        proposed_input_shapes: newInputShapes,
        proposed_optional_input_shapes: newOptionalShapes,
        summary:
          `dry-run: '${producerId}' gates on ${infeasible.join(", ")} which has no cold producer; ` +
          `would declare ${infeasible.length === 1 ? "it" : "them"} optional_input_shapes`,
      },
    };
  }

  const { status, text } = await postImpulse("activityTemplate_update", {
    templateId: producerId,
    updates: { input_shapes: newInputShapes, optional_input_shapes: newOptionalShapes },
    evidence: {
      reason:
        `reachability gap ${gapId || "(direct)"}: required input(s) ${infeasible.join(", ")} have no cold ` +
        `producer, making '${producerId}' unreachable from a cold pool; declared optional_input_shapes ` +
        `(bind-if-present, non-gating) per the optional-input primitive (migration 154)`,
    },
  });

  if (status < 200 || status >= 300) {
    return {
      shape: "reachabilityGapRepairReport",
      body: {
        verdict: "UNFAVORABLE",
        gap_id: gapId,
        producer_id: producerId,
        classification: "gating_input_infeasible",
        infeasible_inputs: infeasible,
        summary: `activityTemplate_update rejected (status ${status})`,
        error: text.slice(0, 300),
      },
    };
  }

  return {
    shape: "reachabilityGapRepairReport",
    body: {
      verdict: "FAVORABLE",
      gap_id: gapId,
      producer_id: producerId,
      classification: "gating_input_infeasible",
      infeasible_inputs: infeasible,
      updated_input_shapes: newInputShapes,
      updated_optional_input_shapes: newOptionalShapes,
      summary:
        `'${producerId}' repaired: ${infeasible.join(", ")} moved from input_shapes to optional_input_shapes ` +
        `(cold-infeasible gating input(s)), so it is now shape-feasible from a cold pool`,
    },
  };
}
