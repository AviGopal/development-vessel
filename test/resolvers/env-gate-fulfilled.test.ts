import { describe, expect, test } from "bun:test";
import { resolveEnvGateFulfilled } from "../../src/resolvers/env-gate-fulfilled.js";

describe("resolveEnvGateFulfilled", () => {
  test("returns env_gate_fulfilled shape on success", async () => {
    const result = await resolveEnvGateFulfilled({});
    expect(result.shape).toBe("env_gate_fulfilled");
    expect(result).toHaveProperty("body");
  });
});
