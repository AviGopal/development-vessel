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
    const r = await deliverSeedsToPopulatedCatalogue({ templates: [tpl("dv:new", 1)], endpoint: EP, apiKey: "k" });
    expect(r).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("upserts version-bumped and brand-new seeds into a POPULATED catalogue", async () => {
    mockRegistry({ "dv:same": { metadata: { seed_version: 1 } } }, { total: 120 });
    const r = await deliverSeedsToPopulatedCatalogue({
      templates: [tpl("dv:new", 1), tpl("dv:same", 1), tpl("dv:unversioned")],
      endpoint: EP,
      apiKey: "k",
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
      attempts: 3,
      intervalMs: 1,
    });
    expect(r).toBeNull();
    expect(n).toBe(3);
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
