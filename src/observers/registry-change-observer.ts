import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT, GOAL_HOST_VESSEL_ENDPOINT } from "../config.js";
import { resolveDispatch } from "../routes/impulses.js";
import { join } from "node:path";

type LifecycleEvent = {
  type: string;
  activity_template_id?: string;
  output_shapes?: string[];
  execution_id?: string;
  // topology-discovery-loop events carry an impulse body when available
  body?: Record<string, unknown>;
};

export type RunActivityFn = (
  templateId: string,
  variables?: Record<string, string>,
) => Promise<void>;

const DEFAULT_SCENARIOS_DIR = join(WORKSPACE_ROOT, "validation/failure-modes/scenarios");

function todayLabel(): string {
  return new Date().toISOString().split("T")[0] ?? "";
}

function defaultOutPath(): string {
  return join(WORKSPACE_ROOT, `validation/results/${todayLabel()}-harness-auto.json`);
}

// ── Topology-discovery dispatch helpers ─────────────────────────────────────

async function fireTopologySnapshot(): Promise<Record<string, unknown>> {
  const result = await resolveDispatch({ type: "learned_topology_snapshot" });
  return result.body as Record<string, unknown>;
}

async function fireReachableUnlearnedReport(): Promise<Record<string, unknown>> {
  const result = await resolveDispatch({ type: "reachable_unlearned_report" });
  return result.body as Record<string, unknown>;
}

async function fireUnknownShapeReport(): Promise<Record<string, unknown>> {
  const result = await resolveDispatch({ type: "unknown_shape_report" });
  return result.body as Record<string, unknown>;
}

// Debounce state for the two aggregators (coverage-tick and substrate-health-tick)
const AGGREGATOR_DEBOUNCE_MS = 30_000;
let lastAggregatorFire = 0;

/** Reset debounce counter — only for tests. */
export function resetAggregatorDebounce(): void {
  lastAggregatorFire = 0;
}

async function fireAggregatorsIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastAggregatorFire < AGGREGATOR_DEBOUNCE_MS) return;
  lastAggregatorFire = now;
  await Promise.all([
    resolveDispatch({ type: "coverage_tick" }).catch((e: unknown) =>
      console.error("[registry-observer] coverage-tick failed:", e),
    ),
    resolveDispatch({ type: "substrate_health_tick" }).catch((e: unknown) =>
      console.error("[registry-observer] substrate-health-tick failed:", e),
    ),
  ]);
}

// Full topology chain: fires on activityRegistryChange or qualifying lifecycle events.
export async function runTopologyChain(): Promise<void> {
  const snapshotBody = await fireTopologySnapshot();

  // Fan out: reachable-unlearned and unknown-shape in parallel
  const [unlearnedBody, unknownBody] = await Promise.all([
    fireReachableUnlearnedReport(),
    fireUnknownShapeReport(),
  ]);

  // Conditional probes
  const unlearnedTotal = (unlearnedBody["total"] as number) ?? 0;
  const unknownTotal = (unknownBody["total"] as number) ?? 0;
  const untraversedEdges = (snapshotBody["untraversed_edges"] as unknown[]) ?? [];

  const probes: Promise<void>[] = [];

  if (unlearnedTotal > 0) {
    probes.push(
      resolveDispatch({ type: "reachable_unlearned_report" }).catch((e: unknown) =>
        console.error("[registry-observer] probe-reachable-unlearned failed:", e),
      ).then(() => {}),
    );
  }

  if (untraversedEdges.length > 0) {
    probes.push(
      resolveDispatch({ type: "learned_topology_snapshot" }).catch((e: unknown) =>
        console.error("[registry-observer] probe-untraversed-edge failed:", e),
      ).then(() => {}),
    );
  }

  if (unknownTotal > 0) {
    probes.push(
      resolveDispatch({ type: "unknown_shape_report" }).catch((e: unknown) =>
        console.error("[registry-observer] escalate-unknown-shape failed:", e),
      ).then(() => {}),
    );
  }

  await Promise.all(probes);

  // Aggregators (debounced)
  await fireAggregatorsIfDue();
}

// ── Recommendation → execution dispatch ──────────────────────────────────────
//
// Closes the recommend→execute loop for topology-discovery probes. The probe
// templates (probe-reachable-unlearned, probe-untraversed-edge,
// escalate-unknown-shape) emit an `activityRecommendation` impulse but
// intentionally do NOT include a dispatch task — the engine does not
// interpolate `{{}}` in non-llm task configs, and adding a combined resolver
// would bypass the binding layer (see memoryNote
// "Cross-task data flow uses slot-binding, not new resolvers or {{}}
// interpolation").
//
// Mechanism: when activity-api broadcasts `execution_completed` for one of
// these probe templates, the observer re-derives the top recommended template
// from the resolver locally (cheap, deterministic, no LLM, no impulse-content
// retrieval needed) and POSTs to goal-host-vessel `/run-goal` with
// `targetTemplateId` + `parent_execution_id` so the dispatched execution
// becomes a child of the probe.
//
// Dedupe: per-(parent_execution_id, target_template_id) for 60s to absorb
// repeat broadcasts (activity-api emits `execution_completed` once but the
// observer reconnects on socket flap and the events can replay).

const DISPATCH_DEDUPE_MS = 60_000;
const recentDispatches = new Map<string, number>();

function shouldDispatch(parentExecutionId: string, targetTemplateId: string): boolean {
  const key = `${parentExecutionId}::${targetTemplateId}`;
  const last = recentDispatches.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < DISPATCH_DEDUPE_MS) return false;
  recentDispatches.set(key, now);
  if (recentDispatches.size > 256) {
    const oldest = [...recentDispatches.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of oldest.slice(0, 64)) recentDispatches.delete(k);
  }
  return true;
}

// Strip SurrealDB record-id brackets: "activity:⟨development-vessel:foo⟩" → "development-vessel:foo".
// Both the WebSocket `activity_id` field and the report resolver's
// `top_template_id` carry this wrapping; goal-host-vessel expects clean ids.
function stripRecordIdWrapping(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^activity:⟨(.+)⟩$/);
  return m ? m[1] : raw;
}

function looksLikeProbe(activityId: string): boolean {
  return (
    activityId.includes("probe-reachable-unlearned") ||
    activityId.includes("probe-untraversed-edge") ||
    activityId.includes("escalate-unknown-shape")
  );
}

async function pickTopTemplateForProbe(activityId: string): Promise<string | null> {
  // Each probe uses a different report resolver; re-derive locally rather
  // than fetching the dead recommendation impulse from activity-api (impulse
  // content is not persisted to the trace store).
  try {
    if (activityId.includes("probe-reachable-unlearned")) {
      const res = await resolveDispatch({ type: "reachable_unlearned_report" });
      const body = res.body as Record<string, unknown>;
      const top = body["top_template_id"];
      return typeof top === "string" && top.length > 0 ? top : null;
    }
    if (activityId.includes("probe-untraversed-edge")) {
      const res = await resolveDispatch({ type: "learned_topology_snapshot" });
      const body = res.body as Record<string, unknown>;
      const edges = body["untraversed_edges"] as Array<Record<string, unknown>> | undefined;
      const first = edges?.[0];
      const tpl = first?.["producer_template_id"] ?? first?.["template_id"];
      return typeof tpl === "string" && tpl.length > 0 ? tpl : null;
    }
    if (activityId.includes("escalate-unknown-shape")) {
      const res = await resolveDispatch({ type: "unknown_shape_report" });
      const body = res.body as Record<string, unknown>;
      const top = body["top_template_id"] ?? body["best_template_id"];
      return typeof top === "string" && top.length > 0 ? top : null;
    }
  } catch (err) {
    console.error(`[recommend-dispatch] failed to derive top template for ${activityId}:`, err);
  }
  return null;
}

/**
 * Visible for tests — clears dedupe state.
 */
export function _resetDispatchDedupe(): void {
  recentDispatches.clear();
}

export async function dispatchRecommendationForProbe(
  rawActivityId: string | undefined,
  parentExecutionId: string | undefined,
): Promise<{ dispatched: boolean; targetTemplateId?: string; dispatchId?: string; reason?: string }> {
  const activityId = stripRecordIdWrapping(rawActivityId);
  if (!activityId) return { dispatched: false, reason: "no activity_id" };
  if (!looksLikeProbe(activityId)) return { dispatched: false, reason: "not a probe" };
  if (!parentExecutionId) return { dispatched: false, reason: "no parent_execution_id" };

  const rawTargetTemplateId = await pickTopTemplateForProbe(activityId);
  const targetTemplateId = stripRecordIdWrapping(rawTargetTemplateId ?? undefined);
  if (!targetTemplateId) return { dispatched: false, reason: "no top template" };

  if (!shouldDispatch(parentExecutionId, targetTemplateId)) {
    return { dispatched: false, targetTemplateId, reason: "deduped" };
  }

  try {
    const res = await fetch(`${GOAL_HOST_VESSEL_ENDPOINT}/run-goal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        goal: `dispatch recommended template ${targetTemplateId} (from probe ${activityId})`,
        targetTemplateId,
        tags: ["intent:topology_discovery", "intent:probe_dispatch"],
        parent_execution_id: parentExecutionId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { dispatched: false, targetTemplateId, reason: `goal-host HTTP ${res.status}: ${text.slice(0, 120)}` };
    }
    const body = (await res.json()) as { dispatchId?: string };
    console.log(
      `[recommend-dispatch] ${activityId} → ${targetTemplateId} dispatchId=${body.dispatchId} parent=${parentExecutionId}`,
    );
    return { dispatched: true, targetTemplateId, dispatchId: body.dispatchId };
  } catch (err) {
    return { dispatched: false, targetTemplateId, reason: (err as Error).message };
  }
}

// ── Harness-matrix predicate ─────────────────────────────────────────────────

// Predicate: does this lifecycle event warrant re-scoring the failure-mode matrix?
// Also used to determine whether to fire the topology chain.
// Returns false immediately if the event type is not lifecycle:execution:succeeded.
export function shouldRescore(event: LifecycleEvent): boolean {
  if (event.type !== "lifecycle:execution:succeeded") return false;
  const tid = event.activity_template_id ?? "";
  if (tid.includes("draft-gap-closing-activity")) return true;
  if (tid.includes("prune-activity")) return true;
  if (tid.includes("replace-activity")) return true;
  if (event.output_shapes?.includes("activityRegistryChange")) return true;
  return false;
}

// ── Default runActivity ───────────────────────────────────────────────────────

// Default runActivity: dispatches failure_mode_matrix_score via the local resolver.
async function defaultRunActivity(
  _templateId: string,
  variables: Record<string, string> = {},
): Promise<void> {
  await resolveDispatch({
    type: "failure_mode_matrix_score",
    scenarios_dir: variables["scenarios_dir"] ?? DEFAULT_SCENARIOS_DIR,
    label: variables["label"] ?? `auto-${Date.now()}`,
    out_path: variables["out_path"] ?? defaultOutPath(),
  });
}

// ── Observer lifecycle ────────────────────────────────────────────────────────

let _stopController: AbortController | null = null;

export function stopRegistryChangeObserver(): void {
  _stopController?.abort();
  _stopController = null;
}

export function startRegistryChangeObserver(
  runActivity: RunActivityFn = defaultRunActivity,
): void {
  if (_stopController) return; // already running

  const controller = new AbortController();
  _stopController = controller;

  function connect(backoffMs: number): void {
    if (controller.signal.aborted) return;

    const wsUrl = METABOB_ENDPOINT.replace(/^http/, "ws") + "/ws";

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error("[registry-observer] WebSocket construction failed:", err);
      reschedule(backoffMs);
      return;
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "authenticate", token: METABOB_API_KEY }));
    });

    ws.addEventListener("message", (ev) => {
      let event: LifecycleEvent;
      try {
        const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
        // Normalize bus events to canonical lifecycle shape.
        // Two sources carry execution-succeeded signal:
        //   1. activity-api trace-writer emits "execution_completed" (legacy path)
        //   2. BusForwardingEventSink emits "lifecycle.execution.succeeded" (bus path,
        //      dot-notation per bus-forwarder colon→dot mapping). This is the path
        //      that makes the bus "draw current" — without this arm, lifecycle.*
        //      events from the bus were silently discarded (audit inv-077 finding).
        if (parsed["type"] === "execution_completed") {
          const d = (parsed["data"] ?? {}) as Record<string, unknown>;
          event = {
            type: "lifecycle:execution:succeeded",
            activity_template_id: (d["activity_id"] as string | undefined) ?? (d["variant_id"] as string | undefined),
            execution_id: d["execution_id"] as string | undefined,
            output_shapes: d["output_shapes"] as string[] | undefined,
          };
        } else if (parsed["type"] === "lifecycle.execution.succeeded") {
          // Bus-emitted form from BusForwardingEventSink (dot-notation, inverted from colon).
          const d = (parsed["data"] ?? {}) as Record<string, unknown>;
          event = {
            type: "lifecycle:execution:succeeded",
            activity_template_id: (d["templateId"] as string | undefined) ?? (d["activity_template_id"] as string | undefined),
            execution_id: (d["executionId"] as string | undefined) ?? (d["execution_id"] as string | undefined),
            output_shapes: (d["outputShapes"] as string[] | undefined) ?? (d["output_shapes"] as string[] | undefined),
          };
        } else {
          event = parsed as LifecycleEvent;
        }
      } catch {
        return;
      }
      if (event.type !== "lifecycle:execution:succeeded") return;

      // Recommend → execute dispatch (topology-discovery probes).
      // Runs regardless of `shouldRescore` — this is a separate loop closure
      // that targets probe templates, not the registry-change rescore path.
      dispatchRecommendationForProbe(event.activity_template_id, event.execution_id).catch(
        (err: unknown) =>
          console.error("[recommend-dispatch] unexpected error:", err),
      );

      if (!shouldRescore(event)) return;

      // Fire harness matrix re-score
      runActivity("development-vessel:harness-run-matrix", {
        scenarios_dir: DEFAULT_SCENARIOS_DIR,
        label: `auto-${todayLabel()}`,
        out_path: defaultOutPath(),
      }).catch((err: unknown) => {
        console.error("[registry-observer] harness re-run failed:", err);
      });

      // Fire topology chain (§4 extension)
      runTopologyChain().catch((err: unknown) => {
        console.error("[registry-observer] topology chain failed:", err);
      });
    });

    ws.addEventListener("error", () => {
      // Bun's WebSocket fires error then close; just wait for close
    });

    ws.addEventListener("close", () => {
      if (!controller.signal.aborted) {
        reschedule(backoffMs);
      }
    });
  }

  function reschedule(backoffMs: number): void {
    const next = Math.min(backoffMs * 2, 30_000);
    setTimeout(() => connect(next), backoffMs);
  }

  // Start with 1s initial backoff
  connect(1_000);
}
