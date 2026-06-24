import { describe, it, expect } from "bun:test";
import { resolveEmitShape } from "../../src/resolvers/emit-shape.js";

describe("resolveEmitShape", () => {
  it("emits an impulse of the configured shape with rung + content echoed", async () => {
    const result = await resolveEmitShape({ type: "emit_shape", shape: "lw_s5", rung: 5 });
    expect(result.shape).toBe("lw_s5");
    const body = result.body as { emitted: string; rung: number | null; content: unknown };
    expect(body.emitted).toBe("lw_s5");
    expect(body.rung).toBe(5);
    expect(body.content).toBeNull();
  });

  it("passes arbitrary content through", async () => {
    const result = await resolveEmitShape({ type: "emit_shape", shape: "lw_s2", content: { x: 1 } });
    const body = result.body as { content: unknown };
    expect(result.shape).toBe("lw_s2");
    expect(body.content).toEqual({ x: 1 });
  });

  it("returns structuredError when shape is missing", async () => {
    const result = await resolveEmitShape({ type: "emit_shape" });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { error: string };
    expect(body.error).toContain("emit_shape requires pointer.shape");
  });
});
