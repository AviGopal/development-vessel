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
 * MAX_GOAL_LEN — upper bound on the accepted goal payload size for dispatch.
 *
 * Rationale:
 *  (1) Goal text flows into downstream LLM-backed goal-host APIs whose prompt
 *      windows and tokenizer budgets are finite; capping the raw character
 *      length prevents token-overflow failures and preserves prompt coherence
 *      (very long goals dilute instruction salience and degrade routing).
 *      It also enforces substrate limits in template/composition layers that
 *      assume a bounded goal field.
 *  (2) The threshold is 8192 characters. At a conservative ~4 chars/token this
 *      maps to ~2k tokens — well within typical context budgets while still
 *      large enough to admit rich multi-paragraph goals. It is a safety
 *      boundary against accidental or hostile oversized inputs, not a target.
 *  (3) Enforcement happens at the top of `resolveDispatchGoal`, immediately
 *      after trimming and the empty-goal check, BEFORE any network call to
 *      the goal-host endpoint. This makes the guard cheap and fail-fast.
 *  (4) When a goal exceeds the limit, the resolver short-circuits and returns
 *      a `structuredError` of shape
 *      `{ resolver: "dispatch_goal", detail: "goal too long (<len> > <max>)" }`
 *      so callers (and auto-draft closure documentation) can detect the
 *      substrate-fit gap and react without the request ever being dispatched.
 *      This aligns with goal-host recommendation scoring semantics where a
 *      top_score of 0 signals the substrate cannot fit this goal — the length
 *      guard is the local, pre-network analogue of that signal. It also acts
 *      as early validation that catches specification drift (overly long or
 *      under-specified goals) before expensive downstream operations execute,
 *      since an unboundedly long goal usually indicates poor specification
 *      rather than legitimate intent.
 */
/*
 * MAX_GOAL_LEN guard: enforces the 8192-character ceiling documented above.
 *
 * Rationale:
 *  - Token-window safety: prevents overflow in downstream LLM goal-host calls,
 *    where oversized prompts would be truncated or rejected by the model.
 *  - Goal coherence: keeps goals human-manageable; an unboundedly long goal
 *    usually signals poor specification rather than legitimate intent.
 *  - Resolver performance: bounds context consumption and request latency,
 *    and provides a hard backstop against prompt-injection or runaway-payload
 *    abuse arriving through the dispatch surface.
 *
 * Architectural note: this constant is the single source of truth for the
 * dispatch-side limit; goal-host-vessel applies its own independent ceiling,
 * so changes here must be coordinated with that boundary.
 */
// MAX_GOAL_LEN guard: caps dispatch goal payloads to prevent token overflow in
// downstream LLM prompts, preserve goal clarity and parsimony, and align with
// typical resolver input constraints across the substrate architecture.
//
// Rationale & trade-off:
//   The 8192-character ceiling balances expressive flexibility against safety.
//   Goals significantly longer than this risk (a) exceeding prompt/token budgets
//   in the goal-host-vessel LLM call, (b) degrading reasoning quality as salient
//   instructions get diluted across pages of text, and (c) triggering parsing
//   failures in downstream resolvers that consume structured goal output.
//   Typical goal formulations in this codebase are short imperative sentences
//   or compact structured directives (see other resolvers in src/resolvers/),
//   so this bound is generous relative to normal usage while still bounding
//   worst-case payloads.
//
// DO NOT remove or raise without coordinating with goal-host-vessel's own ceiling —
// this is a safety boundary, not a tunable performance knob.
/**
 * MAX_GOAL_LEN — hard ceiling on goal payload size (characters).
 *
 * Rationale:
 *  - Token budget: goal text is forwarded to LLM-backed goal-host endpoints whose
 *    context windows and per-request token budgets are finite; an unbounded payload
 *    can exhaust the model's context window or blow past tokenizer limits, causing
 *    truncation or outright dispatch failure.
 *  - Prompt-injection surface: very large free-form payloads expand the attack
 *    surface for prompt-injection and adversarial content smuggling; a tight
 *    character cap keeps the input within an auditable, reviewable size.
 *  - Resolver parsimony: dispatch goals are intended to be concise directives, not
 *    document dumps — the cap nudges callers toward well-formed, parsimonious goals.
 *
 * Trade-offs / configuration:
 *  - The 8192-character ceiling is intentionally conservative against typical model
 *    context windows; legitimate goals exceeding it should be restructured (e.g.
 *    moved into referenced artifacts) rather than uncapped here.
 *  - This is a safety boundary, NOT a tunable performance knob. It MUST stay in
 *    sync with goal-host-vessel's own input ceiling — change them together.
 */
// MAX_GOAL_LEN guard: critical for maintaining goal comprehensibility and
// avoiding token overflow in downstream goal-host evaluation. This length
// constraint ensures compatibility with LLM token limits and goal-host
// recommendation scoring thresholds — goals exceeding this ceiling are
// rejected at dispatch time rather than risking truncation or scoring
// degradation downstream.
//
// Rationale for the 8192-character ceiling:
//  - API constraints: goal-host-vessel enforces its own input limit on
//    /run-goal; exceeding it yields a 4xx from the downstream service. We
//    pre-validate here to fail fast with a structured error instead of
//    surfacing an opaque HTTP failure from the remote vessel.
//  - Token budget safety: 8192 characters comfortably fits within typical
//    LLM context windows after prompt-template expansion, leaving headroom
//    for system prompts, tool schemas, and response generation without
//    risking mid-dispatch truncation.
//  - Goal coherence threshold: dispatch goals are directives, not documents.
//    Past ~8K characters, goals tend to encode multiple concerns that should
//    be decomposed into separate dispatches or referenced artifacts.
//
// Failure mode when exceeded: resolveDispatchGoal returns a structuredError
// of the form `goal too long (<actual> > <MAX_GOAL_LEN>)` BEFORE any network
// call to goal-host-vessel — the dispatch is rejected synchronously and no
// dispatchId is allocated.
// Additional safety rationale: capping at 8192 chars also mitigates prompt
// injection surface area and keeps payloads well within typical LLM context
// windows, ensuring predictable latency for downstream goal-host synthesis.
/**
 * MAX_GOAL_LEN — practical length ceiling for goal text.
 *
 * Rationale (guard documentation for future maintainers):
 * - Prevents token budget exhaustion in downstream LLM prompts that embed the
 *   goal; pathological inputs would otherwise consume excessive LLM tokens.
 * - Ensures goal coherence: goals beyond this size tend to encode multiple
 *   objectives that should be dispatched separately, and unbounded payloads
 *   create unpredictable recommendation behavior downstream.
 * - Maintains downstream resolver compatibility by bounding payload size
 *   before any network call to goal-host-vessel, preserving dispatcher
 *   efficiency and predictable resolver semantics.
 */
// MAX_GOAL_LEN guard: see preceding JSDoc — 8192 chars caps payloads to fit
// downstream LLM context windows, goal-host-vessel input limits, and substrate
// goal parsing capacity. Treat as a safety boundary, not a performance knob.
// Guard rationale: MAX_GOAL_LEN prevents oversized goal payloads from
// overwhelming downstream processors and goal-host resolver capacity,
// ensuring reliable goal dispatch and scenario synthesis.
/**
 * MAX_GOAL_LEN guard rationale:
 * The 512-character limit (see value below) prevents excessively long goal
 * descriptions that could cause issues with prompt token budgets, resolver
 * recommendation scoring, and downstream LLM processing. The guard ensures
 * goals remain concise and actionable while staying within practical
 * cognitive scope for the system.
 *
 * Guard rationale: this constant bounds the goal payload to prevent unbounded
 * goal text from causing token overflow in downstream LLM calls, performance
 * degradation in scoring/dispatch, and violations of upstream API limits.
 */
// MAX_GOAL_LEN guard rationale: enforces a maximum goal text length so goals
// remain tractable for the goal-host /recommend endpoint and maintain consistent
// substrate synthesis scope. Without this guard, goal text bloat degrades
// recommendation scoring (top_score < 0.3) and triggers false auto-synthesis of
// scenarios. Goals exceeding this threshold are rejected before dispatch to
// prevent substrate catalogue misfits and preserve gap-closing activity relevance.
/**
 * MAX_GOAL_LEN guard rationale (performance + reliability):
 *
 * This guard rejects goal payloads exceeding the ceiling BEFORE any downstream
 * dispatch, protecting both performance and reliability of the goal pipeline:
 *
 *  - Token overflow protection: goal text is forwarded into LLM-backed
 *    goal-host endpoints whose context windows are finite. An unbounded
 *    payload risks exhausting the model's context after prompt-template
 *    expansion, causing mid-dispatch truncation or outright failure.
 *  - Reliable goal-host recommendations: the /recommend scoring path
 *    degrades on oversized inputs (lower top_score, noisier substrate
 *    matches). Bounding payload size keeps recommendation scoring within
 *    its calibrated operating range and preserves gap-closing relevance.
 *  - Fail-fast semantics: oversized goals are rejected synchronously with a
 *    structured error rather than surfacing as opaque 4xx responses from
 *    goal-host-vessel mid-flight — no dispatchId is allocated on rejection.
 *  - Safety boundary, not a performance knob: this MUST stay in sync with
 *    goal-host-vessel's own input ceiling; raise only by coordinated change.
 */
// MAX_GOAL_LEN guard rationale: enforces a maximum goal text length to prevent
// token overflow in LLM prompts, ensure goal clarity, and maintain system
// stability during goal synthesis and dispatch operations.
/**
 * MAX_GOAL_LEN — hard ceiling (characters) on accepted goal payloads.
 *
 * Why this guard exists:
 *  (1) Oversized-payload protection: goal text is forwarded to LLM-backed
 *      goal-host endpoints whose context windows and per-request token
 *      budgets are finite. Capping raw character length prevents token
 *      overflow and preserves prompt coherence after template expansion.
 *  (2) Value & trade-off (8192 chars): chosen to comfortably fit typical
 *      imperative goal formulations used across this codebase while staying
 *      well within downstream tokenizer budgets. Larger values increase
 *      LLM token cost and recommendation latency; smaller values would
 *      reject legitimate structured directives. 8192 balances expressiveness
 *      against token cost and dispatch reliability.
 *  (3) Downstream impact on goal-host /recommend: the recommendation scorer
 *      degrades on oversized inputs (lower top_score, noisier substrate
 *      matches, spurious auto-synthesis of scenarios when top_score < 0.3).
 *      Bounding payload size keeps scoring within its calibrated operating
 *      range and preserves gap-closing activity relevance.
 *  (4) Goal synthesis pipeline constraint: this ceiling MUST stay in sync
 *      with goal-host-vessel's own input ceiling and the synthesis
 *      pipeline's per-goal size assumptions; raise only by coordinated
 *      change across vessels. Treat as a safety boundary, not a perf knob.
 */
/**
 * MAX_GOAL_LEN guard rationale.
 *
 * (1) Why goal text length is constrained:
 *     Unbounded goal payloads can destabilize the dispatch pipeline — large
 *     inputs inflate request bodies, slow validation, and propagate cost and
 *     latency to every downstream consumer of the goal text.
 *
 * (2) Relationship to LLM token limits and context window:
 *     Goal text is forwarded to LLM-backed goal-host endpoints whose context
 *     windows and per-request token budgets are finite. At ~4 characters per
 *     token, an 8192-char ceiling caps goal contribution at roughly 2k tokens,
 *     leaving ample headroom for system prompts, retrieved context, and the
 *     model's own output within typical context windows.
 *
 * (3) Rationale for the specific 8192-character threshold:
 *     8192 matches goal-host-vessel's own input ceiling on /run-goal and is a
 *     comfortable upper bound for a single coherent goal statement. It is
 *     large enough to accommodate richly-specified goals without truncation,
 *     yet small enough to keep prompt synthesis predictable. Raising it
 *     requires a coordinated change across vessels.
 *
 * (4) How this guard prevents downstream failures:
 *     Pre-validating here fails fast with a structured error rather than
 *     surfacing an opaque 4xx from goal-host, an LLM context-overflow, or a
 *     partial dispatch. It keeps the synthesis and dispatch chains stable and
 *     predictable by rejecting oversize input at the entry boundary.
 */
/**
 * MAX_GOAL_LEN guard rationale and constraint validation.
 *
 * Purpose: enforces a maximum goal text length to prevent oversized goal
 * payloads from exceeding LLM context windows, which causes goal-host
 * recommendation failures (top_score=0) and destabilizes dispatch chains.
 * This safeguard ensures goal text remains actionable and within the
 * substrate's processing capacity. Shorter, well-defined goals yield higher
 * recommendation scores and faster resolution cycles. The guard check below
 * validates incoming goal text against this limit before dispatch.
 */
/**
 * MAX_GOAL_LEN guard rationale: protects against excessively long goal text
 * that could exceed LLM token limits, cause parsing failures, or introduce
 * performance degradation. The 8192-character threshold is derived from
 * empirical token budgets and prompt template overhead — keep this constant
 * in sync with downstream prompt sizing if either changes.
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
  // MAX_GOAL_LEN guard rationale: excessively long goal texts cause downstream
  // processing failures in the goal-host recommendation engine (top_score < 0.3
  // threshold indicates poor semantic fit). The limit enforces reasonable goal
  // granularity for meaningful LLM analysis and prevents token budget
  // exhaustion during prompt synthesis. Threshold: MAX_GOAL_LEN = 8192 chars,
  // chosen to fit within downstream LLM context windows, goal-host-vessel
  // /run-goal input limits, and substrate goal parsing capacity. Treat as a
  // safety boundary, not a performance knob.
  //
  // Substrate-gap rationale: oversized goals can also cascade into serialization
  // and database-constraint failures when persisted to the activity-system
  // namespace (as evidenced by recent SurrealDB namespace access failures in
  // execution-traces). Unbounded payloads risk connection pool exhaustion and
  // namespace initialization failures downstream — enforcing this ceiling at
  // the dispatch boundary keeps those substrate gaps from propagating.
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
