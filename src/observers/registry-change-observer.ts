import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT } from "../config.js";
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
        event = JSON.parse(String(ev.data)) as LifecycleEvent;
      } catch {
        return;
      }
      if (event.type !== "lifecycle:execution:succeeded") return;
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
