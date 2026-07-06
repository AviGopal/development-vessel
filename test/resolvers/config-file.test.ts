import { describe, it, expect } from "bun:test";
import { resolveConfigFile } from "../../src/resolvers/config-file.js";

describe("resolveConfigFile", () => {
  it("returns shape config_file", async () => {
    const result = await resolveConfigFile({ type: "config_file" });
    expect(result.shape).toBe("config_file");
  });

  it("body has summary with discoveryStatus field", async () => {
    const result = await resolveConfigFile({ type: "config_file" });
    const body = result.body as Record<string, unknown>;
    expect(body).toHaveProperty("summary");
    const summary = body["summary"] as Record<string, unknown>;
    expect(typeof summary["discoveryStatus"]).toBe("string");
  });

  it("body has environment array", async () => {
    const result = await resolveConfigFile({ type: "config_file" });
    const body = result.body as Record<string, unknown>;
    expect(Array.isArray(body["environment"])).toBe(true);
  });

  it("body has registeredVessels array", async () => {
    const result = await resolveConfigFile({ type: "config_file" });
    const body = result.body as Record<string, unknown>;
    expect(Array.isArray(body["registeredVessels"])).toBe(true);
  });

  it("body has updateProgress with description", async () => {
    const result = await resolveConfigFile({ type: "config_file" });
    const body = result.body as Record<string, unknown>;
    const up = body["updateProgress"] as Record<string, unknown>;
    expect(typeof up["description"]).toBe("string");
    expect((up["description"] as string).length).toBeGreaterThan(0);
  });

  it("passes requestedShape from pointer", async () => {
    const result = await resolveConfigFile({ type: "config_file", shape: "config_file" });
    const body = result.body as Record<string, unknown>;
    expect(body["requestedShape"]).toBe("config_file");
  });
});
