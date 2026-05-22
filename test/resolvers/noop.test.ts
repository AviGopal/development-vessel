import { describe, it, expect } from "bun:test";
import { resolveNoop } from "../../src/resolvers/noop.js";

describe("resolveNoop", () => {
  it("returns commandResult shape", async () => {
    const result = await resolveNoop({ type: "noop" });
    expect(result.shape).toBe("commandResult");
  });

  it("body.success is true and body.noop is true", async () => {
    const result = await resolveNoop({ type: "noop" });
    const body = result.body as { success: boolean; noop: boolean };
    expect(body.success).toBe(true);
    expect(body.noop).toBe(true);
  });

  it("is idempotent — two calls return identical shapes", async () => {
    const r1 = await resolveNoop({ type: "noop" });
    const r2 = await resolveNoop({ type: "noop" });
    expect(r1.shape).toBe(r2.shape);
    expect(JSON.stringify(r1.body)).toBe(JSON.stringify(r2.body));
  });
});
