// llm-router.ts — per-task-type LLM routing over the discovery-advertised
// llm_completion producers, learned via activity-api's llm_router_decisions cell.
//
// WHY: goal-host makes several distinct kinds of internal LLM reasoning call
// (goal_target_inference, reach_verification, action_shape_selection, …). Each
// historically hardcoded a single model. This router instead treats every
// llm-resolver VESSEL as a learnable arm (vessel_id == pinned model) and picks,
// PER TASK TYPE, via Thompson sampling of the arm's Beta(α,β). The arm is
// rewarded by the dispatch's final `reached` verdict (α on reach, β on hollow).
//
// SELECTION: discover llm_completion producers → for each, sample Beta(α,β)
// (missing arm ⇒ uniform Beta(1,1) prior ⇒ explored on equal footing) → route to
// the argmax vessel with NO model override, so the vessel's own pinned default
// applies. That is what makes vessel_id the thing we learn over.
//
// FAIL-OPEN: if discovery has no producer, or activity-api is unreachable, or
// LLM_ROUTER_DISABLED=1, we fall back to the single LLM_VESSEL_ENDPOINT and honor
// the caller's hardcoded model — reproducing exactly the pre-router behavior.
//
// REWARD ATTRIBUTION: routed selections are buffered per dispatch (keyed by the
// caller's dispatchId, in practice goalHashOf(goal)). flushRouterFeedback(id,
// reached) is called once at the dispatch's terminal point (runGoalWithRecovery
// return) and posts one Beta update per buffered selection, then clears the
// buffer. Concurrent dispatches of the *same* goal string share a buffer — a
// small, self-correcting source of reward noise, not a correctness bug.

// The llm_router_decisions cell is LOCAL substrate state (which local llm vessel
// to pick), distinct from the trace/template learning surface — which under the
// federation drop-in may point at a remote hub (ACTIVITY_API_ENDPOINT). So the
// router's learning endpoint resolves to the LOCAL activity-api, not the hub:
// PRODUCER_DISCOVERY_ENDPOINT is already the local one; override with
// LLM_ROUTER_API_ENDPOINT if needed.
const ACTIVITY_API_ENDPOINT =
  process.env.LLM_ROUTER_API_ENDPOINT ??
  process.env.PRODUCER_DISCOVERY_ENDPOINT ??
  "http://127.0.0.1:8080";
const DISCOVERY_ENDPOINT = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
const API_KEY = process.env.GOAL_HOST_VESSEL_API_KEY ?? process.env.METABOB_API_KEY ?? "";
const LLM_FALLBACK_ENDPOINT = process.env.LLM_VESSEL_ENDPOINT;
const ROUTER_DISABLED = process.env.LLM_ROUTER_DISABLED === "1";

const authHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
});

// THE CALLER'S CREDENTIAL RIDES THE LOCAL TRANSPORT HOP AS A HEADER, NEVER IN THE POINTER.
//
// The federation ingress admits a caller only by its own credential (federationShapePolicy:
// llm_completion and activeDispatches are trust_group), and the transport never lends the
// node's key. The local transport takes the caller's Authorization header and moves it into
// the wire copy itself, stripped again at the far ingress before any log or trace. So the
// caller hands its key to the transport as a header on that one hop, and the body it
// builds — which is what goal-host traces — never holds it. Any other URL gets no header
// from here: a discovered endpoint is not a place to send this node's key.
const originOf = (u: string): string => {
  try { return new URL(u).origin; } catch { return ""; }
};
/** Headers for a fetch to `url`: Authorization only when `url` is the local federation transport. */
export function transportHopHeaders(
  url: string,
  egress: string = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401",
  apiKey: string = API_KEY,
): Record<string, string> {
  const hop = originOf(url) !== "" && originOf(url) === originOf(egress);
  return { "Content-Type": "application/json", ...(hop && apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) };
}

interface Producer { vesselId: string; endpoint: string; resolveUrl: string; }
interface Arm { alpha: number; beta: number; }

// ── discovery of llm_completion producers (short TTL cache) ──────────────────
// llm_completion producers are resolved through discovery per call (30s TTL) and the forward target is built live from the fresh discovery row's libp2p_multiaddr, so a hub restart never requires a spoke edit.
let producerCache: { at: number; producers: Producer[] } | null = null;
const PRODUCER_TTL_MS = 30_000;

async function discoverProducers(): Promise<Producer[]> {
  const now = Date.now();
  if (producerCache && now - producerCache.at < PRODUCER_TTL_MS) return producerCache.producers;
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT.replace(/\/$/, "")}/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return producerCache?.producers ?? [];
    const j: any = await r.json();
    const vessels: any[] = j?.content?.vessels ?? j?.vessels ?? [];
    const fedEgress = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401"; // Egress target is the fresh discovery libp2p_multiaddr[0] resolved per call
    const preferLibp2p = process.env["PREFER_LIBP2P_ROUTE"] === "1";
    const producers: Producer[] = vessels
      .map((v) => {
        const endpoint = String(v?.endpoint ?? "");
        const vid = String(v?.vesselId ?? v?.vessel_id ?? v?.id ?? "");
        const isLibp2p =
          (v.protocol === "libp2p" || preferLibp2p) &&
          Array.isArray(v.libp2p_multiaddr) &&
          typeof v.libp2p_multiaddr[0] === "string" &&
          (v.libp2p_multiaddr[0] as string).length > 0;
        if (isLibp2p) {
          const multiaddr = v.libp2p_multiaddr[0] as string;
          return {
            vesselId: vid,
            endpoint,
            resolveUrl:
              fedEgress +
              "/egress/resolve?target=" +
              encodeURIComponent(multiaddr) +
              "&vessel=" +
              encodeURIComponent(vid),
            _libp2p: true as const,
          };
        }
        return {
          vesselId: vid,
          endpoint,
          resolveUrl:
            typeof v.resolve_endpoint === "string" && v.resolve_endpoint.startsWith("http")
              ? v.resolve_endpoint
              : typeof v.resolve_endpoint === "string" && v.resolve_endpoint.length > 0
                ? endpoint.replace(/\/+$/, "") + "/" + v.resolve_endpoint.replace(/^\//, "")
                : endpoint + "/resolve",
          _libp2p: false as const,
        };
      })
      .filter((p) =>
        p.vesselId.length > 0 &&
        (p._libp2p
          ? true
          : /^https?:\/\//.test(p.endpoint))
      )
      .map((p): Producer => ({ vesselId: p.vesselId, endpoint: p.endpoint, resolveUrl: p.resolveUrl }));
    producerCache = { at: now, producers };
    return producers;
  } catch {
    return producerCache?.producers ?? [];
  }
}

// ── per-arm Beta stats for a task type ───────────────────────────────────────
async function fetchArms(taskType: string): Promise<Map<string, Arm>> {
  const arms = new Map<string, Arm>();
  try {
    const r = await fetch(
      `${ACTIVITY_API_ENDPOINT.replace(/\/$/, "")}/v2/llm-router/candidates?task_type=${encodeURIComponent(taskType)}`,
      { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return arms;
    const j: any = await r.json();
    for (const c of (j?.candidates ?? []) as any[]) {
      if (typeof c?.vessel_id === "string") {
        arms.set(c.vessel_id, {
          alpha: typeof c.alpha === "number" && c.alpha >= 1 ? c.alpha : 1,
          beta: typeof c.beta === "number" && c.beta >= 1 ? c.beta : 1,
        });
      }
    }
  } catch { /* fail soft ⇒ all arms read as the uniform prior */ }
  return arms;
}

// ── Beta sampler (Marsaglia–Tsang gamma; valid for shape ≥ 1, always true here
//    since α,β start at 1 and only increment) ────────────────────────────────
function sampleNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sampleGamma(shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, vv: number;
    do { x = sampleNormal(); vv = 1 + c * x; } while (vv <= 0);
    vv = vv * vv * vv;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * vv;
    if (Math.log(u) < 0.5 * x * x + d * (1 - vv + Math.log(vv))) return d * vv;
  }
}
function sampleBeta(alpha: number, beta: number): number {
  const ga = sampleGamma(Math.max(1, alpha));
  const gb = sampleGamma(Math.max(1, beta));
  return ga / (ga + gb);
}

// ── selection ────────────────────────────────────────────────────────────────
interface Selection { resolveUrl: string; vesselId: string | null; }

function fallbackSelection(): Selection | null {
  if (!LLM_FALLBACK_ENDPOINT) return null;
  return { resolveUrl: `${LLM_FALLBACK_ENDPOINT.replace(/\/$/, "")}/resolve`, vesselId: null };
}

// ── per-dispatch reward buffer ───────────────────────────────────────────────
interface BufferedSelection { taskType: string; vesselId: string; latencyMs: number; costUsd: number; }
const buffers = new Map<string, BufferedSelection[]>();
const MAX_BUFFERS = 512; // backstop against a dispatch that never flushes

/**
 * A routing key with this prefix is a SHADOW call: made only to MEASURE (e.g. the LLM reach judge
 * consulted alongside a deterministic oracle that already decided). It is graded by nothing the
 * dispatch produces, so it must never enter the per-dispatch reward buffer — otherwise the
 * dispatch's final verdict would reward or penalise an arm for a call whose output was discarded.
 */
export const SHADOW_ROUTE_PREFIX = "shadow:";

/** Reward-buffer entries under one routing key, or across all keys (observability + tests). */
export function rewardBufferEntries(key?: string): number {
  if (key !== undefined) return buffers.get(key)?.length ?? 0;
  let n = 0;
  for (const b of buffers.values()) n += b.length;
  return n;
}

function buffer(dispatchId: string, sel: BufferedSelection): void {
  if (!dispatchId) return;
  if (dispatchId.startsWith(SHADOW_ROUTE_PREFIX)) return; // shadow calls are measurement, never reward
  if (!buffers.has(dispatchId)) {
    if (buffers.size >= MAX_BUFFERS) {
      const oldest = buffers.keys().next().value;
      if (oldest !== undefined) buffers.delete(oldest);
    }
    buffers.set(dispatchId, []);
  }
  buffers.get(dispatchId)!.push(sel);
}

// ── the routed call — a drop-in for the old fetch(LLM_VESSEL_ENDPOINT/resolve) ─
export interface RoutedResult { ok: boolean; json: any; vesselId: string | null; }

// Per-dispatch provider-usage accumulator (key: goalHashOf(goal), same as buffers).
// goal-host reasoning calls route through this module but historically dropped
// usage, so every synthetic walk/satisfier/floor trace recorded tokens_in/out=0.
//
// SPEND ACCOUNTING (value-per-cost-selection 1.3): the goal hash is shared by
// concurrent dispatches of the same goal string, so usage is ALSO keyed by the
// DISPATCH ID read from the caller's async context (goal-host registers its
// dispatchContext reader via setRouterDispatchIdReader). Every completion counts
// one call; cost is the provider-reported usage.cost_usd when present, else 0.
interface RouterUsage { tokensIn: number; tokensOut: number; calls: number; costUsd: number; }
const zeroUsage = (): RouterUsage => ({ tokensIn: 0, tokensOut: 0, calls: 0, costUsd: 0 });
const usageByDispatch = new Map<string, RouterUsage>();
const usageByDispatchId = new Map<string, RouterUsage>();
// How much of a dispatch's usage has already been attributed to a persisted trace.
const attributedByDispatchId = new Map<string, RouterUsage>();
let readDispatchId: () => string | undefined = () => undefined;
export function setRouterDispatchIdReader(reader: () => string | undefined): void {
  readDispatchId = reader;
}
// SPEND ATTRIBUTION (value-per-cost-selection 1.5): llm-resolver keys its spend summary by
// model|provider|task_type|caller, so every routed completion names its caller and dispatch.
function attributionFields(taskType: string): Record<string, string> {
  let did: string | undefined;
  try { did = readDispatchId(); } catch { did = undefined; }
  return { caller: `goal-host:${taskType}`, ...(did ? { dispatch_id: did } : {}) };
}

function boundedSet(map: Map<string, RouterUsage>, key: string, value: RouterUsage): void {
  if (!map.has(key) && map.size >= MAX_BUFFERS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
function addUsage(map: Map<string, RouterUsage>, key: string, tin: number, tout: number, cost: number): void {
  const cur = map.get(key) ?? zeroUsage();
  cur.tokensIn += tin; cur.tokensOut += tout; cur.calls += 1; cur.costUsd += cost;
  boundedSet(map, key, cur);
}
/** Record one completion's usage; returns that call's cost in USD (0 when unreported). */
function accumulateUsage(dispatchId: string, inner: any): number {
  const u = inner && typeof inner === "object" ? (inner.usage ?? inner?.body?.usage) : undefined;
  const tin = typeof u?.input_tokens === "number" ? u.input_tokens : 0;
  const tout = typeof u?.output_tokens === "number" ? u.output_tokens : 0;
  const cost = typeof u?.cost_usd === "number" && Number.isFinite(u.cost_usd) && u.cost_usd > 0 ? u.cost_usd : 0;
  if (dispatchId) addUsage(usageByDispatch, dispatchId, tin, tout, cost);
  let did: string | undefined;
  try { did = readDispatchId(); } catch { did = undefined; }
  if (did) addUsage(usageByDispatchId, did, tin, tout, cost);
  return cost;
}
export function peekRouterUsage(dispatchId: string): RouterUsage {
  return usageByDispatch.get(dispatchId) ?? zeroUsage();
}
/** Total LLM usage recorded under a dispatch id (tokens, calls, cost). */
export function peekDispatchUsage(dispatchId: string | undefined): RouterUsage {
  const cur = dispatchId ? usageByDispatchId.get(dispatchId) : undefined;
  return cur ? { ...cur } : zeroUsage();
}
/** Usage under a dispatch id not yet attributed to a persisted trace; marks it attributed,
 *  so the traces a dispatch persists sum to its total instead of each repeating it. */
export function takeDispatchUsageDelta(dispatchId: string | undefined): RouterUsage {
  if (!dispatchId) return zeroUsage();
  const total = peekDispatchUsage(dispatchId);
  const prev = attributedByDispatchId.get(dispatchId) ?? zeroUsage();
  boundedSet(attributedByDispatchId, dispatchId, { ...total });
  return {
    tokensIn: total.tokensIn - prev.tokensIn,
    tokensOut: total.tokensOut - prev.tokensOut,
    calls: total.calls - prev.calls,
    costUsd: total.costUsd - prev.costUsd,
  };
}

async function postFeedback(vesselId: string | null, taskType: string, reached: boolean, costUsd = 0): Promise<void> {
  if (vesselId == null) return;
  try {
    await fetch(`${ACTIVITY_API_ENDPOINT.replace(/\/$/, "")}/v2/llm-router/feedback`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ task_type: taskType, vessel_id: vesselId, reached, latency_ms: 0, cost_usd: costUsd }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* fire-and-forget */ }
}

async function routeOverRanked(
  ranked: Array<{ resolveUrl: string; vesselId: string | null }>,
  dispatchId: string,
  taskType: string,
  body: { prompt: string; maxTokens?: number; system?: string; model?: string },
): Promise<RoutedResult> {
  const payload: Record<string, unknown> = { type: "llm_completion", prompt: body.prompt, task_type: taskType, ...attributionFields(taskType) };
  if (body.maxTokens) payload.max_tokens = body.maxTokens;
  if (body.system) payload.system = body.system;
  for (const sel of ranked.slice(0, 2)) {
    if (sel.vesselId === null && body.model) payload.model = body.model;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let r: Response;
      try {
        r = await fetch(sel.resolveUrl, {
          method: "POST",
          headers: transportHopHeaders(sel.resolveUrl),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        await postFeedback(sel.vesselId, taskType, false);
        continue;
      }
      const j = await r.json();
      const inner = (j && typeof j === "object" && (j as any).content && typeof (j as any).content === "object" && (((j as any).content as any).body !== undefined || ((j as any).content as any).shape !== undefined)) ? (j as any).content : j;
      const text: unknown = (inner as any)?.body?.content ?? (inner as any)?.content ?? (inner as any)?.body?.text ?? (inner as any)?.value ?? "";
      if (typeof text !== "string" || text === "") {
        await postFeedback(sel.vesselId, taskType, false);
        continue;
      }
      // The call's real cost rides the immediate per-call post; the buffered end-of-dispatch
      // reward keeps costUsd 0 because activity-api SUMS cost_usd per arm, and charging the
      // same call on both posts would double it.
      const callCostUsd = accumulateUsage(dispatchId, inner);
      await postFeedback(sel.vesselId, taskType, true, callCostUsd);
      if (sel.vesselId) buffer(dispatchId, { taskType, vesselId: sel.vesselId, latencyMs: 0, costUsd: 0 });
      return { ok: true, json: { ...(inner as any), body: { ...(((inner as any)?.body) ?? {}), content: text } }, vesselId: sel.vesselId };
    } catch {
      await postFeedback(sel.vesselId, taskType, false);
      continue;
    }
  }
  return { ok: false, json: null, vesselId: null };
}

/**
 * Route one llm_completion for a task type. `body.model` is applied ONLY on the
 * fallback path (single-endpoint, vessel_id null) to preserve pre-router
 * behavior; when a real producer is selected, NO model override is sent so the
 * vessel's pinned default (the learned arm) applies. The selection is buffered
 * under dispatchId for end-of-dispatch reward.
 */
// Location-independence (law 11): llm_completion may resolve on a LOCAL arm OR via a federated
// hub arm over the relay — the caller must not care which. A transient producer-set gap (local
// arms de-advertising on a quota cooldown) or a relay round-trip hiccup should not fail the call.
// Retry the whole resolve (discover -> route -> cascade) a couple times with a short backoff so
// hub-served resolution is as seamless as local. Only retries on a failed result, so it adds
// latency solely on the already-failing path.
export async function routedComplete(
  dispatchId: string,
  taskType: string,
  body: { prompt: string; maxTokens?: number; system?: string; model?: string },
): Promise<RoutedResult> {
  let last: RoutedResult = { ok: false, json: null, vesselId: null };
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = Date.now();
    last = await routedCompleteOnce(dispatchId, taskType, body);
    if (last.ok) return last;
    // Only retry a FAST failure — an empty/transient producer set during a de-advertise cooldown,
    // or a connection refusal — which re-discovering on the next attempt is likely to recover. A
    // SLOW failure means a producer WAS tried and timed out; retrying just triples a slow hub call
    // (latency amplification observed when local arms exhaust and the hub relay is slow). Bail so
    // the caller fails fast instead of hanging on 3x a 60s attempt.
    if (Date.now() - startedAt > 3000) break;
    if (attempt < 2) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  return last;
}

async function routedCompleteOnce(
  dispatchId: string,
  taskType: string,
  body: { prompt: string; maxTokens?: number; system?: string; model?: string },
): Promise<RoutedResult> {
  if (ROUTER_DISABLED) {
    const fb = fallbackSelection();
    if (!fb) return { ok: false, json: null, vesselId: null };
    return routeOverRanked([fb], dispatchId, taskType, body);
  }
  const producers = await discoverProducers();
  if (producers.length === 0) {
    const fb = fallbackSelection();
    if (!fb) return { ok: false, json: null, vesselId: null };
    return routeOverRanked([fb], dispatchId, taskType, body);
  }
  const arms = await fetchArms(taskType);
  const scored = producers.map((p) => {
    const arm = arms.get(p.vesselId);
    return { sel: { resolveUrl: p.resolveUrl, vesselId: p.vesselId }, score: sampleBeta(arm?.alpha ?? 1, arm?.beta ?? 1) };
  });
  scored.sort((a, b) => b.score - a.score);

  // --- Routed path: dispatch to the Thompson-sampled winning vessel ---
  const winner = scored[0]?.sel ?? null;
  if (winner) {
    const selectedEndpoint = winner.resolveUrl;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let r: Response;
      try {
        r = await fetch(selectedEndpoint, {
          method: "POST",
          headers: authHeaders(),
          // No model override — the vessel's own pinned default applies.
          body: JSON.stringify({ type: "llm_completion", prompt: body.prompt, ...(body.maxTokens ? { max_tokens: body.maxTokens } : {}), ...(body.system ? { system: body.system } : {}), ...(body.model ? { model: body.model } : {}), task_type: taskType, ...attributionFields(taskType) }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (r.ok) {
        const j: any = await r.json();
        const inner = (j && typeof j === "object" && (j as any).content && typeof (j as any).content === "object" && ((((j as any).content as any).body !== undefined) || (((j as any).content as any).shape !== undefined))) ? (j as any).content : j;
        const text: unknown = (inner as any)?.body?.content ?? (inner as any)?.content ?? (inner as any)?.body?.text ?? (inner as any)?.value ?? "";
        if (typeof text === "string" && text.length > 0) {
          // Real cost on the immediate post only (see routeOverRanked: the feedback store sums cost).
          const callCostUsd = accumulateUsage(dispatchId, inner);
          await postFeedback(winner.vesselId, taskType, true, callCostUsd);
          buffer(dispatchId, { taskType, vesselId: winner.vesselId, latencyMs: 0, costUsd: 0 });
          return { ok: true, json: { ...(inner as any), body: { ...((inner as any)?.body ?? {}), content: text } }, vesselId: winner.vesselId };
        }
      }
      await postFeedback(winner.vesselId, taskType, false);
    } catch {
      await postFeedback(winner.vesselId, taskType, false);
    }
    // --- Fallback path (routed vessel failed): cascade through the OTHER ranked
    // producers (including federated hub arms reached via egress) BEFORE the single
    // env fallback, instead of jumping straight to a possibly-dead
    // LLM_VESSEL_ENDPOINT. This is what stops the reach verifier / inference from
    // fail-closing when the local Thompson-winner arm is credit-dead but a
    // quota-having in-identity-group arm exists. ---
    const rest = scored.slice(1).map((s) => s.sel);
    const fb = fallbackSelection();
    const cascade = fb ? [...rest, fb] : rest;
    if (cascade.length === 0) return { ok: false, json: null, vesselId: null };
    return routeOverRanked(cascade, dispatchId, taskType, body);
  }

  const ranked = scored.map((s) => s.sel);
  return routeOverRanked(ranked, dispatchId, taskType, body);
}

/** Convenience wrapper returning just the completion text (or null). */
export async function routedText(
  dispatchId: string,
  taskType: string,
  prompt: string,
  opts?: { maxTokens?: number; system?: string; model?: string },
): Promise<string | null> {
  const rr = await routedComplete(dispatchId, taskType, { prompt, ...(opts ?? {}) });
  if (!rr.ok) return null;
  const j = rr.json;
  const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? j?.value ?? "";
  return typeof text === "string" && text.length > 0 ? text : null;
}

/** Envelope-safe unwrap of a RAW llm_completion_dispatch / hub-proxied response.
 *  Handles the federated proxy envelope {content:{shape,value}} identically to the
 *  inline unwrap in routedComplete (llm-router.ts:305-306). Returns "" for any
 *  non-string / empty payload — never fabricates. Use at every raw fetch of an LLM
 *  completion in goal-host so no spoke->hub answer is silently dropped. */
export function unwrapLlmContent(j: any): string {
  const inner = (j && typeof j === "object" && j.content && typeof j.content === "object" && (j.content.body !== undefined || j.content.shape !== undefined)) ? j.content : j;
  const text: unknown = inner?.body?.content ?? inner?.content ?? inner?.body?.text ?? inner?.value ?? "";
  return typeof text === "string" ? text : "";
}

/**
 * Post one Beta update per buffered selection for this dispatch, then clear the
 * buffer. Called once at the dispatch's terminal point with the final reach
 * verdict. Fire-and-forget: learning writes never block or fail the dispatch.
 */
export async function flushRouterFeedback(dispatchId: string, reached: boolean): Promise<void> {
  const buf = buffers.get(dispatchId);
  if (!buf) return;
  buffers.delete(dispatchId);
  usageByDispatch.delete(dispatchId);
  await Promise.allSettled(
    // ORACLE INTEGRITY (L12 effect-as-cause): the reach-verification arm produces
    // the very `reached` verdict this reward is keyed on, so rewarding it would let
    // the grader earn credit from its own output (a self-referential loop). Exclude
    // it — the reach judge is graded only against external signal, never itself.
    buf.filter((s) => s.taskType !== "reach_verification").map((s) =>
      fetch(`${ACTIVITY_API_ENDPOINT.replace(/\/$/, "")}/v2/llm-router/feedback`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          task_type: s.taskType,
          vessel_id: s.vesselId,
          reached,
          latency_ms: s.latencyMs,
          cost_usd: s.costUsd,
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined),
    ),
  );
}
