import { WORKSPACE_ROOT } from "../config.js";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const ACTIVITY_API_URL = process.env["ACTIVITY_API_URL"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const DEV_VESSEL_ENDPOINT = process.env["DEV_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8090";

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

  private async handleGapWritten(data: Record<string, unknown>): Promise<void> {
    const gapId = typeof data["gap_id"] === "string" ? (data["gap_id"] as string) : "";
    const category = typeof data["category"] === "string" ? (data["category"] as string) : "unknown";
    const route = data["route"];
    const remedy = data["remedy"] as { vessel?: string; impulse_type?: string; goal?: string } | undefined;
    const status = data["status"];
    if (status !== undefined && status !== "open") return;
    if (route !== "dispatchable") return;
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
    g.__drainInflight.add(category);
    const startedAt = Date.now();
    try {
      const resp = await fetch("http://127.0.0.1:8090/v2/impulses/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ impulse: { type: remedy.impulse_type, triggered_by: "gap-drain", gap_id: gapId } }),
        signal: AbortSignal.timeout(120000),
      });
      this.recordDrain({ action: "dispatched", gap_id: gapId, category, impulse_type: remedy.impulse_type, ok: resp.ok, http_status: resp.status, latency_ms: Date.now() - startedAt });
    } catch (err) {
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
