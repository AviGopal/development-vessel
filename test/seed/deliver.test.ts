/**
 * Seed delivery to a POPULATED catalogue (src/seed/deliver.ts).
 *
 * The catalogue is only bulk-seeded when empty; after that a seed reaches it only through
 * upsertVersionBumpedSeeds, which uploads a seed whose metadata.seed_version exceeds the
 * registered row's. A seed absent from the registry (GET 404) counts as version 0, so a
 * brand-new seed carrying seed_version >= 1 is delivered; a seed at the registered version is
 * left alone so rows the learning loop evolved are not clobbered.
 *
 * HTTP is mocked by replacing globalThis.fetch (as activity-create-variant.test.ts does); no
 * test reaches a real endpoint.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  upsertVersionBumpedSeeds,
  deliverSeedsToPopulatedCatalogue,
  scheduleSeedDelivery,
} from "../../src/seed/deliver.js";
import type { DevDiscoveryLookup } from "../../src/config.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const EP = "https://activity.test";
type Call = { method: string; url: string; body?: Record<string, unknown> };

/** Registry mock: `rows` maps template id -> registered row (absent => 404). */
function mockRegistry(rows: Record<string, unknown>, opts: { total?: number; getStatus?: number } = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.includes("/v2/activities/templates?limit=1")) {
      return new Response(JSON.stringify({ templates: [], total: opts.total ?? 0 }), { status: 200 });
    }
    if (opts.getStatus) return new Response("boom", { status: opts.getStatus });
    const id = decodeURIComponent(url.split("/v2/activities/templates/")[1] ?? "");
    const row = rows[id];
    return row
      ? new Response(JSON.stringify(row), { status: 200 })
      : new Response(JSON.stringify({ error: "Template not found" }), { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

/** A discovery answer for `activityTemplate`: each producer as [resolve url, origin]. */
const lookupOf = (...ps: Array<[string, string | undefined]>) =>
  async (shape: string): Promise<DevDiscoveryLookup> =>
    ({ ok: true, shape, cached: false, producers: ps.map(([u, origin], i) => ({ id: `activity-api-${i}`, resolveEndpoint: u, origin })) }) as DevDiscoveryLookup;
const LOCAL_AAPI = lookupOf([`${EP}/v2/impulses/resolve`, "local"]);

const tpl = (id: string, seed_version?: number) => ({
  id,
  name: id,
  tags: ["db.maintenance.trace-store"],
  tasks: [{ id: "t", resolver: "x" }],
  ...(seed_version === undefined ? {} : { metadata: { seed_version } }),
});

describe("upsertVersionBumpedSeeds", () => {
  it("uploads a brand-new seed absent from the registry (404 => have 0)", async () => {
    const calls = mockRegistry({});
    const r = await upsertVersionBumpedSeeds([tpl("dv:new", 1)], EP, "k");
    expect(r).toEqual({ upserted: 1, current: 0, skipped: 0 });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(`${EP}/v2/activities/templates`);
    expect(post?.body?.["id"]).toBe("dv:new");
    expect(post?.body?.["proposed"]).toBe(false);
    expect(post?.body?.["tags"]).toEqual(["db.maintenance.trace.store"]);
  });

  it("skips a seed already registered at an equal version", async () => {
    const calls = mockRegistry({ "dv:same": { id: "dv:same", metadata: { seed_version: 2 } } });
    const r = await upsertVersionBumpedSeeds([tpl("dv:same", 2)], EP, "k");
    expect(r).toEqual({ upserted: 0, current: 1, skipped: 0 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("re-uploads a seed whose version exceeds the registered row's", async () => {
    mockRegistry({ "dv:bumped": { id: "dv:bumped", metadata: { seed_version: 1 } } });
    const r = await upsertVersionBumpedSeeds([tpl("dv:bumped", 2)], EP, "k");
    expect(r.upserted).toBe(1);
  });

  it("never touches a seed that has not opted in (no seed_version)", async () => {
    const calls = mockRegistry({});
    const r = await upsertVersionBumpedSeeds([tpl("dv:unversioned")], EP, "k");
    expect(r).toEqual({ upserted: 0, current: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
  });

  it("does not treat an unreadable registry (5xx) as absent: no upload over a row it could not see", async () => {
    const calls = mockRegistry({}, { getStatus: 500 });
    const r = await upsertVersionBumpedSeeds([tpl("dv:maybe", 3)], EP, "k");
    expect(r).toEqual({ upserted: 0, current: 0, skipped: 1 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("deliverSeedsToPopulatedCatalogue", () => {
  it("leaves an EMPTY catalogue to the cold-start seeder (uploads nothing)", async () => {
    // A version-bumped seed landing first would make the catalogue non-empty, and the cold
    // seeder would then skip the whole bootstrap set.
    const calls = mockRegistry({}, { total: 0 });
    const r = await deliverSeedsToPopulatedCatalogue({ templates: [tpl("dv:new", 1)], endpoint: EP, apiKey: "k", lookup: LOCAL_AAPI });
    expect(r).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("upserts version-bumped and brand-new seeds into a POPULATED catalogue", async () => {
    mockRegistry({ "dv:same": { metadata: { seed_version: 1 } } }, { total: 120 });
    const r = await deliverSeedsToPopulatedCatalogue({
      templates: [tpl("dv:new", 1), tpl("dv:same", 1), tpl("dv:unversioned")],
      endpoint: EP,
      apiKey: "k",
      lookup: LOCAL_AAPI,
    });
    expect(r).toEqual({ upserted: 1, current: 1, skipped: 0 });
  });

  it("gives up after bounded attempts when activity-api never answers", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await deliverSeedsToPopulatedCatalogue({
      templates: [tpl("dv:new", 1)],
      endpoint: EP,
      apiKey: "k",
      lookup: LOCAL_AAPI,
      attempts: 3,
      intervalMs: 1,
    });
    expect(r).toBeNull();
    expect(n).toBe(3);
  });
});

describe("deliverSeedsToPopulatedCatalogue — LOCAL-ONLY (a node never writes another node's catalogue)", () => {
  /** Count every fetch and capture console.log, for one delivery call. */
  async function run(endpoint: string, lookup: (s: string) => Promise<DevDiscoveryLookup>) {
    const calls = mockRegistry({}, { total: 120 });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const r = await deliverSeedsToPopulatedCatalogue({ templates: [tpl("dv:new", 1)], endpoint, apiKey: "k", lookup, attempts: 1, intervalMs: 1 });
      return { r, calls, lines };
    } finally {
      console.log = origLog;
    }
  }

  it("REMOTE: a canary whose endpoint is another node's activity-api makes zero catalogue requests and says so", async () => {
    // Node 2's view: its own registry serves no activityTemplate; node 1's arrives as a peer row.
    const { r, calls, lines } = await run(
      "http://node1.example:18080",
      lookupOf(["http://node1.example:18080/v2/impulses/resolve", "peer:http://node1.example:18100"]),
    );
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.startsWith("[seed-delivery] skipped: remote catalogue node1.example:18080"))).toBe(true);
  });

  it("REMOTE: an endpoint that is not this node's producer is skipped even when this node runs its own activity-api", async () => {
    const { r, calls, lines } = await run(
      "http://node1.example:18080",
      lookupOf(["http://node2.example:18080/v2/impulses/resolve", "local"], ["http://node1.example:18080/v2/impulses/resolve", "peer:http://node1.example:18100"]),
    );
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.startsWith("[seed-delivery] skipped: remote catalogue node1.example:18080"))).toBe(true);
  });

  it("LOCAL by loopback: this node serves activityTemplate and the endpoint is 127.0.0.1 — delivers as before", async () => {
    const { r, calls } = await run(
      "http://127.0.0.1:8080",
      lookupOf(["http://node1.example:18080/v2/impulses/resolve", "local"]),
    );
    expect(r).toEqual({ upserted: 1, current: 0, skipped: 0 });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["http://127.0.0.1:8080/v2/activities/templates"]);
  });

  it("LOCAL by advertised origin: the endpoint equals this node's own producer — delivers", async () => {
    const { r } = await run("http://node1.example:18080", lookupOf(["http://node1.example:18080/v2/impulses/resolve", "local"]));
    expect(r?.upserted).toBe(1);
  });

  it("FAILS CLOSED when discovery cannot be read: no catalogue request, skip line", async () => {
    const failed = async (shape: string): Promise<DevDiscoveryLookup> =>
      ({ ok: false, shape, reason: "timeout", detail: "no answer from discovery within 8000 ms", cached: false }) as DevDiscoveryLookup;
    const { r, calls, lines } = await run("http://127.0.0.1:8080", failed);
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.startsWith("[seed-delivery] skipped: remote catalogue 127.0.0.1:8080"))).toBe(true);
  });

  it("FAILS CLOSED when the lookup throws, or when no producer carries an origin stamp", async () => {
    const thrown = await run("http://127.0.0.1:8080", async () => { throw new Error("boom"); });
    expect(thrown.r).toBeNull();
    expect(thrown.calls).toHaveLength(0);
    const unstamped = await run("http://127.0.0.1:8080", lookupOf(["http://127.0.0.1:8080/v2/impulses/resolve", undefined]));
    expect(unstamped.r).toBeNull();
    expect(unstamped.calls).toHaveLength(0);
  });
});

describe("scheduleSeedDelivery — the server's startup hook", () => {
  it("runs the delivery exactly once per process, deferred off the startup path", async () => {
    let runs = 0;
    const run = async () => {
      runs++;
    };
    expect(scheduleSeedDelivery({ run, delayMs: 0 })).toBe(true);
    expect(scheduleSeedDelivery({ run, delayMs: 0 })).toBe(false);
    expect(runs).toBe(0); // deferred: nothing ran synchronously
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(1);
    expect(scheduleSeedDelivery({ run, delayMs: 0 })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(1);
  });

  it("is called from startDiscoveryRegistration, the vessel server's start path (not at import)", () => {
    // Source inspection: invoking startDiscoveryRegistration would do real network.
    const src = readFileSync(join(import.meta.dir, "../../src/discovery-registration.ts"), "utf8");
    const body = src.slice(src.indexOf("export function startDiscoveryRegistration"));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("scheduleSeedDelivery(");
  });
});
