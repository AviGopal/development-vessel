import { WORKSPACE_ROOT } from "../config.js";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { selfAuthHeaders } from "../lib/self-auth.js";
import type { ComposeEligibilitySkipReason } from "../judge/gap-eligibility.js";

const ACTIVITY_API_URL = process.env["ACTIVITY_API_URL"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const DEV_VESSEL_ENDPOINT = process.env["DEV_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8090"; // env-overridable dev-vessel base URL
const SELF_RESOLVE_URL = `${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`;

// THE REMEDY TYPES THIS OBSERVER MAY DISPATCH. The type comes from gap data, and the dispatch carries the
// node's own key (selfAuthHeaders), so an open set would let any gap writer run any write-gated shape,
// fs_write and fs_edit included, as this node. The list is the set of types existing remedies use:
// gap_to_feature (trace-store-health-observer's remedies). A new remedy type is added here, deliberately.
export const DRAIN_REMEDY_ALLOWLIST: ReadonlySet<string> = new Set(["gap_to_feature"]);

// COMPOSE-NUDGE ELIGIBILITY. A written gap nudges the composer only when its STORE ROW exists, is open, is
// armed (falsifier class1/class2: the classes the lane's admission accepts, normalised the way gap-to-feature
// reads `falsifier`, string or {class}), names an edit site (the fields admission's hasEditSite accepts), and is
// not held (operator_hold, a parking disposition, a landing awaiting its verdict: admission's own predicates).
// Measured 24h: the most-nudged ids were absent, closed, rejected, falsifier none and falsifier unresolvable,
// none of which admission can pick. The event payload carries no classification_metadata, so the row is read.
// The row predicate itself is gap-to-feature's composeEligibilitySkipReason, the one the picker and the gap-write
// nudge use too; this module adds only what reading a row by id can fail with.
export type ComposeNudgeSkipReason = ComposeEligibilitySkipReason | "not_found" | "read_failed";
const NUDGE_ROW_TTL_MS = 60_000;
const NUDGE_SUMMARY_WINDOW_MS = 60_000;
const emptySkipCounts = (): Record<ComposeNudgeSkipReason, number> => ({ not_found: 0, not_open: 0, unarmed: 0, no_edit_site: 0, held: 0, read_failed: 0 });
// One read per distinct gap per TTL window; a burst of writes for one id reuses the in-flight read.
const nudgeRowCache = new Map<string, { at: number; row: Promise<Record<string, unknown> | null> }>();
let nudgeSkipCounts = emptySkipCounts();
let nudgeSkipWindowStart = Date.now();

async function readGapRowForNudge(gapId: string): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const hit = nudgeRowCache.get(gapId);
  if (hit && now - hit.at < NUDGE_ROW_TTL_MS) return hit.row;
  if (nudgeRowCache.size > 2000) {
    for (const [k, v] of nudgeRowCache) if (now - v.at >= NUDGE_ROW_TTL_MS) nudgeRowCache.delete(k);
  }
  const row = (async () => {
    const { resolveSubstrateGap } = await import("../resolvers/substrate-gap.js");
    const r = await resolveSubstrateGap({ type: "substrateGap", id: gapId, limit: 1 });
    // Anything but a substrateGap answer (an unreachable holder's structuredError) is a failed read, not absence.
    if (r.shape !== "substrateGap") throw new Error(`gap store answered ${r.shape}`);
    const rows = ((r.body as { gaps?: unknown }).gaps ?? []) as Array<Record<string, unknown>>;
    return rows.find((x) => x["id"] === gapId) ?? null;
  })();
  nudgeRowCache.set(gapId, { at: now, row });
  row.catch(() => nudgeRowCache.delete(gapId));
  return row;
}

const DRAIN_BACKOFF_INITIAL_MS = 60000;
const DRAIN_BACKOFF_MAX_MS = 3600000;

/** Drain dispatches held per gap by an open remedy_livelock gap (counted in the held_livelock line). */
const livelockHeldCounts = new Map<string, number>();

/** Expired livelock holds already logged ("hold expired" once per livelock gap and named gap). */
const livelockExpiredLogged = new Set<string>();

/**
 * When a livelock gap's hold ends. Nothing closes a remedy_livelock gap (remedy_effectiveness_observer only opens
 * them), so a hold keyed on "open" alone would never lift. It lasts one observer window from detection: the
 * livelock gap's review_by when it carries one, else detected_at plus the window_hours the observer stamped on it
 * (its pointer default when absent). Null when no detection time can be read: such a gap holds nothing.
 */
export async function livelockHoldUntilMs(row: Record<string, unknown>): Promise<number | null> {
  const meta = (row["classification_metadata"] ?? {}) as Record<string, unknown>;
  const review = Date.parse(String(meta["review_by"] ?? row["review_by"] ?? ""));
  if (Number.isFinite(review)) return review;
  const detected = Date.parse(String(row["detected_at"] ?? row["created_at"] ?? ""));
  if (!Number.isFinite(detected)) return null;
  const stamped = Number(meta["window_hours"]);
  const { DEFAULT_WINDOW_HOURS } = await import("../resolvers/remedy-effectiveness-observer.js");
  return detected + (Number.isFinite(stamped) && stamped > 0 ? stamped : DEFAULT_WINDOW_HOURS) * 3_600_000;
}

/** The id of an OPEN remedy_livelock gap whose failing_gap_id is `gapId` and whose hold has not expired, or null
 *  (none, all expired, or the store unreadable). An expired hold logs "hold expired" once. */
export async function openLivelockHolderOf(gapId: string): Promise<string | null> {
  if (!gapId) return null;
  try {
    const { resolveSubstrateGap } = await import("../resolvers/substrate-gap.js");
    const r = await resolveSubstrateGap({ type: "substrateGap", category: "remedy_livelock", status: "open", limit: Number.MAX_SAFE_INTEGER } as never);
    if (r.shape !== "substrateGap") throw new Error(`gap store answered ${r.shape}`);
    const rows = ((r.body as { gaps?: unknown }).gaps ?? []) as Array<Record<string, unknown>>;
    const naming = rows.filter((x) => String(x["status"] ?? "open") === "open" && String(((x["classification_metadata"] ?? {}) as Record<string, unknown>)["failing_gap_id"] ?? "") === gapId);
    const now = Date.now();
    for (const x of naming) {
      const id = String(x["id"] ?? "");
      const until = await livelockHoldUntilMs(x);
      if (until !== null && now < until) return id || null;
      const key = `${id}\u0000${gapId}`;
      if (!livelockExpiredLogged.has(key)) {
        livelockExpiredLogged.add(key);
        console.log(`[gap-drain-observer] hold expired: remedy_livelock gap ${id} no longer holds ${gapId} (${until === null ? "no detection time" : `expired ${new Date(until).toISOString()}`}); dispatching`);
        appendDrainLine({ action: "livelock_hold_expired", gap_id: gapId, livelock_gap_id: id, expired_at: until === null ? null : new Date(until).toISOString() });
      }
    }
    return null;
  } catch (err) {
    console.log(`[gap-drain-observer] livelock hold read failed for ${gapId} (dispatching as before): ${String(err).slice(0, 200)}`);
    return null;
  }
}

export async function composeNudgeSkipReason(gapId: string): Promise<ComposeNudgeSkipReason | null> {
  if (!gapId) return "not_found";
  let row: Record<string, unknown> | null;
  try {
    row = await readGapRowForNudge(gapId);
  } catch {
    return "read_failed";
  }
  if (!row) return "not_found";
  const { composeEligibilitySkipReason } = await import("../judge/gap-eligibility.js");
  return composeEligibilitySkipReason(row);
}

function countNudgeSkip(reason: ComposeNudgeSkipReason): void {
  nudgeSkipCounts[reason] += 1;
}

/** The gap-write path's compose nudge skips into the SAME per-window summary as this observer (one drain-log line
 *  per window, nothing per event). */
export function countComposeNudgeSkip(reason: ComposeNudgeSkipReason): void {
  countNudgeSkip(reason);
  flushNudgeSkipSummary(appendDrainLine);
}

export function __composeNudgeSkipCountsForTests(): Record<ComposeNudgeSkipReason, number> {
  return { ...nudgeSkipCounts };
}

/** One drain-log line per window carrying every skip reason; nothing when nothing was skipped. */
function flushNudgeSkipSummary(write: (entry: Record<string, unknown>) => void, force = false): void {
  const now = Date.now();
  if (!force && now - nudgeSkipWindowStart < NUDGE_SUMMARY_WINDOW_MS) return;
  const counts = nudgeSkipCounts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const windowMs = now - nudgeSkipWindowStart;
  nudgeSkipCounts = emptySkipCounts();
  nudgeSkipWindowStart = now;
  if (total === 0) return;
  write({ action: "compose_nudge_skipped_summary", skipped: counts, total, window_ms: windowMs });
  console.log(`[gap-drain-observer] compose nudges skipped in ${windowMs}ms: ${JSON.stringify(counts)}`);
}

export function __resetComposeNudgeGateForTests(): void {
  nudgeRowCache.clear();
  nudgeSkipCounts = emptySkipCounts();
  nudgeSkipWindowStart = Date.now();
}

export function __flushComposeNudgeSkipSummaryForTests(): void {
  flushNudgeSkipSummary(appendDrainLine, true);
}

export class GapDrainObserver {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBackoffMs = RECONNECT_INITIAL_MS;
  private lastSeenSequence: number | null = null;
  private inFlight: Set<string> = new Set();
  private lastExecutionCompletedDrainAt = 0;

  start(): void {
    this.shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    flushNudgeSkipSummary(appendDrainLine, true);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "GapDrainObserver shutting down");
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private buildWsUrl(): string {
    const wsBase = ACTIVITY_API_URL.replace(/^http(s?):\/\//, "ws$1://");
    return `${wsBase.replace(/\/$/, "")}/ws`;
  }

  private connect(): void {
    if (!this.shouldRun) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.buildWsUrl());
    } catch (err) {
      console.log("[gap-drain-observer] failed to construct WebSocket (non-fatal):", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
  console.log(`[gap-drain-observer] connected to ${this.buildWsUrl()}`);
      this.currentBackoffMs = RECONNECT_INITIAL_MS;
      try {
        ws.send(JSON.stringify({ type: "authenticate", token: METABOB_API_KEY }));
        if (this.lastSeenSequence !== null) {
          ws.send(JSON.stringify({ type: "catchup", lastSeenSequence: this.lastSeenSequence }));
        }
      } catch (err) {
        console.log("[gap-drain-observer] failed to send authenticate frame (non-fatal):", err);
      }
    });

    ws.addEventListener("message", (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const parsed = JSON.parse(raw) as { type?: string; sequence?: number; data?: unknown };
        if (typeof parsed.sequence === "number") this.lastSeenSequence = parsed.sequence;
        void this.handleEvent(parsed);
      } catch (err) {
        console.log("[gap-drain-observer] failed to parse or handle event (non-fatal):", err);
      }
    });

    ws.addEventListener("close", () => {
  console.log("[gap-drain-observer] socket closed — reconnecting");
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      console.log("[gap-drain-observer] socket error (non-fatal):", (event as unknown as { message?: string }).message ?? "unknown");
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) return;
    const delay = this.currentBackoffMs;
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handleEvent(event: { type?: string; data?: unknown }): Promise<void> {
    try {
      if (event.type === "devvessel.gap.written") {
        await this.handleGapWritten(event.data as Record<string, unknown>);
      } else if (event.type === "execution_completed") {
        await this.handleExecutionCompleted();
      }
    } catch (err) {
      console.log("[gap-drain-observer] handleEvent error (non-fatal):", err);
    }
  }

  /**
   * Event-driven drain for COMPOSABLE gaps: nudge gap_to_feature when one is written.
   *
   * Rate discipline, not a timer (law 5): nothing here paces work on a clock. The
   * event is the trigger; these two guards only stop a burst of gap writes from
   * launching concurrent composes, which is expensive and self-defeating since the
   * picker would select the same highest-scoring gap each time.
   */
  private async nudgeComposableDrain(gapId: string, category: string): Promise<void> {
    // Eligibility before the in-flight/cooldown guards, so every skip reason is counted whatever the lane state.
    const skip = await composeNudgeSkipReason(gapId);
    if (skip !== null) {
      countNudgeSkip(skip);
      flushNudgeSkipSummary((e) => this.recordDrain(e));
      return;
    }
    flushNudgeSkipSummary((e) => this.recordDrain(e));
    const g = globalThis as unknown as { __composeDrainInflight?: boolean; __composeDrainLastAt?: number };
        const MIN_INTERVAL_MS = Number(process.env["COMPOSE_DRAIN_MIN_INTERVAL_MS"] ?? 90_000);
    const now = Date.now();
    if (g.__composeDrainInflight === true) {
      this.recordDrain({ action: "compose_skipped_inflight", gap_id: gapId, category });
      return;
    }
    if (typeof g.__composeDrainLastAt === "number" && now - g.__composeDrainLastAt < MIN_INTERVAL_MS) {
      this.recordDrain({ action: "compose_skipped_cooldown", gap_id: gapId, category, since_last_ms: now - g.__composeDrainLastAt });
      return;
    }
    g.__composeDrainInflight = true;
    g.__composeDrainLastAt = now;
    const t0 = now;
    try {
      const resp = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ impulse: { type: "gap_to_feature", triggered_by: "gap-drain-observer", flow: "gap-compose" } }),
        signal: AbortSignal.timeout(600_000),
      });
      this.recordDrain({ action: "compose_nudged", gap_id: gapId, category, ok: resp.ok, http_status: resp.status, latency_ms: Date.now() - t0 });
    } catch (err) {
      // A failed nudge is not a verdict about the gap; the next write re-arms it.
      this.recordDrain({ action: "compose_nudge_failed", gap_id: gapId, category, error: String(err), latency_ms: Date.now() - t0 });
    } finally {
      g.__composeDrainInflight = false;
    }
  }

  private async handleGapWritten(data: Record<string, unknown>): Promise<void> {
    const gapId = typeof data["gap_id"] === "string" ? (data["gap_id"] as string) : "";
    const category = typeof data["category"] === "string" ? (data["category"] as string) : "unknown";
    const route = data["route"];
    const remedy = data["remedy"] as { vessel?: string; impulse_type?: string; goal?: string } | undefined;
    const status = data["status"];
    if (status !== undefined && status !== "open") return;
    if (route !== "dispatchable") {
      // COMPOSABLE GAPS HAD NO EVENT PATH AT ALL.
      //
      // This observer returned here for anything not route:dispatchable, and the
      // gap-compose watchdog — the only other lane, by its own drop-in comment
      // ("Composable gaps rely solely on this watchdog") — is permanently
      // suppressed: its stall marker is /workspace/proposals/compose-lessons.jsonl,
      // which EVERY compose in the fleet appends to, so stalledForMs never reaches
      // WATCHDOG_STALL_MIN and it returns "flow alive" forever. Measured: the marker
      // was 4 seconds old on a fleet where gap_to_feature had not run in 24h.
      //
      // That is the same defect the 2026-07-29 drop-in comment describes fixing when
      // drain-log.jsonl was the shared marker — pinning to a different SHARED file
      // moved the problem down one level rather than removing it. So the composable
      // backlog (154 of 157 open gaps) drained at exactly zero per day.
      //
      // Nudge the composer directly on the write event instead. Guarded so a burst of
      // gap writes cannot storm it: one compose in flight at a time, plus a floor on
      // the interval between nudges. Both are deliberately cheap and local — a stalled
      // compose simply means the next event re-arms it.
      await this.nudgeComposableDrain(gapId, category);
      return;
    }
    const remedyExt = remedy as { impulse_type?: string; goal?: string; target_template_id?: string } | undefined;
    const extTemplateId = remedyExt && typeof remedyExt.target_template_id === "string" && remedyExt.target_template_id.length > 0 ? remedyExt.target_template_id : "";
    const extGoal = remedyExt && typeof remedyExt.goal === "string" && remedyExt.goal.length > 0 ? remedyExt.goal : "";
    const extHasImpulse = remedyExt && typeof remedyExt.impulse_type === "string" && remedyExt.impulse_type.length > 0;
    // A goal-host remedy ({goal} or {target_template_id}, no impulse_type) is POSTed to goal-host /run-goal. It used
    // to be dispatched right here, before every brake below, so a remedy_livelock gap (whose remedy is such a goal)
    // was re-POSTed on every scan with no backoff and no hold. It now takes the same path as an impulse remedy: the
    // livelock hold, the drain backoff, the in-flight guard and the non-attempt recognition. Only the impulse-type
    // checks (the allowlist) and the maintenance-lease deferral stay impulse-only, as before.
    const extRemedy = !extHasImpulse && (extTemplateId !== "" || extGoal !== "");
    if (!extRemedy && (!remedy || typeof remedy.impulse_type !== "string" || remedy.impulse_type.length === 0)) return;
    const impulseType = extRemedy ? "" : String(remedy!.impulse_type);
    if (!extRemedy && !DRAIN_REMEDY_ALLOWLIST.has(impulseType)) {
      console.warn(`[gap-drain-observer] REFUSED remedy for gap ${gapId}: impulse_type ${JSON.stringify(impulseType.slice(0, 80))} is not on the drain remedy allowlist (${[...DRAIN_REMEDY_ALLOWLIST].join(", ")})`);
      this.recordDrain({ action: "refused_remedy_type", gap_id: gapId, category, impulse_type: impulseType.slice(0, 80) });
      return;
    }
    // LIVELOCK HOLD. remedy_effectiveness_observer files an open remedy_livelock gap naming the gap whose remedy keeps
    // being dispatched without moving its metric (classification_metadata.failing_gap_id). Nothing consumed it, so
    // this observer kept re-dispatching the very gap it names. While such a gap is open, the named gap is held
    // from drain dispatch. Read from the gap store at use time; an unreadable store holds nothing (dispatch as before).
    // The hold lasts one observer window (livelockHoldUntilMs). The cheap in-process backoff is asked first, so the
    // store read runs only when the backoff would not already block.
    const gd = globalThis as any;
    gd.__drainBackoff ??= new Map();
    let boEntry = gd.__drainBackoff.get(gapId);
    // A goal-host remedy is judged by its dispatch OUTCOME, not by goal-host's 202 ACK: the ACK keeps the backoff with
    // the dispatch id, and once that window has passed the outcome is read (GET /executions/:id, gap-check-supply's
    // probeDispatch). Reached clears the backoff and the drain proceeds; still running waits another window, but only
    // within check-supply's dispatch_timeout_hours (dispatchVerdict over the gap-check-supply rhythm, the bound that
    // reader already applies; an entry with no dispatched_at is past it); anything else (not reached, unreadable, or
    // running past the bound) grows the backoff and drops the id, so the next window re-dispatches.
    if (boEntry?.dispatch_id && Date.now() >= boEntry.until) {
      const { probeDispatch, dispatchVerdict, outcomeBoundsOf, checkSupplyNode, CHECK_SUPPLY_FAMILY } = await import("../resolvers/gap-check-supply.js");
      const { readFamilyRhythm } = await import("../resolvers/rhythm-conductor-tick.js");
      const probe = await probeDispatch(String(boEntry.dispatch_id));
      const status = probe.http === 200 ? String(probe.status ?? "").toLowerCase() : "";
      const reached = probe.http === 200 && probe.reached === true;
      const node = checkSupplyNode();
      const bounds = outcomeBoundsOf((await readFamilyRhythm(CHECK_SUPPLY_FAMILY))?.body ?? {});
      const verdict = reached ? null : dispatchVerdict({ dispatch_id: String(boEntry.dispatch_id), dispatch_node: node, last_dispatch_at: typeof boEntry.dispatched_at === "string" ? boEntry.dispatched_at : undefined } as Parameters<typeof dispatchVerdict>[0], probe, Date.now(), bounds, node);
      const running = verdict?.kind === "running";
      this.recordDrain({ action: "dispatch_outcome", gap_id: gapId, category, dispatch_id: boEntry.dispatch_id, http_status: probe.http, status: status || null, reached, ...(verdict && verdict.kind === "lost" && verdict.why === "timed_out" ? { timed_out: true } : {}) });
      if (reached) {
        gd.__drainBackoff.delete(gapId);
        boEntry = undefined;
      } else {
        const attempts = running ? boEntry.attempts : boEntry.attempts + 1;
        const delay = Math.min(DRAIN_BACKOFF_INITIAL_MS * 2 ** (attempts - 1), DRAIN_BACKOFF_MAX_MS);
        gd.__drainBackoff.set(gapId, { until: Date.now() + delay, attempts, ...(running ? { dispatch_id: boEntry.dispatch_id, dispatched_at: boEntry.dispatched_at } : {}) });
        return;
      }
    }
    if (boEntry && Date.now() < boEntry.until) { return; }
    {
      const holder = await openLivelockHolderOf(gapId);
      if (holder) {
        const held = (livelockHeldCounts.get(gapId) ?? 0) + 1;
        livelockHeldCounts.set(gapId, held);
        console.log(`[gap-drain-observer] held ${gapId}: open remedy_livelock gap ${holder} names it (held ${held}x)`);
        this.recordDrain({ action: "held_livelock", gap_id: gapId, category, livelock_gap_id: holder, held_count: held });
        return;
      }
    }
    const g = globalThis as unknown as { __drainInflight?: Set<string> };
    g.__drainInflight ??= new Set<string>();
    if (g.__drainInflight.has(category) || g.__drainInflight.size >= 2) {
      this.recordDrain({ action: "skipped_inflight", gap_id: gapId, category });
      return;
    }
    if (!extRemedy) try {
      for (const leaseName of ["trace_store", "change_window"]) {
        const leaseResp = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ impulse: { type: "maintenanceLease", name: leaseName } }),
          signal: AbortSignal.timeout(5000),
        });
        const leaseBody = (await leaseResp.json()) as { body?: { held?: boolean } };
        if (leaseBody?.body?.held === true) {
          this.recordDrain({ action: "deferred_lease_held", gap_id: gapId, category, lease: leaseName });
          return;
        }
      }
    } catch (err) {
      console.log("[gap-drain-observer] lease check failed (proceeding):", err);
    }
    g.__drainInflight.add(category);
    const startedAt = Date.now();
    try {
      // The remedy's impulse type comes from the gap record, so it can be a write: carry the node key,
      // or this vessel's own write gate refuses the dispatch (lib/self-auth.ts).
      const resp = extRemedy
        ? await fetch((process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210") + "/run-goal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(extTemplateId !== "" ? { targetTemplateId: extTemplateId, variables: { gap_id: gapId, triggered_by: "gap-drain" } } : { goal: extGoal }),
            signal: AbortSignal.timeout(120000),
          })
        : await fetch(SELF_RESOLVE_URL, { // env-overridable
            method: "POST",
            headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
            body: JSON.stringify({ impulse: { type: impulseType, triggered_by: "gap-drain", gap_id: gapId } }),
            signal: AbortSignal.timeout(120000),
          });
      if (resp.ok && extRemedy) {
        // goal-host answers 202 with a dispatchId before the goal runs: an ACK, not a success. Keep the backoff with
        // the id; the outcome read above settles it. A body that already says reached clears it.
        const ack = (await resp.clone().json().catch(() => ({}))) as { dispatchId?: unknown; status?: unknown; reached?: unknown };
        if (ack.reached === true) gd.__drainBackoff.delete(gapId);
        else {
          const attempts = (gd.__drainBackoff.get(gapId)?.attempts ?? 0) + 1;
          const delay = Math.min(DRAIN_BACKOFF_INITIAL_MS * 2 ** (attempts - 1), DRAIN_BACKOFF_MAX_MS);
          const did = typeof ack.dispatchId === "string" && ack.dispatchId ? ack.dispatchId : null;
          gd.__drainBackoff.set(gapId, { until: Date.now() + delay, attempts, ...(did ? { dispatch_id: did, dispatched_at: new Date().toISOString() } : {}) });
        }
      } else if (resp.ok) {
        gd.__drainBackoff.delete(gapId);
      } else {
        const prev = gd.__drainBackoff.get(gapId);
        const attempts = (prev?.attempts ?? 0) + 1;
        const delay = Math.min(DRAIN_BACKOFF_INITIAL_MS * 2 ** (attempts - 1), DRAIN_BACKOFF_MAX_MS);
        gd.__drainBackoff.set(gapId, { until: Date.now() + delay, attempts });
      }
      // A 200 that was NOT an attempt must not clear backoff. If resp.ok and the body is a non-attempt
      // (pending_verification or the class of BUSY/environment outcomes gap_to_feature answers 200 with),
      // reinstate backoff before recording the dispatch.
      try {
        if (resp.ok) {
          let body: Record<string, unknown> | null = null;
          try {
            const j = (await resp.clone().json()) as { shape?: string; body?: Record<string, unknown> } | Record<string, unknown>;
            const maybeBody = (j as { body?: Record<string, unknown> }).body;
            body = (maybeBody && typeof maybeBody === "object") ? maybeBody : (j as Record<string, unknown>);
          } catch {
            body = null;
          }
          if (body) {
            let nonAttempt = false;
            const verdict = String((body as Record<string, unknown>)["verdict"] ?? "");
            if (verdict === "pending_verification") {
              nonAttempt = true;
            } else {
              try {
                const { isNonAttemptComposeResult } = await import("../judge/gap-eligibility.js");
                nonAttempt = isNonAttemptComposeResult(body);
              } catch {
                nonAttempt = false;
              }
            }
            if (nonAttempt) {
              const attempts = ((boEntry?.attempts ?? 0) + 1);
              const delay = Math.min(DRAIN_BACKOFF_INITIAL_MS * 2 ** (attempts - 1), DRAIN_BACKOFF_MAX_MS);
              gd.__drainBackoff.set(gapId, { until: Date.now() + delay, attempts });
            }
          }
        }
      } catch {
        /* ignore: recordDrain still happens */
      }
      this.recordDrain({ action: "dispatched", gap_id: gapId, category, ...(extRemedy ? { remedy: extTemplateId !== "" ? extTemplateId : extGoal } : { impulse_type: impulseType }), ok: resp.ok, http_status: resp.status, latency_ms: Date.now() - startedAt });
    } catch (err) {
      const prev = gd.__drainBackoff.get(gapId);
      const attempts = (prev?.attempts ?? 0) + 1;
      const delay = Math.min(DRAIN_BACKOFF_INITIAL_MS * 2 ** (attempts - 1), DRAIN_BACKOFF_MAX_MS);
      gd.__drainBackoff.set(gapId, { until: Date.now() + delay, attempts });
      this.recordDrain({ action: "dispatch_failed", gap_id: gapId, category, ...(extRemedy ? {} : { impulse_type: impulseType }), error: String(err), latency_ms: Date.now() - startedAt });
    } finally {
      g.__drainInflight.delete(category);
    }
  }

  private async handleExecutionCompleted(): Promise<void> {
    flushNudgeSkipSummary(appendDrainLine);
    const g = globalThis as unknown as { __drainLastScan?: number; __drainInflight?: Set<string> };
    const now = Date.now();
    if (g.__drainLastScan !== undefined && now - g.__drainLastScan < 60000) return;
    g.__drainLastScan = now;
    g.__drainInflight ??= new Set<string>();
    let impulses: Array<{ id?: string; shape?: string; body?: { gap_id?: string; category?: string; route?: string; remedy?: { impulse_type?: string } } }> = [];
    try {
      const { resolvePoolImpulse } = await import("../resolvers/pool-impulse.js");
      const result = resolvePoolImpulse({ type: "poolImpulse", status: "open" });
      impulses = (result.body?.impulses ?? []) as typeof impulses;
    } catch (err) {
      console.log("[gap-drain-observer] standing pool read failed (non-fatal):", err);
      return;
    }
    for (const imp of impulses) {
      const body = imp.body;
      if (!body || body.route !== "dispatchable") continue;
      const impulseType = body.remedy?.impulse_type;
      if (typeof impulseType !== "string" || impulseType.length === 0) continue;
      const category = body.category ?? "unknown";
      const gapId = body.gap_id ?? imp.id ?? "";
      if (g.__drainInflight.has(category) || g.__drainInflight.size >= 2) {
        this.recordDrain({ action: "skipped_inflight", gap_id: gapId, category, source: "execution_completed_scan" });
        continue;
      }
      await this.handleGapWritten({ gap_id: gapId, category, route: "dispatchable", remedy: body.remedy, status: "open" });
    }
    await this.scanDiscardedLandings().catch(() => undefined);
  }

  /**
   * DISCARDED-LANDINGS DETECTOR (resumable landings 1.5). Counts, per hour, composes whose
   * report shows a FAVORABLE verdict but no cutover that pushed - verified work thrown away
   * after passing every gate - split by cause, and files a day-keyed gap when non-zero, so
   * the class is a gap event and not a journal grep.
   */
  private async scanDiscardedLandings(): Promise<void> {
    const g = globalThis as unknown as { __discardedLastScan?: number };
    const now = Date.now();
    if (g.__discardedLastScan !== undefined && now - g.__discardedLastScan < 600_000) return;
    g.__discardedLastScan = now;
    const dir = existsSync("/workspace/proposals") ? "/workspace/proposals" : join(WORKSPACE_ROOT, "proposals");
    const byCause = { lease_refused: 0, drain_killed: 0, deferred: 0, other: 0 };
    const gapIds: string[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith("-compose-report.json"));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const p = join(dir, f);
        if (now - statSync(p).mtimeMs > 3_600_000) continue;
        const r = JSON.parse(readFileSync(p, "utf8")) as { verdict?: string; cutovers?: Array<{ result?: Record<string, unknown> }>; semantic_gate?: { addresses?: boolean } };
        const cuts = Array.isArray(r.cutovers) ? r.cutovers : [];
        if (cuts.length === 0) continue;
        const pushed = cuts.some((c) => c?.result?.["push_status"] === "pushed" && typeof c?.result?.["new_git_sha"] === "string" && String(c.result["new_git_sha"]).trim() !== "");
        const judged = r.semantic_gate?.addresses === true || cuts.some((c) => c?.result?.["verdict"] === "FAVORABLE");
        if (pushed || !judged) continue;
        const t = JSON.stringify(cuts);
        if (/env_change_window_held|change[_ ]window( lease)? held|lease held/i.test(t)) byCause.lease_refused++;
        else if (/deferred/i.test(t)) byCause.deferred++;
        else if (/drain|SIGTERM|draining/i.test(t)) byCause.drain_killed++;
        else byCause.other++;
        gapIds.push(f.replace(/-compose-report\.json$/, ""));
      } catch {
        /* unreadable report: skip it */
      }
    }
    const total = byCause.lease_refused + byCause.drain_killed + byCause.deferred + byCause.other;
    const report = { shape: "discardedLandingReport", window_minutes: 60, generated_at: new Date(now).toISOString(), total, by_cause: byCause, gap_ids: gapIds };
    console.log(`[gap-drain-observer] discarded landings: total=${total} ${JSON.stringify(byCause)}`);
    try {
      const poolDir = join(WORKSPACE_ROOT, "pool");
      mkdirSync(poolDir, { recursive: true });
      writeFileSync(join(poolDir, "discarded-landings.json.tmp"), JSON.stringify(report, null, 2), "utf8");
      renameSync(join(poolDir, "discarded-landings.json.tmp"), join(poolDir, "discarded-landings.json"));
      appendFileSync(join(poolDir, "discarded-landings.jsonl"), JSON.stringify(report) + "\n", "utf8");
    } catch (err) {
      console.log("[gap-drain-observer] discarded-landings report write failed (non-fatal):", err);
    }
    if (total === 0) return;
    try {
      const { resolveSubstrateGapWrite } = await import("../resolvers/substrate-gap.js");
      const day = new Date(now).toISOString().slice(0, 10);
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: `discarded-landings-${day}`,
          category: "systematic_failure",
          source: "substrate_detected",
          status: "open",
          summary: `${total} verified landing(s) discarded after passing every gate in the last hour (lease_refused=${byCause.lease_refused}, drain_killed=${byCause.drain_killed}, deferred=${byCause.deferred}, other=${byCause.other}): ${gapIds.slice(0, 5).join(", ")}`,
          detected_at: new Date(now).toISOString(),
          classification_metadata: { incident_kind: "discarded_landings", by_cause: byCause, gap_ids: gapIds.slice(0, 20) },
        },
      } as never);
    } catch (err) {
      console.log("[gap-drain-observer] discarded-landings gap write failed (non-fatal):", err);
    }
  }

  private recordDrain(entry: Record<string, unknown>): void {
    appendDrainLine(entry);
  }
}

function appendDrainLine(entry: Record<string, unknown>): void {
  try {
    const dir = join(WORKSPACE_ROOT, "pool");
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ...entry, recorded_at: new Date().toISOString() }) + "\n";
    appendFileSync(join(dir, "drain-log.jsonl"), line, "utf8");
  } catch (err) {
    console.log("[gap-drain-observer] recordDrain failed (non-fatal):", err);
  }
}
