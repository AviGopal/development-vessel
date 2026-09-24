import { WORKSPACE_ROOT } from "../config.js";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";

const ACTIVITY_API_URL = process.env["ACTIVITY_API_URL"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const DEV_VESSEL_ENDPOINT = process.env["DEV_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8090"; // env-overridable dev-vessel base URL

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
    if (!extHasImpulse && (extTemplateId !== "" || extGoal !== "")) {
      const g2 = globalThis as unknown as { __drainInflight?: Set<string> };
      g2.__drainInflight ??= new Set<string>();
      if (g2.__drainInflight.has(category) || g2.__drainInflight.size >= 2) {
        this.recordDrain({ action: "skipped_inflight", gap_id: gapId, category });
        return;
      }
      g2.__drainInflight.add(category);
      const t0 = Date.now();
      try {
        const goalHostUrl = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
        const runGoalBody = extTemplateId !== ""
          ? { targetTemplateId: extTemplateId, variables: { gap_id: gapId, triggered_by: "gap-drain" } }
          : { goal: extGoal };
        const ghResp = await fetch(goalHostUrl + "/run-goal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(runGoalBody),
          signal: AbortSignal.timeout(120000),
        });
        this.recordDrain({ action: "dispatched", gap_id: gapId, category, remedy: extTemplateId !== "" ? extTemplateId : extGoal, ok: ghResp.ok, http_status: ghResp.status, latency_ms: Date.now() - t0 });
      } catch (err) {
        this.recordDrain({ action: "dispatch_failed", gap_id: gapId, category, error: String(err), latency_ms: Date.now() - t0 });
      } finally {
        g2.__drainInflight.delete(category);
      }
      return;
    }
    if (!remedy || typeof remedy.impulse_type !== "string" || remedy.impulse_type.length === 0) return;
    const gd = globalThis as any;
    gd.__drainBackoff ??= new Map();
    const boEntry = gd.__drainBackoff.get(gapId);
    if (boEntry && Date.now() < boEntry.until) { return; }
    const g = globalThis as unknown as { __drainInflight?: Set<string> };
    g.__drainInflight ??= new Set<string>();
    if (g.__drainInflight.has(category) || g.__drainInflight.size >= 2) {
      this.recordDrain({ action: "skipped_inflight", gap_id: gapId, category });
      return;
    }
    try {
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
    const DRAIN_BACKOFF_INITIAL_MS = 60000;
    const DRAIN_BACKOFF_MAX_MS = 3600000;
    g.__drainInflight.add(category);
    const startedAt = Date.now();
    try {
      const resp = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, { // env-overridable
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ impulse: { type: remedy.impulse_type, triggered_by: "gap-drain", gap_id: gapId } }),
        signal: AbortSignal.timeout(120000),
      });
      if (resp.ok) {
        gd.__drainBackoff.delete(gapId);
      } else {
        const prev = gd.__drainBackoff.get(gapId);
        const attempts = (prev?.attempts ?? 0) + 1;
        const delay = Math.min(DRAIN_BACKOFF_INITIAL_MS * 2 ** (attempts - 1), DRAIN_BACKOFF_MAX_MS);
        gd.__drainBackoff.set(gapId, { until: Date.now() + delay, attempts });
      }
      this.recordDrain({ action: "dispatched", gap_id: gapId, category, impulse_type: remedy.impulse_type, ok: resp.ok, http_status: resp.status, latency_ms: Date.now() - startedAt });
    } catch (err) {
      const prev = gd.__drainBackoff.get(gapId);
      const attempts = (prev?.attempts ?? 0) + 1;
      const delay = Math.min(DRAIN_BACKOFF_INITIAL_MS * 2 ** (attempts - 1), DRAIN_BACKOFF_MAX_MS);
      gd.__drainBackoff.set(gapId, { until: Date.now() + delay, attempts });
      this.recordDrain({ action: "dispatch_failed", gap_id: gapId, category, impulse_type: remedy.impulse_type, error: String(err), latency_ms: Date.now() - startedAt });
    } finally {
      g.__drainInflight.delete(category);
    }
  }

  private async handleExecutionCompleted(): Promise<void> {
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
    try {
      const dir = join(WORKSPACE_ROOT, "pool");
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ ...entry, recorded_at: new Date().toISOString() }) + "\n";
      appendFileSync(join(dir, "drain-log.jsonl"), line, "utf8");
    } catch (err) {
      console.log("[gap-drain-observer] recordDrain failed (non-fatal):", err);
    }
  }
}
