import { describe, it, expect } from "bun:test";
import { resolveDiscoveryVesselRegistryObserver } from "../../src/resolvers/discovery-vessel-registry-observer.js";

describe("discovery_vessel_registry_observer", () => {
  it("returns missing_api_key error when no key supplied and none in env", async () => {
    const result = await resolveDiscoveryVesselRegistryObserver({
      type: "discovery_vessel_registry_observer",
      endpoint: "http://127.0.0.1:1",
      apiKey: "",
      timeoutMs: 500,
    });
    expect(result.shape).toBe("discoveryRegistryState");
    const body = result.body as {
      reachable: boolean;
      error: string;
      total_vessels: number;
    };
    expect(body.reachable).toBe(false);
    expect(body.error).toBe("missing_api_key");
    expect(body.total_vessels).toBe(0);
  });

  it("degrades to reachable=false on unreachable endpoint", async () => {
    const result = await resolveDiscoveryVesselRegistryObserver({
      type: "discovery_vessel_registry_observer",
      endpoint: "http://127.0.0.1:1",
      apiKey: "fake-key",
      timeoutMs: 500,
    });
    const body = result.body as {
      reachable: boolean;
      error: string | null;
      total_vessels: number;
    };
    expect(body.reachable).toBe(false);
    expect(body.error).not.toBeNull();
  });

  it("emits a well-formed impulse on timeout to non-routable host", async () => {
    const result = await resolveDiscoveryVesselRegistryObserver({
      type: "discovery_vessel_registry_observer",
      endpoint: "http://192.0.2.1",
      apiKey: "fake-key",
      timeoutMs: 250,
    });
    const body = result.body as {
      reachable: boolean;
      generated_at: string;
      stale_threshold_ms: number;
    };
    expect(body.reachable).toBe(false);
    expect(typeof body.generated_at).toBe("string");
    expect(body.stale_threshold_ms).toBe(5 * 60 * 1000);
  });
});
