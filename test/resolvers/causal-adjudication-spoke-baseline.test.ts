import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { stampEnvironmentBaseline } from "../../src/resolvers/causal-adjudication.js";

/**
 * ON A SPOKE THE LEARNING STORE IS THE HUB'S, SO THE LOCAL DATABASE CALL FAILS ON EVERY PICK.
 *
 * stampEnvironmentBaseline wrote its row with a direct surreal() call. Where that database is not
 * local, every pick returned "failed" and lost its counterfactual (38 of 38 on one spoke), and the
 * log said only "env-baseline failed", with no cause. The baseline must still land, through the
 * poolImpulse shape this vessel serves on every node, and a failure must name its cause.
 */
const realFetch = globalThis.fetch;
let logs: string[] = [];
const realWarn = console.warn;
const realLog = console.log;

beforeEach(() => {
  // No test here may reach a real database: every network call fails.
  globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED (stub)"); }) as unknown as typeof fetch;
  logs = [];
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.log = realLog;
});

const failingDb = async () => null;

describe("stampEnvironmentBaseline on a node without the learning store", () => {
  it("stamps through the routed pool writer when the local database is unreachable", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const actionId = `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const out = await stampEnvironmentBaseline("gap-spoke-1", actionId, {
      surreal: failingDb,
      routedWrite: (p) => { writes.push(p as Record<string, unknown>); return { ok: true, id: String(p.id) }; },
    });
    expect(out).toBe("stamped");
    expect(writes.length).toBe(1);
    expect(writes[0]!["shape"]).toBe("environmentBaseline");
    const body = writes[0]!["body"] as Record<string, unknown>;
    expect(body["gap_id"]).toBe("gap-spoke-1");
    expect(body["action_id"]).toBe(actionId);
    // The snapshot could not be read, so the reference is honestly absent.
    expect(body["baseline_snapshot_id"]).toBeNull();
  });

  it("names the cause when the routed write fails too", async () => {
    const actionId = `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const out = await stampEnvironmentBaseline("gap-spoke-2", actionId, {
      surreal: failingDb,
      routedWrite: () => ({ ok: false, id: "", error: "disk full" }),
    });
    expect(out).toBe("failed");
    const line = logs.find((l) => l.includes("env-baseline"));
    expect(line).toBeDefined();
    expect(line!).toContain("disk full");
  });
});
