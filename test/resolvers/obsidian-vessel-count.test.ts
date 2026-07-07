import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { resolveObsidianVesselCount } from "../../src/resolvers/obsidian-vessel-count.js";

describe("resolveObsidianVesselCount", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns obsidian:vessel_count shape with correct count when discovery returns vessels", async () => {
    const mockVessels = [
      { vesselId: "obsidian-vessel-1", vesselName: "obsidian-vessel", status: "active", endpoint: "http://localhost:8300", shapes: ["obsidian_command_gate", "obsidian_reflect"] },
      { vesselId: "obsidian-vessel-2", vesselName: "obsidian-secondary", status: "active", endpoint: "http://localhost:8301", shapes: ["obsidian_learn_commands"] },
      { vesselId: "development-vessel-local", vesselName: "development-vessel", status: "active", endpoint: "http://localhost:8090", shapes: ["git_status"] },
    ];

    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ vessels: mockVessels }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await resolveObsidianVesselCount({ type: "obsidian:vessel_count" });

    expect(result.shape).toBe("obsidian:vessel_count");
    const body = result.body as Record<string, unknown>;
    expect(body["obsidian_vessel_count"]).toBe(2);
    expect(body["total_registered_vessels"]).toBe(3);
    const vessels = body["vessels"] as Array<Record<string, unknown>>;
    expect(vessels.length).toBe(2);
    expect(vessels[0]?.["vesselId"]).toBe("obsidian-vessel-1");
    expect(body["fetch_error"]).toBeNull();
  });

  it("handles bare array response from discovery", async () => {
    const mockVessels = [
      { vesselId: "obsidian-primary", vesselName: "obsidian-primary", status: "active", endpoint: "http://localhost:8300", shapes: [] },
    ];

    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify(mockVessels), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await resolveObsidianVesselCount({ type: "obsidian:vessel_count" });

    expect(result.shape).toBe("obsidian:vessel_count");
    const body = result.body as Record<string, unknown>;
    expect(body["obsidian_vessel_count"]).toBe(1);
    expect(body["total_registered_vessels"]).toBe(1);
  });

  it("returns zero count and records fetch_error when discovery is unreachable", async () => {
    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8100");
    }) as typeof fetch;

    const result = await resolveObsidianVesselCount({ type: "obsidian:vessel_count" });

    expect(result.shape).toBe("obsidian:vessel_count");
    const body = result.body as Record<string, unknown>;
    expect(body["obsidian_vessel_count"]).toBe(0);
    expect(body["total_registered_vessels"]).toBe(0);
    expect(typeof body["fetch_error"]).toBe("string");
  });

  it("returns zero count when discovery returns non-2xx", async () => {
    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response("Service Unavailable", { status: 503 });
    }) as typeof fetch;

    const result = await resolveObsidianVesselCount({ type: "obsidian:vessel_count" });

    expect(result.shape).toBe("obsidian:vessel_count");
    const body = result.body as Record<string, unknown>;
    expect(body["obsidian_vessel_count"]).toBe(0);
    expect(body["fetch_error"]).toContain("503");
  });

  it("counts vessels by vesselName containing obsidian (case-insensitive)", async () => {
    const mockVessels = [
      { vesselId: "vessel-abc", vesselName: "Obsidian-Plugin-Vessel", status: "active", endpoint: "http://localhost:8302", shapes: [] },
      { vesselId: "vessel-xyz", vesselName: "other-vessel", status: "active", endpoint: "http://localhost:8303", shapes: [] },
    ];

    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ vessels: mockVessels }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await resolveObsidianVesselCount({ type: "obsidian:vessel_count" });
    const body = result.body as Record<string, unknown>;
    expect(body["obsidian_vessel_count"]).toBe(1);
  });
});
