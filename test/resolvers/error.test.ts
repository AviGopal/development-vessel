import { resolveError } from "../../src/resolvers/error.js";
import { describe, expect, test } from "bun:test";

describe("resolveError", () => {
  test("returns error shape with rows when traces exist", async () => {
    const res = await resolveError({ type: "error" });
    expect(res).toHaveProperty("shape", "error");
    expect(res.body).toHaveProperty("rows");
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  test("handles missing traces gracefully", async () => {
    const res = await resolveError({ type: "error" });
    expect(res).toHaveProperty("shape", "error");
    expect(res.body.rows).toEqual([]);
  });
});
