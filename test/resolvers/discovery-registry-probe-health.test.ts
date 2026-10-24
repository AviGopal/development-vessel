// THE DISCOVERY-ENDPOINTS-HEALTHY JOINT'S READING IS A TOP-LEVEL NUMBER ON THE REGISTRY OBSERVER
// (discovery-vessel-registry-observer.ts AN ENDPOINT-HEALTH CHECK). The joint-liveness detector arms a joint only when
// its binding's check { shape, input, field } reads a finite number, and the class-2 judge reads only top-level fields.
// The observer read the registry but never asked a registered endpoint whether it answers, so the joint could not arm.
// With probe_health: true it probes each endpoint's /health (2 s, 4 at a time) and answers unanswered_count; without
// it the body is exactly what it was.
// MUST-FAIL on the parent: the observer returns no unanswered_count and its contract does not declare it.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "disc-probe-health-"));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
const { resolveDiscoveryVesselRegistryObserver } = await import("../../src/resolvers/discovery-vessel-registry-observer.js");
const { checkArmingProblem, responseFields } = await import("../../src/resolvers/substrate-gap.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

type Health = number | "hang" | "throw";
/** A registry at registry.test listing `rows`; each endpoint's /health answers per `health` (default 200). */
const serve = (rows: Array<{ vesselId: string; endpoint?: string }>, health: Record<string, Health> = {}, seen?: { inFlight: number; max: number; auth: number }) => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("http://registry.test")) return Response.json({ content: { vessels: rows.map((r) => ({ ...r, lastSeen: new Date().toISOString(), shapes: ["x"] })) } });
    const host = new URL(url).host;
    const h = health[host] ?? 200;
    if (seen) { seen.inFlight++; seen.max = Math.max(seen.max, seen.inFlight); if (new Headers(init?.headers).has("authorization")) seen.auth++; }
    try {
      if (h === "throw") throw new Error("connection refused");
      if (h === "hang") {
        await new Promise((res, rej) => { const t = setTimeout(res, 10_000); init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }); });
        return new Response("late");
      }
      await new Promise((res) => setTimeout(res, 20));
      return new Response("ok", { status: h });
    } finally { if (seen) seen.inFlight--; }
  }) as unknown as typeof fetch;
};
const read = async (extra: Record<string, unknown> = {}) =>
  (await resolveDiscoveryVesselRegistryObserver({ type: "discovery_vessel_registry_observer", endpoint: "http://registry.test", apiKey: "k", ...extra } as never)).body as Record<string, unknown>;

const ROWS = [
  { vesselId: "a-local", endpoint: "http://a.test" }, { vesselId: "b-local", endpoint: "http://b.test/" },
  { vesselId: "c-local", endpoint: "http://c.test" }, { vesselId: "no-endpoint" },
];

describe("discovery_vessel_registry_observer probe_health (the discovery-endpoints-healthy joint)", () => {
  it("must-fail: endpoints that refuse, answer non-2xx or hang past the timeout are unanswered", async () => {
    serve(ROWS, { "a.test": "throw", "b.test": 503, "c.test": "hang" });
    const t0 = Date.now();
    const b = await read({ probe_health: true });
    expect(b["unanswered_count"]).toBe(3);
    expect(b["unanswered"]).toEqual(["a-local@http://a.test (no answer)", "b-local@http://b.test (http 503)", "c-local@http://c.test (no answer)"]);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 10_000);

  it("must-fail: every endpoint answering reads unanswered_count 0 (zero when healthy); a row with no endpoint is not probed", async () => {
    serve(ROWS);
    expect(await read({ probe_health: true })).toMatchObject({ unanswered_count: 0, unanswered: [] });
  });

  it("probes at most 4 at a time, with no credential", async () => {
    const seen = { inFlight: 0, max: 0, auth: 0 };
    serve(Array.from({ length: 12 }, (_, i) => ({ vesselId: `v${i}`, endpoint: `http://v${i}.test` })), {}, seen);
    expect((await read({ probe_health: true }))["unanswered_count"]).toBe(0);
    expect(seen.max).toBeLessThanOrEqual(4);
    expect(seen.max).toBeGreaterThan(1);
    expect(seen.auth).toBe(0);
  });

  it("must-fail: the response contract declares unanswered_count and needs probe_health: true for it", async () => {
    serve(ROWS, { "b.test": 500 });
    for (const k of Object.keys(await read({ probe_health: true }))) expect(responseFields("discovery_vessel_registry_observer") ?? []).toContain(k);
    const er = (input: Record<string, unknown>) => ({ shape: "discovery_vessel_registry_observer", input, zero_field: "unanswered_count" });
    expect(checkArmingProblem(er({ probe_health: true }))).toBeNull();
    expect(checkArmingProblem(er({}))?.position).toBe("evidence_resolve.zero_field");
    expect(checkArmingProblem(er({ probe_health: false }))?.position).toBe("evidence_resolve.input.probe_health");
  });

  it("control: without probe_health the body carries exactly the fields it always did, and no endpoint is probed", async () => {
    const seen = { inFlight: 0, max: 0, auth: 0 };
    serve(ROWS, {}, seen);
    const b = await read();
    expect(Object.keys(b).sort()).toEqual([
      "endpoint", "generated_at", "healthy_count", "per_vessel", "reachable", "roundtrip_ms", "stale_count", "stale_threshold_ms", "total_vessels",
    ]);
    expect(seen.max).toBe(0);
    // the existing local-registration check is unchanged beside it
    expect(await read({ vessel_ids: ["a"] })).toMatchObject({ missing_count: 0 });
    expect(checkArmingProblem({ shape: "discovery_vessel_registry_observer", input: { vessel_ids: ["a"] }, zero_field: "missing_count" })).toBeNull();
  });

  it("an unreachable registry probes nothing and carries no unanswered_count (unmeasured)", async () => {
    globalThis.fetch = originalFetch;
    const r = await resolveDiscoveryVesselRegistryObserver({ type: "discovery_vessel_registry_observer", endpoint: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 500, probe_health: true } as never);
    expect("unanswered_count" in (r.body as Record<string, unknown>)).toBe(false);
  });
});
