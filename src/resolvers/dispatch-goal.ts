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

/**
 * MAX_GOAL_LEN — canonical safety boundary for accepted goal payload length.
 *
 * GUARD_RATIONALE (three-part safety boundary — single source of truth):
 *
 *   (1) LLM token budget protection: the raw `goal` string flows into
 *       downstream LLM prompts in goal-host-vessel. Capping its length
 *       prevents token overflow in those prompts, which would otherwise
 *       cause truncation, request failure, or cost overruns.
 *
 *   (2) Instruction coherence preservation: bounding payload size keeps
 *       the operator's directive focused and prevents dilution of the
 *       primary intent by unbounded trailing text (very long goals
 *       dilute routing signal and instruction salience).
 *
 *   (3) DoS / latency protection: rejects abusive, hostile, or accidental
 *       oversized payloads early, before they consume network,
 *       serialization, or downstream vessel resources.
 *
 * Threshold: 8192 characters. At a conservative ~4 chars/token this maps
 * to ~2k tokens — comfortably inside typical context budgets while still
 * large enough to admit rich multi-paragraph goals.
 *
 * Enforcement site: checked at the top of `resolveDispatchGoal` (after
 * trim / empty-check, BEFORE any network dispatch), so oversize goals
 * never leave this process.
 *
 * Failure mode: exceeding the ceiling short-circuits with a
 * `structuredError` of shape
 * `{ resolver: "dispatch_goal", detail: "goal too long (<len> > <max>)" }`.
 *
 * Coordination: this is a coordinated safety boundary with
 * goal-host-vessel, which enforces its own independent ceiling. Do not
 * change unilaterally.
 *
 * This block is the canonical, discoverable rationale for the guard;
 * the runtime enforcement check in {@link resolveDispatchGoal} references
 * it via @see.
 *
 * @constant
 */
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
  /*
   * MAX_GOAL_LEN enforcement — three-part safety boundary:
   *   (1) Token budget: caps input so the goal + system prompt + context fits within
   *       the downstream LLM's context window, preventing prompt overflow errors.
   *   (2) Coherence boundary: keeps instructions concise so their salience is not
   *       diluted by long, meandering input that degrades prompt adherence.
   *   (3) DoS / latency protection: a bounded input caps per-request CPU, memory,
   *       and downstream storage growth, limiting abuse surface and tail latency.
   * See the GUARD_RATIONALE block above the MAX_GOAL_LEN constant definition.
   */
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
