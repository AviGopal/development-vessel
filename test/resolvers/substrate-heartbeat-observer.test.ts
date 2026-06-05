import { describe, it, expect, beforeAll } from "bun:test";
import { writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubstrateHeartbeatObserver } from "../../src/resolvers/substrate-heartbeat-observer.js";

const dir = join(tmpdir(), `dev-vessel-heartbeat-${Date.now()}`);
const freshPath = join(dir, "substrate-heartbeat-fresh.json");
const stalePath = join(dir, "substrate-heartbeat-stale.json");

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    freshPath,
    JSON.stringify({ ts: new Date().toISOString(), overall_passing: true, template_count: 100, vessels_down: [] }),
  );
  writeFileSync(stalePath, JSON.stringify({ ts: "2026-01-01T00:00:00Z", overall_passing: false }));
  // Force stale mtime ~ 1 hour ago
  const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(stalePath, oneHourAgo, oneHourAgo);
});

describe("substrate_heartbeat_observer", () => {
  it("reads a fresh heartbeat and reports stale=false", async () => {
    const result = await resolveSubstrateHeartbeatObserver({
      type: "substrate_heartbeat_observer",
      heartbeatPath: freshPath,
    });
    expect(result.shape).toBe("substrateHeartbeatState");
    const body = result.body as {
      file_present: boolean;
      stale: boolean;
      age_seconds: number;
      contents_summary: Record<string, unknown>;
    };
    expect(body.file_present).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.age_seconds).toBeLessThan(60);
    expect(body.contents_summary["overall_passing"]).toBe(true);
    expect(body.contents_summary["template_count"]).toBe(100);
  });

  it("reports stale=true when the file mtime is older than the threshold", async () => {
    const result = await resolveSubstrateHeartbeatObserver({
      type: "substrate_heartbeat_observer",
      heartbeatPath: stalePath,
      staleThresholdMs: 5 * 60 * 1000,
    });
    const body = result.body as { file_present: boolean; stale: boolean; age_seconds: number };
    expect(body.file_present).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.age_seconds).toBeGreaterThan(60);
  });

  it("degrades to file_present=false with stale=true when file is absent", async () => {
    const result = await resolveSubstrateHeartbeatObserver({
      type: "substrate_heartbeat_observer",
      heartbeatPath: join(dir, `nope-${Date.now()}.json`),
    });
    const body = result.body as {
      file_present: boolean;
      stale: boolean;
      age_seconds: number | null;
      contents_summary: Record<string, unknown> | null;
    };
    expect(body.file_present).toBe(false);
    expect(body.stale).toBe(true);
    expect(body.age_seconds).toBeNull();
    expect(body.contents_summary).toBeNull();
  });
});
