/**
 * concept-bridge-observer — bridges VesselDaemon.emitResolveTrace events
 * into concept-db usage signals.
 *
 * Background
 * ----------
 * As of the VesselDaemon trace-emission change (ias-executor-ts 2026-05-28),
 * every standalone POST /resolve hit on a substrate vessel publishes a
 * task.completed event with `data.source = "vessel_daemon_resolve"`.
 *
 * concept-db's ExecutionObserver subscribes to the same WS and filters
 * `impulse_resolutions` whose impulse_id begins with `concept:` or whose
 * shape === "concept". Analysis-vessel-style resolutions don't match
 * either filter — their impulse_id is `impulse:<pointerType>:<ts>` and
 * shape is the raw analysis shape (problem_detection, code_annotation,
 * cpg_query_result, source_code, code_quality, error_log).
 *
 * Result without this bridge: 0 concept usages recorded per analysis call.
 *
 * What this observer does
 * -----------------------
 * 1. Subscribe to activity-api `/ws`, authenticate with METABOB_API_KEY.
 * 2. Filter for events with `type=task.completed` AND
 *    `data.source=vessel_daemon_resolve`.
 * 3. For each `impulse_resolutions[]` entry whose shape is in
 *    {problem_detection, code_annotation, cpg_query_result, source_code,
 *     code_quality, error_log}:
 *       a. Upsert a concept keyed on (pointer_type=shape, shape=shape)
 *          via concept-db's POST /concepts/upsert-by-signature.
 *       b. Record usage on that concept via POST /concepts/:id/usage,
 *          tagging the trace's execution_id and the resolver's
 *          success/duration fields.
 *
 * Design note (per repos/development-vessel/CLAUDE.md three-layer rule)
 * --------------------------------------------------------------------
 * This TS file is intentionally limited to ROUTING — subscribe, filter,
 * forward. The decision of *which* analysis shapes count as concepts
 * (the BRIDGEABLE_SHAPES set below) is the only "policy" here, and it's
 * a literal constant for auditability. Per-symbol concept extraction (the
 * richer fan-out where each function/class in a problem_detection result
 * becomes its own concept) is correctly a substrate-authored activity and
 * is deferred to openspec/changes/2026-05-28-concept-bridge-observer/.
 *
 * Failure handling
 * ----------------
 * Fire-and-forget HTTP. concept-db unavailable → log + skip the event.
 * WS disconnects → exponential backoff up to 30 s (mirrors
 * registry-change-observer.ts).
 */

import { METABOB_ENDPOINT, METABOB_API_KEY, CONCEPT_DB_ENDPOINT } from "../config.js";

/** Shapes from analysis-vessel that this bridge converts into concept usage. */
const BRIDGEABLE_SHAPES = new Set([
  "problem_detection",
  "code_annotation",
  "cpg_query_result",
  "source_code",
  "code_quality",
  "error_log",
]);

interface ImpulseResolution {
  impulse_id?: string;
  resolver_id?: string;
  resolver_tier?: string;
  vessel_id?: string;
  shape?: string;
  latency_ms?: number;
  cost_usd?: number;
}

interface TaskCompletedEvent {
  type?: string;
  data?: {
    execution_id?: string;
    success?: boolean;
    completed_at?: string;
    source?: string;
    impulse_resolutions?: ImpulseResolution[];
  };
}

interface UpsertResponse {
  concept_id?: string;
  id?: string;
  created?: boolean;
}

let _stopController: AbortController | null = null;

export function stopConceptBridgeObserver(): void {
  _stopController?.abort();
  _stopController = null;
}

export function startConceptBridgeObserver(): void {
  if (_stopController) return;
  const controller = new AbortController();
  _stopController = controller;

  function connect(backoffMs: number): void {
    if (controller.signal.aborted) return;

    const wsUrl = METABOB_ENDPOINT.replace(/^http/, "ws") + "/ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error("[concept-bridge] WebSocket construction failed:", err);
      reschedule(backoffMs);
      return;
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "authenticate", token: METABOB_API_KEY }));
      console.log(`[concept-bridge] connected to ${wsUrl}`);
    });

    ws.addEventListener("message", (ev) => {
      let event: TaskCompletedEvent;
      try {
        event = JSON.parse(String(ev.data)) as TaskCompletedEvent;
      } catch {
        return;
      }
      if (event.type !== "task.completed") return;
      const data = event.data;
      if (!data) {
        console.warn("[concept-bridge] task.completed missing data");
        return;
      }
      if (data.source !== "vessel_daemon_resolve") {
        // Not a vessel-daemon resolve — silently skip but log at debug-cadence
        // so we can confirm cross-flow events still arrive.
        return;
      }

      const resolutions = data.impulse_resolutions ?? [];
      console.log(
        `[concept-bridge] vessel_daemon_resolve received: ${resolutions.length} resolutions, shapes=[${resolutions.map((r) => r.shape ?? "?").join(",")}], exec=${data.execution_id}`,
      );
      let bridged = 0;
      for (const r of resolutions) {
        const shape = r.shape;
        if (!shape || !BRIDGEABLE_SHAPES.has(shape)) continue;
        bridged++;
        // Fire and forget — never block the WS event loop.
        recordConceptUsage(shape, r, data)
          .then(() => {
            console.log(`[concept-bridge] minted/usage recorded shape=${shape} exec=${data.execution_id}`);
          })
          .catch((err: unknown) => {
            console.error(
              `[concept-bridge] usage record failed for ${shape}:`,
              err instanceof Error ? err.message : err,
            );
          });
      }
      if (bridged === 0 && resolutions.length > 0) {
        console.log(
          `[concept-bridge] no bridgeable shapes in resolutions: [${resolutions.map((r) => r.shape).join(",")}]`,
        );
      }
    });

    ws.addEventListener("error", () => {
      // Bun's WebSocket fires error then close; just wait for close.
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

  connect(1_000);
}

async function recordConceptUsage(
  shape: string,
  resolution: ImpulseResolution,
  data: NonNullable<TaskCompletedEvent["data"]>,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (METABOB_API_KEY) headers["Authorization"] = `ApiKey ${METABOB_API_KEY}`;

  // Step 1: upsert the concept by (pointer_type=shape, shape=shape).
  // Idempotent server-side: returns existing concept on second call.
  const upsertRes = await fetch(`${CONCEPT_DB_ENDPOINT}/concepts/upsert-by-signature`, {
    method: "POST",
    headers,
    body: JSON.stringify({ pointer_type: shape, shape }),
  });
  if (!upsertRes.ok) {
    throw new Error(
      `upsert failed: ${upsertRes.status} ${await upsertRes.text().catch(() => "")}`,
    );
  }
  const upsert = (await upsertRes.json()) as UpsertResponse;
  const conceptId = upsert.concept_id ?? upsert.id;
  if (!conceptId) {
    throw new Error("upsert returned no concept_id");
  }

  // Step 2: record usage against this concept for the resolution's execution.
  const usageRes = await fetch(
    `${CONCEPT_DB_ENDPOINT}/concepts/${encodeURIComponent(conceptId)}/usage`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        trace_id: data.execution_id,
        outcome: data.success === false ? "failure" : "success",
        // Optional fields; concept-db ignores unknown keys.
        latency_ms: resolution.latency_ms,
        resolver_id: resolution.resolver_id,
        vessel_id: resolution.vessel_id,
        source: "vessel_daemon_resolve",
      }),
    },
  );
  if (!usageRes.ok) {
    throw new Error(
      `usage failed: ${usageRes.status} ${await usageRes.text().catch(() => "")}`,
    );
  }
}
