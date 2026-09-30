// The shaped-policy readers (autonomy scope, spend envelope) and the rhythm-conductor's presence
// check look producers up through the shared discovery client. A discovery lookup that could not be
// answered (a slow peer made discovery miss the client's budget) must read as UNREADABLE, never as
// "no producer"; it must not stick for 30 s; the fail-closed decision must survive; and a withhold
// caused only by an unreadable scope must not be recorded as semantic_reject.
//
// Driven through the real readers with globalThis.fetch standing in for discovery and the pool
// (the shared client calls globalThis.fetch at call time); Date is advanced with setSystemTime.
import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autonomyScope,
  autonomyScopeFloor,
  spendEnvelopeAllows,
  __resetPolicyReadsForTests,
} from "../../src/resolvers/gap-to-feature.js";
import { composeLessonClass } from "../../src/resolvers/feature-compose.js";
import { resolveRhythmConductorTick } from "../../src/resolvers/rhythm-conductor-tick.js";
import * as config from "../../src/config.js";
import { __setDiscoveryForTests, lookupShape } from "../../src/config.js";
import { HttpDiscoveryAdapter, FetchAdapter } from "@avigopal/ias-executor-ts/adapters";

const originalFetch = globalThis.fetch;
const POOL = "http://node-a:18090/v2/impulses/resolve";
type Discovery = "timeout" | "network" | "empty" | "producer";
let discoveryMode: Discovery = "producer";
let discoveryCalls = 0;
let fetchCalls = 0; // every request, to any address
let poolRecords: Array<Record<string, unknown>> = [];
let now = Date.parse("2026-09-30T21:00:00Z");

function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    fetchCalls++;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      discoveryCalls++;
      // What AbortSignal.timeout delivers when discovery is still waiting on a slow peer.
      if (discoveryMode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (discoveryMode === "network") throw new TypeError("Unable to connect. Is the computer able to access the url?");
      const vessels = discoveryMode === "empty" ? [] : [{ vesselId: "development-vessel-local", endpoint: "http://node-a:18090", resolve_endpoint: "/v2/impulses/resolve" }];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: vessels.length > 0 } });
    }
    if (url === POOL && body?.impulse?.type === "poolImpulse") {
      const shape = body.impulse.shape;
      return Response.json({ body: { impulses: poolRecords.filter((r) => r["shape"] === shape) } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  now = Date.parse("2026-09-30T21:00:00Z");
  setSystemTime(new Date(now));
  __resetPolicyReadsForTests();
  discoveryCalls = 0;
  fetchCalls = 0;
  discoveryMode = "producer";
  poolRecords = [];
  install();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
});
const advance = (ms: number) => { now += ms; setSystemTime(new Date(now)); };
const SCOPE = { shape: "autonomyScope", updated_at: "2026-09-30T20:00:00Z", body: { excluded_paths: ["repos/development-vessel/src/resolvers/feature-compose.ts"] } };

describe("autonomy scope read through the shared discovery client", () => {
  it("a discovery lookup that times out is unreadable because the LOOKUP failed, not 'no producer'", async () => {
    discoveryMode = "timeout";
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(s.lookup_failed).toBe(true);
    expect(s.reason).toContain("poolImpulse lookup failed (timeout)");
    expect(s.reason).not.toContain("no poolImpulse producer");
  });

  it("a real empty discovery answer is 'no poolImpulse producer', not a lookup failure", async () => {
    discoveryMode = "empty";
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(s.lookup_failed).toBeUndefined();
    expect(s.reason).toBe("no poolImpulse producer discovered");
  });

  it("an unreadable scope is not held for 30 s: after the short backoff the next read re-dials and reads the record", async () => {
    discoveryMode = "timeout";
    expect((await autonomyScope()).readable).toBe(false);
    discoveryMode = "producer";
    poolRecords = [SCOPE];
    advance(2_500); // past the failure backoff, far inside the 30 s answer TTL
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(s.excluded).toEqual(["repos/development-vessel/src/resolvers/feature-compose.ts"]);
  });

  it("once a record was seen, an unreadable scope still fails closed, and the floor names it an environment condition", async () => {
    poolRecords = [SCOPE];
    expect((await autonomyScope()).readable).toBe(true);
    discoveryMode = "timeout";
    advance(31_000);
    const s = await autonomyScope();
    const floor = autonomyScopeFloor(s, ["repos/boredom-vessel/src/index.ts"]); // a path the scope does NOT exclude
    expect(floor.hits.length).toBeGreaterThan(0); // fail closed: everything is excluded
    expect(floor.unreadable).toContain("discovery lookup failed");
    // The withhold is recorded as an environment class, not as a verdict on a clean draft.
    const clean = [{ ok: true }], verified = [{ ok: true, output: "TC_EXIT=0" }];
    expect(composeLessonClass(null, floor.unreadable, clean, verified, "")).toBe("env_policy_unreadable");
    // Control: the same clean draft withheld for a real scope hit keeps the draft classifier.
    advance(3_000);
    discoveryMode = "producer";
    const readable = autonomyScopeFloor(await autonomyScope(), ["repos/development-vessel/src/resolvers/feature-compose.ts"]);
    expect(readable.hits).toEqual(["repos/development-vessel/src/resolvers/feature-compose.ts"]);
    expect(readable.unreadable).toBeNull();
    expect(composeLessonClass(null, readable.unreadable, clean, verified, "")).toBe("semantic_reject");
  });
});

describe("spend envelope read through the shared discovery client", () => {
  it("a lookup failure reads 'lookup failed', and once an envelope was seen it still refuses", async () => {
    poolRecords = [{ shape: "spendEnvelope", updated_at: "2026-09-30T20:00:00Z", body: { reason: "no cap set" } }];
    expect((await spendEnvelopeAllows()).allow).toBe(true);
    discoveryMode = "timeout";
    advance(31_000);
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(v.unreadable).toBe(true);
    expect(v.lookup_failed).toBe(true);
    expect(v.reason).toContain("poolImpulse lookup failed (timeout)");
    expect(v.reason).not.toContain("no poolImpulse producer discovered");
    // ...and the refusal is not held for 30 s once discovery answers again.
    discoveryMode = "producer";
    advance(2_500);
    expect((await spendEnvelopeAllows()).allow).toBe(true);
  });
});

describe("rhythm-conductor presence through the shared discovery client", () => {
  it("a presence lookup that fails is reported as unknown, not as an absent human surface", async () => {
    discoveryMode = "timeout";
    const dir = mkdtempSync(join(tmpdir(), "rct-presence-"));
    const queuePath = join(dir, "queue.json");
    writeFileSync(queuePath, JSON.stringify({ tasks: [], lastUpdated: 0 }));
    const r = await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, registry_endpoint: POOL, queue_path: queuePath, dry_run: true });
    const body = r.body as { presence: boolean; presence_lookup: string };
    expect(body.presence).toBe(false); // fail closed: presence-axis rhythms stay unaffordable
    expect(body.presence_lookup).toContain("obsidian:note lookup failed (timeout)");
    expect(discoveryCalls).toBeGreaterThan(0); // it went through the shared client's lookup
  });

  it("a real empty answer is reported as no producer", async () => {
    discoveryMode = "empty";
    const dir = mkdtempSync(join(tmpdir(), "rct-presence-"));
    const queuePath = join(dir, "queue.json");
    writeFileSync(queuePath, JSON.stringify({ tasks: [], lastUpdated: 0 }));
    const r = await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, registry_endpoint: POOL, queue_path: queuePath, dry_run: true });
    expect((r.body as { presence_lookup: string }).presence_lookup).toBe("no obsidian:note producer");
  });
});

describe("the readers go through the ias typed lookup()", () => {
  it("every policy and presence read calls discovery.lookup()", async () => {
    const spy = spyOn(config.discovery, "lookup");
    poolRecords = [SCOPE];
    expect((await autonomyScope()).readable).toBe(true);
    expect(spy).toHaveBeenCalledWith("poolImpulse");
    spy.mockRestore();
  });
});

// An OLDER ias-executor-ts adapter, as a node that has not rebuilt the ias dist loads it: no lookup(),
// no describe(), no failureBackoffMs. Its legacy lookupShapeProducers must never be used.
let legacyCalls = 0;
function oldAdapter(): HttpDiscoveryAdapter {
  return {
    async lookupShapeProducers(_shape: string) {
      legacyCalls++;
      return [{ id: "development-vessel-local", resolveEndpoint: "/v2/impulses/resolve" }];
    },
    async registerVessel() {},
  } as unknown as HttpDiscoveryAdapter;
}
const OUTDATED_LOG = /ADAPTER OUTDATED/;
let errSpy: ReturnType<typeof spyOn> | null = null;
const outdatedLogLines = (): number => (errSpy?.mock.calls ?? []).filter((c) => OUTDATED_LOG.test(String(c[0]))).length;

describe("on an OLDER ias adapter without lookup(): the outdated-adapter guard", () => {
  beforeEach(() => {
    legacyCalls = 0;
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    __setDiscoveryForTests(oldAdapter());
  });
  afterEach(() => { errSpy?.mockRestore(); errSpy = null; });

  it("a lookup is ok:false, reason adapter_outdated, with ZERO network calls", async () => {
    const r = await lookupShape("poolImpulse");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("adapter_outdated");
    expect(fetchCalls).toBe(0);
    expect(legacyCalls).toBe(0);
  });

  it("the scope floor fails closed, logged as lookup failed (adapter_outdated), classed env_policy_unreadable", async () => {
    // A record was seen on a current adapter, then the process is on an outdated one.
    __setDiscoveryForTests(new HttpDiscoveryAdapter(new FetchAdapter(), config.DISCOVERY_ENDPOINT, {}));
    poolRecords = [SCOPE];
    expect((await autonomyScope()).readable).toBe(true);
    __setDiscoveryForTests(oldAdapter());
    advance(31_000);
    const before = fetchCalls;
    const s = await autonomyScope();
    expect(fetchCalls).toBe(before); // no network call at all
    expect(s.readable).toBe(false);
    expect(s.lookup_failed).toBe(true);
    expect(s.reason).toContain("poolImpulse lookup failed (adapter_outdated)");
    expect(s.reason).not.toContain("no poolImpulse producer");
    const floor = autonomyScopeFloor(s, ["repos/boredom-vessel/src/index.ts"]); // a path the scope does NOT exclude
    expect(floor.hits.length).toBeGreaterThan(0); // fail closed
    expect(floor.unreadable).toContain("lookup failed (adapter_outdated)");
    expect(composeLessonClass(null, floor.unreadable, [{ ok: true }], [{ ok: true, output: "TC_EXIT=0" }], "")).toBe("env_policy_unreadable");
    expect(legacyCalls).toBe(0);
  });

  it("the outdated verdict is held only for the failure backoff, not 30 s", async () => {
    expect((await autonomyScope()).reason).toContain("adapter_outdated");
    // How long the readers hold it, asked while the adapter IS outdated: the ias failure backoff
    // (what a current adapter holds a failed lookup for), never the 30 s answer TTL.
    expect(config.discoveryFailureBackoffMs()).toBe(new HttpDiscoveryAdapter(new FetchAdapter(), config.DISCOVERY_ENDPOINT, {}).failureBackoffMs);
    // ...and once lookups work again the next read after that backoff re-reads.
    __setDiscoveryForTests(new HttpDiscoveryAdapter(new FetchAdapter(), config.DISCOVERY_ENDPOINT, {}));
    poolRecords = [SCOPE];
    advance(2_500);
    expect((await autonomyScope()).readable).toBe(true);
  });

  it("the spend envelope and the presence check read it as a failed lookup", async () => {
    const v = await spendEnvelopeAllows();
    expect(v.lookup_failed).toBe(true);
    expect(v.reason).toContain("poolImpulse lookup failed (adapter_outdated)");
    const dir = mkdtempSync(join(tmpdir(), "rct-presence-"));
    const queuePath = join(dir, "queue.json");
    writeFileSync(queuePath, JSON.stringify({ tasks: [], lastUpdated: 0 }));
    const r = await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, registry_endpoint: POOL, queue_path: queuePath, dry_run: true });
    const body = r.body as { presence: boolean; presence_lookup: string };
    expect(body.presence).toBe(false);
    expect(body.presence_lookup).toContain("obsidian:note lookup failed (adapter_outdated)");
    expect(discoveryCalls).toBe(0);
  });

  it("the loud log fires once per process, however many lookups fail on it", async () => {
    await lookupShape("poolImpulse");
    await lookupShape("llmSpendSummaryNode");
    await autonomyScope();
    await spendEnvelopeAllows();
    expect(outdatedLogLines()).toBe(1);
  });
});
