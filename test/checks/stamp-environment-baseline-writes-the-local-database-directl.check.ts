import { describe, it, expect } from "bun:test";
import * as mod from "../../src/resolvers/causal-adjudication";

// Reproduces the defect shape: stampEnvironmentBaseline uses a direct local surreal() call
// to write the environmentBaseline row instead of routing the shape, so when the learning
// store is unreachable the write fails (logs "env-baseline failed").
// This test sets up a surreal stub that:
// - returns an empty result for the duplicate check (so it does NOT trigger the routed fallback),
// - returns a fresh operationalStateSnapshot (so no seeding/import path is touched),
// - returns null for the INSERT of the environmentBaseline (simulating the unreachable local DB),
// which yields the defective return value "failed". The assertion expects the correct behaviour
// (routing -> "stamped"), so it FAILS and documents the bug.

describe("causal-adjudication.stampEnvironmentBaseline defect reproduction", () => {
  it("fails when the local surreal() insert refuses the environmentBaseline write (should have routed)", async () => {
    const surrealStub = async (body: string): Promise<Array<{ status?: string; result?: unknown }> | null> => {
      if (body.includes("SELECT id FROM impulse WHERE shape = 'environmentBaseline'")) {
        // Duplicate check: reachable query, no existing baseline for this action
        return [{ status: "OK", result: [] }];
      }
      if (body.includes("SELECT id, created_at FROM impulse WHERE shape = 'operationalStateSnapshot'")) {
        // Provide a fresh snapshot so seeding and its dynamic import are not invoked
        return [{ status: "OK", result: [{ id: "impulse:opstate:1", created_at: new Date().toISOString() }] }];
      }
      if (body.includes("INSERT INTO impulse") && body.includes("shape: 'environmentBaseline'")) {
        // Simulate the direct write failing because the local learning store is unreachable
        return null;
      }
      return [{ status: "OK", result: [] }];
    };

    const result = await mod.stampEnvironmentBaseline("gap-123", "action-abc", { surreal: surrealStub });

    // Expect the correct behaviour (routed write -> stamped). The current defective path returns
    // "failed" after attempting a direct local write, so this assertion FAILS and captures the bug.
    expect(result).toBe("stamped");
  });
});
