import { describe, it, expect, beforeAll } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDispatchDroppedObserver } from "../../src/resolvers/dispatch-dropped-observer.js";

const dir = join(tmpdir(), `dev-vessel-dispatch-dropped-${Date.now()}`);
const logPath = join(dir, "dispatch-dropped.jsonl");

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const rows = [
    { reason: "queue_overflow", ts: now - 5_000 },
    { reason: "queue_overflow", ts: now - 4_000 },
    { reason: "byte_overflow", ts: now - 3_000 },
    { reason: "queue_overflow", at: new Date(now - 2_000).toISOString() },
    // very old row outside default window
    { reason: "timeout_exceeded", ts: now - 24 * 3600 * 1000 - 1000 },
  ];
  writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
});

describe("dispatch_dropped_observer", () => {
  it("aggregates recent-window drop counts and dominant reason", async () => {
    const result = await resolveDispatchDroppedObserver({
      type: "dispatch_dropped_observer",
      logPath,
    });
    expect(result.shape).toBe("dispatchDroppedHistory");
    const body = result.body as {
      log_present: boolean;
      total_drops: number;
      recent_drops: number;
      recent_dominant_reason: string;
      recent_reason_counts: Record<string, number>;
    };
    expect(body.log_present).toBe(true);
    expect(body.total_drops).toBe(5);
    expect(body.recent_drops).toBe(4);
    expect(body.recent_dominant_reason).toBe("queue_overflow");
    expect(body.recent_reason_counts["queue_overflow"]).toBe(3);
    expect(body.recent_reason_counts["byte_overflow"]).toBe(1);
  });

  it("respects a smaller recent window", async () => {
    const result = await resolveDispatchDroppedObserver({
      type: "dispatch_dropped_observer",
      logPath,
      recentWindowMs: 2_500,
    });
    const body = result.body as { recent_drops: number };
    expect(body.recent_drops).toBeLessThanOrEqual(2);
  });

  it("degrades to log_present=false when the file is absent", async () => {
    const result = await resolveDispatchDroppedObserver({
      type: "dispatch_dropped_observer",
      logPath: join(tmpdir(), `dispatch-missing-${Date.now()}.jsonl`),
    });
    const body = result.body as { log_present: boolean; total_drops: number; recent_drops: number };
    expect(body.log_present).toBe(false);
    expect(body.total_drops).toBe(0);
    expect(body.recent_drops).toBe(0);
  });
});
