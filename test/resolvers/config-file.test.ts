import { describe, it, expect, afterEach } from "bun:test";
import { resolveConfigFile } from "../../src/resolvers/config-file.js";

// HERMETIC. Each of these tests called resolveConfigFile() with no fetch stub, so every one hit
// the live discovery endpoint (8s resolver timeout vs bun's 5s test timeout) — under substrate
// load they failed as timeouts before reaching an assertion. The assertions were also
// existence-only (typeof string, Array.isArray), which an empty/unreachable discovery satisfies
// just as well as a healthy one, so they could not distinguish the states they name.
//
// discoveryStatus is the interesting output and has three distinct values the resolver is
// careful to separate — reachable / unreachable / error. Only "reachable" was ever exercised,
// and only when discovery happened to be up. All three are pinned below.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const stubJson = (body: unknown, status = 200): void => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  ) as unknown as typeof fetch;
};

const TWO_VESSELS = {
  vessels: [
    { vesselId: "development-vessel", endpoint: "http://127.0.0.1:8090", shapes: ["memoryNote", "config_file"], health: "healthy" },
    { vesselId: "concept-db", endpoint: "http://127.0.0.1:8260", shapes: ["concept"], health: "healthy" },
  ],
};

describe("resolveConfigFile", () => {
  it("returns shape config_file with environment and vessel sections", async () => {
    stubJson(TWO_VESSELS);
    const result = await resolveConfigFile({ type: "config_file" });
    expect(result.shape).toBe("config_file");
    const body = result.body as Record<string, any>;
    expect(Array.isArray(body["environment"])).toBe(true);
    expect(Array.isArray(body["registeredVessels"])).toBe(true);
    // the env section always reports the endpoints it resolved, regardless of reachability
    expect(body["environment"].map((e: any) => e.key)).toContain("DISCOVERY_ENDPOINT");
  });

  it("reports discoveryStatus=reachable and counts vessels and shapes", async () => {
    stubJson(TWO_VESSELS);
    const body = (await resolveConfigFile({ type: "config_file" })).body as Record<string, any>;
    expect(body["summary"]["discoveryStatus"]).toBe("reachable");
    expect(body["summary"]["registeredVesselCount"]).toBe(2);
    expect(body["registeredVessels"]).toHaveLength(2);
    expect(body["updateProgress"]["discoveryVesselReachable"]).toBe(true);
    expect(body["updateProgress"]["vesselCount"]).toBe(2);
  });

  it("reports discoveryStatus=unreachable when discovery answers non-ok", async () => {
    // fetchJson returns null on !res.ok — a reachable socket that refuses to serve is NOT
    // the same as a connection error, and the resolver distinguishes them.
    stubJson({}, 503);
    const body = (await resolveConfigFile({ type: "config_file" })).body as Record<string, any>;
    expect(body["summary"]["discoveryStatus"]).toBe("unreachable");
    expect(body["registeredVessels"]).toEqual([]);
    expect(body["updateProgress"]["discoveryVesselReachable"]).toBe(false);
  });

  it("reports discoveryStatus=error when the request itself throws", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const body = (await resolveConfigFile({ type: "config_file" })).body as Record<string, any>;
    expect(body["summary"]["discoveryStatus"]).toBe("error");
    expect(body["registeredVessels"]).toEqual([]);
    // still a well-formed config_file — an unreachable discovery must not break the report
    expect(Array.isArray(body["environment"])).toBe(true);
  });

  it("tolerates a bare array of vessels as well as {vessels:[...]}", async () => {
    stubJson([{ vesselId: "solo-vessel", endpoint: "http://127.0.0.1:9000", shapes: [], health: "healthy" }]);
    const body = (await resolveConfigFile({ type: "config_file" })).body as Record<string, any>;
    expect(body["summary"]["discoveryStatus"]).toBe("reachable");
    expect(body["registeredVessels"]).toHaveLength(1);
  });
});
