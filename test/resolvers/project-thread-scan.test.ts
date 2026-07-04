import { describe, it, expect } from "bun:test";
import { resolveProjectThreadScan } from "../../src/resolvers/project-thread-scan.js";

describe("project_thread_scan resolver", () => {
  it("returns a well-formed result for the projectThreadScanReport shape", async () => {
    const r = await resolveProjectThreadScan({ type: "project_thread_scan" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
