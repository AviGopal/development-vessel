/**
 * dispatch_goal — first-class goal dispatch as an activity (2026-06-18).
 *
 * Until now the substrate dispatched goals only via ad-hoc fetch() calls baked
 * into specific seeds (mechanism-health-tick, recover-from-goal-failure). This
 * resolver makes goal dispatch a REUSABLE capability any activity can invoke, so
 * the loop can orchestrate activity executions and advance toward complex goals by
 * traversing the activity graph DYNAMICALLY — an activity, mid-execution, can spawn
 * a sub-goal to produce a needed shape or decompose a hard goal.
 *
 * parent_execution_id + composition_chain thread through so the dispatched goal is
 * recorded as a CHILD of the dispatching execution — preserving execution-trace
 * continuity (the composition graph the topology metrics read).
 *
 * POSTs to goal-host-vessel /run-goal (202 + dispatchId, async). Fire-and-forget by
 * default; set await_completion to poll to a terminal status.
 */
import type { ResolverResult } from "./types.js";
import { METABOB_API_KEY } from "../config.js";

const MAX_GOAL_LEN = 8192;
const GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";

export interface DispatchGoalPointer {
  type: "dispatch_goal";
  goal: string;
  variables?: Record<string, unknown>;
  target_template_id?: string;
  parent_execution_id?: string;
  composition_chain?: string[];
  /** Poll for a terminal status instead of fire-and-forget (default false). */
  await_completion?: boolean;
  timeout_ms?: number;
}

export async function resolveDispatchGoal(pointer: DispatchGoalPointer): Promise<ResolverResult> {
  const goal = (pointer.goal ?? "").trim();
  if (!goal) return { shape: "structuredError", body: { resolver: "dispatch_goal", detail: "goal is required" } };
  if (goal.length > MAX_GOAL_LEN) return { shape: "structuredError", body: { resolver: "dispatch_goal", detail: `goal too long (${goal.length} > ${MAX_GOAL_LEN})` } };

  const body: Record<string, unknown> = { goal };
  if (pointer.variables) body["variables"] = pointer.variables;
  if (pointer.target_template_id) body["targetTemplateId"] = pointer.target_template_id;
  if (pointer.parent_execution_id) body["parent_execution_id"] = pointer.parent_execution_id;
  if (Array.isArray(pointer.composition_chain)) body["composition_chain"] = pointer.composition_chain;

  const auth: Record<string, string> = METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {};
  try {
    const res = await fetch(`${GOAL_HOST_ENDPOINT}/run-goal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(pointer.timeout_ms ?? 30_000),
    });
    if (!res.ok) return { shape: "structuredError", body: { resolver: "dispatch_goal", detail: `run-goal HTTP ${res.status}`, goal } };
    const j = (await res.json()) as { dispatchId?: string; executionId?: string; status?: string; selectedTemplateId?: string };
    const dispatchId = j.dispatchId ?? j.executionId ?? null;

    if (pointer.await_completion && dispatchId) {
      const deadline = Date.now() + (pointer.timeout_ms ?? 120_000);
      let status = j.status ?? "running";
      while (Date.now() < deadline && (status === "running" || status === "pending" || !status)) {
        await new Promise((r) => setTimeout(r, 3_000));
        try {
          const pr = await fetch(`${GOAL_HOST_ENDPOINT}/executions/${dispatchId}`, { headers: { ...auth }, signal: AbortSignal.timeout(5_000) });
          if (pr.ok) { const pj = (await pr.json()) as { status?: string }; status = pj.status ?? status; }
        } catch { /* keep polling until deadline */ }
      }
      return { shape: "goalDispatchResult", body: { dispatched: true, dispatch_id: dispatchId, status, goal, selected_template_id: j.selectedTemplateId ?? null, awaited: true } };
    }
    return { shape: "goalDispatchResult", body: { dispatched: true, dispatch_id: dispatchId, status: j.status ?? "accepted", goal, selected_template_id: j.selectedTemplateId ?? null, awaited: false } };
  } catch (e) {
    return { shape: "structuredError", body: { resolver: "dispatch_goal", detail: (e as Error).message, goal } };
  }
}
