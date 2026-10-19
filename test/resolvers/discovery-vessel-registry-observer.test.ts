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
    expect(body.stale_threshold_ms).toBe(3 * 60 * 1000);
  });
});

// A LOCAL-REGISTRATION CHECK (vessel_ids). The gap a running-but-unregistered vessel gets must be armed with a check
// the class-2 judge can read: the judge reads only TOP-LEVEL fields of the body, so the answer is a top-level
// missing_count, re-measured on every read. Rows below mirror the live registry's id forms: a "-local" suffix, a bare
// id, federated "@peer" copies, and a remote host's suffixless row.
describe("discovery_vessel_registry_observer vessel_ids", () => {
  const ROWS = [
    "activity-api-local", "activity-api-local@hub-a", "concept-db-local", "development-vessel-local",
    "development-vessel-local@hub-a", "llm-resolver-vessel", "llm-resolver-google", "relevance-sink-vessel",
    "federation-transport-vessel@spoke-b", "identity-vessel@hub-a", "ribosome-vessel@hub-a",
  ];
  const withRegistry = async <T>(fn: () => Promise<T>): Promise<T> => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ content: { vessels: ROWS.map((vesselId) => ({ vesselId, lastSeen: new Date().toISOString(), shapes: ["x"] })) } })) as unknown as typeof fetch;
    try { return await fn(); } finally { globalThis.fetch = real; }
  };
  const read = (vessel_ids?: string[]) => withRegistry(async () =>
    (await resolveDiscoveryVesselRegistryObserver({ type: "discovery_vessel_registry_observer", endpoint: "http://registry.test", apiKey: "k", ...(vessel_ids ? { vessel_ids } : {}) })).body as Record<string, unknown>);

  it("must-fail: a vessel with no local row is missing (an @peer-only match counts as missing)", async () => {
    expect(await read(["ribosome-vessel"])).toMatchObject({ missing_count: 1, missing_vessels: ["ribosome-vessel"] });
    expect(await read(["identity-vessel"])).toMatchObject({ missing_count: 1, missing_vessels: ["identity-vessel"] });
    expect(await read(["ribosome-vessel", "identity-vessel", "activity-api"])).toMatchObject({ missing_count: 2, missing_vessels: ["identity-vessel", "ribosome-vessel"] });
  });

  it("control: a registered vessel is not missing, by id or by a '-' extension of it", async () => {
    expect(await read(["activity-api", "concept-db", "llm-resolver-vessel", "relevance-sink-vessel", "development-vessel"])).toMatchObject({ missing_count: 0, missing_vessels: [] });
    // llm-resolver-google is another vessel, not an extension of llm-resolver-vessel.
    expect(await read(["llm-resolver"])).toMatchObject({ missing_count: 0 });
    expect(await read(["llm-resolver-vessel-x"])).toMatchObject({ missing_count: 1 });
  });

  it("control: without vessel_ids the body carries exactly the fields it always did", async () => {
    const body = await read();
    expect(Object.keys(body).sort()).toEqual([
      "endpoint", "generated_at", "healthy_count", "per_vessel", "reachable", "roundtrip_ms", "stale_count", "stale_threshold_ms", "total_vessels",
    ]);
  });

  it("an unreachable registry carries no missing_count (unmeasured, never 'none missing')", async () => {
    const r = await resolveDiscoveryVesselRegistryObserver({ type: "discovery_vessel_registry_observer", endpoint: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 500, vessel_ids: ["ribosome-vessel"] });
    expect((r.body as Record<string, unknown>)["reachable"]).toBe(false);
    expect("missing_count" in (r.body as Record<string, unknown>)).toBe(false);
  });
});

// stale_count was ~0 by construction: discovery prunes a row 5 min after its last heartbeat, and the default threshold
// here was also 5 min, so a row was deleted before it could read stale. The default is now under the prune TTL.
describe("discovery_vessel_registry_observer stale threshold", () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const readWith = async (rows: Array<{ vesselId: string; lastSeen: string }>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ content: { vessels: rows } })) as unknown as typeof fetch;
    try {
      return (await resolveDiscoveryVesselRegistryObserver({ type: "discovery_vessel_registry_observer", endpoint: "http://registry.test", apiKey: "k" })).body as Record<string, unknown>;
    } finally { globalThis.fetch = real; }
  };

  it("must-fail: a row that missed its heartbeats but is not yet pruned (4 min old) reads stale", async () => {
    const body = await readWith([{ vesselId: "late-vessel", lastSeen: at(4 * 60_000) }]);
    expect(body["stale_count"]).toBe(1);
    expect((body["stale_threshold_ms"] as number) < 5 * 60_000).toBe(true);
  });

  it("control: a row heartbeating on discovery's advised 2-min interval reads healthy", async () => {
    const body = await readWith([{ vesselId: "ok-a", lastSeen: at(30_000) }, { vesselId: "ok-b", lastSeen: at(2 * 60_000 + 10_000) }]);
    expect(body["stale_count"]).toBe(0);
    expect(body["healthy_count"]).toBe(2);
  });
});
