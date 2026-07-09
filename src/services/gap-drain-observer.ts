import { WORKSPACE_ROOT } from "../config.js";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const ACTIVITY_API_URL = process.env["ACTIVITY_API_URL"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

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

  private async handleGapWritten(_data: Record<string, unknown>): Promise<void> {
    // Behavior wired in a follow-up change-set.
  }

  private async handleExecutionCompleted(): Promise<void> {
    // Behavior wired in a follow-up change-set.
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
