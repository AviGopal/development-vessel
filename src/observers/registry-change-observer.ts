import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { resolveDispatch } from "../routes/impulses.js";

type LifecycleEvent = {
  type: string;
  activity_template_id?: string;
  output_shapes?: string[];
  execution_id?: string;
};

export type RunActivityFn = (
  templateId: string,
  variables?: Record<string, string>,
) => Promise<void>;

const DEFAULT_SCENARIOS_DIR = "validation/failure-modes/scenarios";
const DEFAULT_OUT_PATH = `validation/results/${new Date().toISOString().split("T")[0]}-harness-auto.json`;

// Predicate: does this lifecycle event warrant re-scoring the matrix?
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

// Default runActivity: dispatches failure_mode_matrix_score via the local resolver.
async function defaultRunActivity(
  _templateId: string,
  variables: Record<string, string> = {},
): Promise<void> {
  await resolveDispatch({
    type: "failure_mode_matrix_score",
    scenarios_dir: variables["scenarios_dir"] ?? DEFAULT_SCENARIOS_DIR,
    label: variables["label"] ?? `auto-${Date.now()}`,
    out_path: variables["out_path"] ?? DEFAULT_OUT_PATH,
  });
}

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

      runActivity("development-vessel:harness-run-matrix", {
        scenarios_dir: DEFAULT_SCENARIOS_DIR,
        label: `auto-${new Date().toISOString().split("T")[0]}`,
        out_path: DEFAULT_OUT_PATH,
      }).catch((err: unknown) => {
        console.error("[registry-observer] harness re-run failed:", err);
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
