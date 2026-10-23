/**
 * CAPACITY-AWARE COMPOSE PLACEMENT, THROUGH DISCOVERY (law 11: the gap-store holder is not the only compose host).
 *
 * A dispatcher that sends a compose goal to its own goal-host puts the compose on its own development-vessel (every
 * goal-host routes an edit-intent goal to the feature_compose producer its discovery names first, its own). When this
 * node's slot of the needed class is full, the receiver answers BUSY and the dispatch is a non-attempt, while a peer
 * that could compose the same gap may sit idle. Measured on a two-node fleet: the node running the check supply
 * refused its own supply goals ("[compose-cap] REFUSING autonomous compose: 1 in flight", its one autonomous slot held
 * by back-to-back short composes) while the other node's lane ran nothing for over an hour.
 *
 * NO NEW SHAPE. `composeOwnership` is already each compose producer's self-description, read through discovery by
 * goal-host's edit-intent routing and gap-admission's findComposeOwner. A PLACEMENT QUERY is that same read with
 * {gap_id, targets, armed} on the pointer; the producer then answers, from its own state and its own gates:
 *   capacity        its peekComposeCapacity for the class (the expression its acquireComposeSlot will apply);
 *   scope_excludes  every target its own autonomyScope excludes (an unreadable scope excludes everything, as its
 *                   compose floor would);
 *   gap_row_visible whether its gap store read sees the row open (a node on another store would refuse the supply's
 *                   ledger check: ledger_mismatch).
 *   dispatch        (only when the pointer names a dispatch_id) its own goal-host's record of that dispatch, read as
 *                   gap-check-supply's probeDispatch reads it: how the node that PLACED a goal here reads its outcome
 *                   back (only this node's goal-host holds it).
 * All reads. The plain {type:"composeOwnership"} read is answered exactly as before.
 *
 * THE RULE (placeCompose): a free local slot of the class, or a local capacity that cannot be observed, keeps the
 * dispatch local (today's behaviour), when this node composes the vessel. SEVERAL OWNERS (REALIGNMENT §4, law 11; user
 * ruling "(B) Several owners, lease-serialized"): any node whose composeOwnership lists the vessel may take its goal,
 * and the gap-store holder's landing lease (substrate-gap.ts LANDING LEASE) serialises their landings. So a node that
 * does not compose the vessel (gap-policy ownedVessels: non-empty and without it) keeps nothing local on a free slot:
 * its own compose would refuse the vessel. With none free, or not an owner, every discovered composeOwnership producer
 * other than this node's own is asked; a candidate owns the target vessel, sees the row, excludes no target, and has a
 * free slot of the class. The candidate with the most free slots takes it; none means today's local send, whose BUSY
 * is the same non-attempt as before. A peer that does not answer, or answers malformed, is no candidate (logged where it
 * failed).
 * The capacity read is not a reservation: the peer's own admission (eligibility, the supply ledger, scope, the landing
 * lease, the O_EXCL slot claim) still decides, and its refusal comes back as the same classified outcome.
 *
 * NOT OWN-SUBSTRATE-FILTERED, ON PURPOSE. A same-host peer node's producer reaches discovery as a peer-origin row
 * (composeOwnership is declared node-distinct), which isOwnSubstrateProducer may reject because it guards POLICY READS (a peer must never set this node's scope or spend
 * envelope). Placement reads no policy from a peer: it hands the peer work that the peer admits through its own gates
 * and the shared store's ledger, and row visibility excludes a peer that does not share the store.
 *
 * SAME HOST ONLY (user ruling). Both the placement read and the placed send carry this node's key, so each goes only
 * to an endpoint on this machine (self-auth.ts crossNodeKeyHeaders): a producer elsewhere gets no key and no call, and
 * is no candidate. A libp2p OVERLAY row (a facade `<vessel>@<substrate>` through this node's own federation egress on
 * loopback) is refused too, before its loopback host is even considered: the egress would carry the key to another
 * substrate.
 */
import { lookupShape, describeLookup } from "../config.js";
import { crossNodeKeyHeaders } from "../lib/self-auth.js";
import { peekComposeCapacity } from "../compose-slots.js";
import { autonomyScope, autonomyScopeExcludes, ownedVessels } from "../judge/gap-policy.js";
import type { DispatchGoalPointer } from "./dispatch-goal.js";
import type { DispatchProbe } from "./gap-check-supply.js";
import type { ResolverResult } from "./types.js";

type Row = Record<string, unknown>;
/**
 * NODE-DISTINCT SHAPES (discovery shape_policies "stateful_data_owner_merge"): each node answers composeOwnership from
 * its OWN capacity, scope and store, so every node's producer is a different answer, not an interchangeable replica.
 * Declaring it lets discovery list a same-host peer node's row beside this node's own (same vesselId), which is what
 * placeCompose needs to see a peer. Declared here, beside the resolver that makes the answer per node.
 */
export const NODE_DISTINCT_SHAPES: readonly string[] = ["composeOwnership"];
const READ_TIMEOUT_MS = 5_000;
/** Above dispatch_goal's own goal-host timeout (the supply sends 15 s) plus the overlay hop. */
const PLACED_SEND_TIMEOUT_MS = 20_000;

export interface ComposePlacementAnswer {
  armed: boolean;
  capacity: { free: number; live: number; cap: number } | null;
  scope_readable: boolean;
  scope_excludes: Array<{ target: string; entry: string }>;
  gap_row_visible: boolean | null;
  /** This node's goal-host record of the pointer's dispatch_id (present only when the pointer names one). */
  dispatch?: DispatchProbe;
}

/** THE PRODUCER'S SIDE of a placement query (composeOwnership with gap_id or targets), or null for a plain read. */
export async function composePlacementAnswer(pointer: Row): Promise<ComposePlacementAnswer | null> {
  const rawTargets = pointer["targets"];
  const targets = Array.isArray(rawTargets) ? rawTargets.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : null;
  const gapId = typeof pointer["gap_id"] === "string" && pointer["gap_id"].length > 0 ? pointer["gap_id"] : null;
  const dispatchId = typeof pointer["dispatch_id"] === "string" && pointer["dispatch_id"].length > 0 ? pointer["dispatch_id"] : null;
  if (!targets && !gapId && !dispatchId) return null;
  const armed = pointer["armed"] === true;
  const capacity = await peekComposeCapacity({ directed: false, armed });
  const scope = await autonomyScope();
  const scopeExcludes = (targets ?? []).map((target) => ({ target, entry: autonomyScopeExcludes(scope, target) })).filter((x): x is { target: string; entry: string } => x.entry !== null);
  let visible: boolean | null = null;
  if (gapId) {
    try {
      const { resolveSubstrateGap } = await import("./substrate-gap.js");
      const r = await resolveSubstrateGap({ type: "substrateGap", id: gapId, limit: 1 } as never);
      const rows = ((r?.body ?? {}) as { gaps?: Row[] }).gaps;
      visible = Array.isArray(rows) ? rows.some((g) => String(g["id"]) === gapId && String(g["status"] ?? "open") === "open") : null;
    } catch (err) {
      console.warn(`[compose-placement] gap row ${gapId} unreadable for a placement query: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      visible = null;
    }
  }
  // gap-check-supply imports this module, so its probe is imported at call time.
  const dispatch = dispatchId ? await (await import("./gap-check-supply.js")).probeDispatch(dispatchId) : null;
  return { armed, capacity: capacity ? { free: capacity.free, live: capacity.live, cap: capacity.cap } : null, scope_readable: scope.readable, scope_excludes: scopeExcludes, gap_row_visible: visible, ...(dispatch ? { dispatch } : {}) };
}

export type ComposePlacement =
  | { where: "local"; why: string }
  | { where: "peer"; node: string; via: string; free: number; why: string };

/** Why a peer's answer is no candidate, or null when it is one. Pure. */
export function placementRefusal(body: Row, q: { vessel: string; armed: boolean }, localNode: string): string | null {
  const node = typeof body["node"] === "string" ? body["node"] : "";
  if (!node) return "names no node";
  if (node === localNode) return "is this node";
  const owned = Array.isArray(body["owned_repos"]) ? (body["owned_repos"] as unknown[]).map(String) : [];
  if (!owned.includes(q.vessel)) return `does not compose ${q.vessel}`;
  const a = (body["placement"] && typeof body["placement"] === "object" ? body["placement"] : null) as Partial<ComposePlacementAnswer> | null;
  if (!a) return "answered no placement (an older composeOwnership)";
  if (a.armed !== q.armed) return `answered for the ${a.armed ? "armed" : "unarmed"} class`;
  if (a.gap_row_visible !== true) return a.gap_row_visible === false ? "does not see the gap row (another gap store)" : "could not read the gap row";
  if (a.scope_readable !== true) return "its autonomy scope is unreadable";
  if (Array.isArray(a.scope_excludes) && a.scope_excludes.length > 0) return `its autonomy scope excludes ${a.scope_excludes[0]!.target}`;
  const free = a.capacity && typeof a.capacity.free === "number" ? a.capacity.free : null;
  if (free === null) return "its compose capacity is unobservable";
  if (free <= 0) return `no free ${q.armed ? "armed" : "unarmed"} slot (${a.capacity!.live} in flight, cap ${a.capacity!.cap})`;
  return null;
}

/**
 * Where a compose of `gap_id` (class `armed`, target vessel `vessel`, scope targets `targets`) should be dispatched.
 * Never throws; every failure keeps the dispatch local, as before. `placed` counts the goals this caller has already
 * placed per peer node in the same pass: a peer's free slot is a peek, not a claim (its slot is taken only when its
 * compose starts), so each placement is debited from what the peer reports, or one free slot would draw every goal.
 */
export async function placeCompose(q: { gap_id: string; vessel: string; targets: string[]; armed: boolean }, localNode: string, placed: Map<string, number> = new Map()): Promise<ComposePlacement> {
  const cls = q.armed ? "armed" : "unarmed";
  const owned = ownedVessels();
  const notOwner = owned.size > 0 && !owned.has(q.vessel);
  const local = await peekComposeCapacity({ directed: false, armed: q.armed });
  if (!notOwner && local === null) return { where: "local", why: "local compose capacity unobservable (fail open: dispatched here)" };
  if (!notOwner && local!.free > 0) return { where: "local", why: `a local ${cls} slot is free (${local!.free} of ${local!.cap})` };
  const busy = notOwner ? `this node does not compose ${q.vessel}` : `no free local ${cls} slot (${local!.live} in flight, cap ${local!.cap})`;
  const look = await lookupShape("composeOwnership");
  if (!look.ok) {
    console.warn(`[compose-placement] ${q.gap_id}: ${busy}; peers unreadable (${describeLookup(look)}): dispatched here`);
    return { where: "local", why: `${busy}; peers unreadable` };
  }
  const asks = look.producers.filter((p) => p.origin !== "local" && p.resolveEndpoint.length > 0);
  const pointer = { type: "composeOwnership", gap_id: q.gap_id, targets: q.targets, armed: q.armed };
  const answers = await Promise.all(asks.map(async (p) => {
    // Same host only (self-auth.ts crossNodeKeyHeaders): a producer elsewhere gets no key and no read, so is no candidate.
    // An overlay row (a libp2p facade through this node's own federation egress) is refused from its metadata.
    const auth = await crossNodeKeyHeaders(p.resolveEndpoint, { id: p.id, origin: p.origin, protocol: (p as { protocol?: string }).protocol });
    if (!auth) return null;
    try {
      const r = await fetch(p.resolveEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ impulse: { pointer } }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { shape?: unknown; body?: unknown };
      if (j.shape !== "composeOwnership" || !j.body || typeof j.body !== "object") throw new Error(`answered ${String(j.shape ?? "no shape")}`);
      return { p, body: j.body as Row };
    } catch (err) {
      console.warn(`[compose-placement] ${q.gap_id}: capacity read from ${p.id || p.resolveEndpoint} failed (${String((err as Error)?.message ?? err).slice(0, 160)}): not a candidate`);
      return null;
    }
  }));
  let best: { node: string; via: string; free: number } | null = null;
  const refused: string[] = [];
  for (const a of answers) {
    if (!a) continue;
    const why = placementRefusal(a.body, q, localNode);
    const node = String(a.body["node"] ?? a.p.id);
    if (why) { refused.push(`${node} ${why}`); continue; }
    const free = Number((a.body["placement"] as ComposePlacementAnswer).capacity!.free) - (placed.get(node) ?? 0);
    if (free <= 0) { refused.push(`${node} has its free slot(s) taken by goals placed this pass`); continue; }
    if (!best || free > best.free) best = { node, via: a.p.resolveEndpoint, free };
  }
  if (!best) return { where: "local", why: `${busy}; no peer can take it${refused.length ? ` (${refused.slice(0, 3).join("; ")})` : asks.length ? "" : " (no peer composer discovered)"}` };
  placed.set(best.node, (placed.get(best.node) ?? 0) + 1);
  return { where: "peer", ...best, why: `${busy}; ${best.node} has ${best.free} free ${cls} slot(s)` };
}

/**
 * A PLACED goal's outcome, read back through the peer's development-vessel that took it (`via`, the ledger's
 * dispatch_host): a composeOwnership read naming the dispatch, which the peer answers from its own goal-host. Null when
 * it cannot be read here (off this host, unreachable, malformed, or an older peer whose answer carries no dispatch),
 * so the caller keeps today's unread path. Never throws.
 */
export async function readPlacedDispatch(via: string, q: { gap_id: string; dispatch_id: string }): Promise<DispatchProbe | null> {
  const auth = await crossNodeKeyHeaders(via);
  if (!auth) return null;
  try {
    const r = await fetch(via, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ impulse: { pointer: { type: "composeOwnership", gap_id: q.gap_id, dispatch_id: q.dispatch_id } } }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { shape?: unknown; body?: { placement?: { dispatch?: unknown } } };
    const d = j.shape === "composeOwnership" ? (j.body?.placement?.dispatch as Row | undefined) : undefined;
    if (!d || typeof d !== "object" || (typeof d["http"] !== "number" && d["http"] !== "unreachable")) return null;
    return d as unknown as DispatchProbe;
  } catch (err) {
    console.warn(`[compose-placement] ${q.gap_id}: placed dispatch ${q.dispatch_id} unread through ${via} (${String((err as Error)?.message ?? err).slice(0, 160)})`);
    return null;
  }
}

/** Send a dispatch_goal through a peer's development-vessel (its goal-host then composes on that peer). Never throws. */
export async function dispatchGoalOnPeer(via: string, pointer: DispatchGoalPointer): Promise<ResolverResult> {
  // Checked again at the send (defence in depth): a target off this host gets no key and no call, a non-attempt.
  const auth = await crossNodeKeyHeaders(via);
  if (!auth) return { shape: "structuredError", body: { resolver: "dispatch_goal", detail: `peer ${via} is not on this host: not sent`, goal: pointer.goal } };
  try {
    const r = await fetch(via, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ impulse: { pointer } }),
      signal: AbortSignal.timeout(PLACED_SEND_TIMEOUT_MS),
    });
    const j = (await r.json().catch(() => null)) as { shape?: unknown; body?: unknown } | null;
    if (j && typeof j.shape === "string") return { shape: j.shape, body: j.body ?? {} };
    // No resolve envelope (an auth refusal, a proxy error): not taken there. No http_status, so the send is classified
    // as a non-attempt (the receiver did not answer the goal), never as a charged failure.
    return { shape: "structuredError", body: { resolver: "dispatch_goal", detail: `peer ${via} answered HTTP ${r.status} with no resolve envelope`, goal: pointer.goal } };
  } catch (err) {
    console.warn(`[compose-placement] placed send through ${via} failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    return { shape: "structuredError", body: { resolver: "dispatch_goal", detail: `peer ${via} unreachable: ${String((err as Error)?.message ?? err).slice(0, 160)}`, goal: pointer.goal } };
  }
}
