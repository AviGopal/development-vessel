// Substrate-local policy (the autonomy scope, the spend envelope) is read ONLY from this substrate's
// own producers. Discovery unions this node's producers with every federated peer's; before this
// filter the readers took the newest record across all of them, so a peer substrate writing a more
// permissive autonomyScope or spendEnvelope with a later updated_at set OUR containment and budget.
//
// A producer is own iff discovery stamped it origin "local", or "peer:<E>" with E in this substrate's
// node list (the `substrateNodes` poolImpulse, read from local producers only) AND the asked node said
// the row is local to it (origin_upstream "local"). Unstamped rows fail closed.
//
// Driven through the real readers with globalThis.fetch standing in for discovery and every node's
// pool (the shared discovery client calls globalThis.fetch at call time). Every test starts from
// fresh module state via __resetPolicyReadsForTests. No source-text assertions.
import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `own-substrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { autonomyScope, autonomyScopeExcludes, spendEnvelopeAllows, __resetPolicyReadsForTests } = g2fPolicy;

const originalFetch = globalThis.fetch;

// Node 1 and node 2 of THIS substrate, and a third substrate (syzygy), as their discovery endpoints
// are written in each node's PEER_DISCOVERY_ENDPOINTS (the live values).
const N1_DISCOVERY = "http://host.containers.internal:18100";
const N2_DISCOVERY = "http://host.containers.internal:26100";
const SYZ_DISCOVERY = "http://syzygy.host:18100";
const LOCAL_EP = "http://node-local:8090";
const N1_EP = "http://node-one:18090";
const SYZ_EP = "http://syzygy-dv:8401";
const url = (ep: string) => `${ep}/v2/impulses/resolve`;

type Row = Record<string, unknown>;
const localRow: Row = { vesselId: "development-vessel-local", endpoint: LOCAL_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
const n1Row: Row = { vesselId: "development-vessel-local@n1", endpoint: N1_EP, resolve_endpoint: "/v2/impulses/resolve", origin: `peer:${N1_DISCOVERY}`, origin_upstream: "local" };
const syzDirect: Row = { vesselId: "development-vessel-local@syzygy-hub", endpoint: SYZ_EP, resolve_endpoint: "/v2/impulses/resolve", origin: `peer:${SYZ_DISCOVERY}`, origin_upstream: "local" };
// Syzygy's producer as node 2 sees it: relayed THROUGH node 1, so stamped peer:<node 1>.
const syzViaN1: Row = { ...syzDirect, vesselId: "development-vessel-local@syzygy-via-n1", origin: `peer:${N1_DISCOVERY}`, origin_upstream: `peer:${SYZ_DISCOVERY}` };

let rows: Row[] = [];
// Per pool URL: the records it answers, or "down" (the read throws).
let pools: Record<string, Array<Record<string, unknown>> | "down"> = {};
let poolHits: Array<{ url: string; shape: string }> = [];
let fetchCalls = 0;
let spendBy: Record<string, number> = {};

function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls++;
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      return Response.json({ content: { shape: body.pointer.shape, vessels: rows, found: rows.length > 0 } });
    }
    if (body?.impulse?.type === "poolImpulse") {
      poolHits.push({ url: u, shape: body.impulse.shape });
      const p = pools[u];
      if (p === undefined || p === "down") throw new TypeError("Unable to connect");
      return Response.json({ body: { impulses: p.filter((r) => r["shape"] === body.impulse.shape) } });
    }
    if (body?.impulse?.pointer?.type === "llmSpendSummaryNode") {
      return Response.json({ body: { window_ms: 3_600_000, current: { window_start: new Date(Date.now() - 60_000).toISOString(), cost_usd: spendBy[u] ?? 0.1 }, previous: null } });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
}

const CORE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const FREE = "repos/boredom-vessel/src/index.ts";
const strictScope = (at: string) => ({ shape: "autonomyScope", updated_at: at, body: { excluded_paths: [CORE] } });
const permissiveScope = (at: string) => ({ shape: "autonomyScope", updated_at: at, body: { excluded_paths: [] } });
const pause = (at: string) => ({ shape: "spendEnvelope", updated_at: at, body: { paused: true, reason: "operator pause" } });
const openEnvelope = (at: string) => ({ shape: "spendEnvelope", updated_at: at, body: { usd_cap_per_hour: 1000 } });
const nodeList = (at: string, endpoints: string[]) => ({ shape: "substrateNodes", updated_at: at, body: { discovery_endpoints: endpoints } });
const OLDER = "2026-09-30T20:00:00Z";
const NEWER = "2026-09-30T20:59:00Z";

let logSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  setSystemTime(new Date("2026-09-30T21:00:00Z"));
  __resetPolicyReadsForTests();
  rows = [];
  pools = {};
  poolHits = [];
  fetchCalls = 0;
  spendBy = {};
  install();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
  logSpy?.mockRestore();
  logSpy = null;
});
afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("(a) a peer answers a NEWER, MORE PERMISSIVE policy while local answers", () => {
  it("the local autonomy scope is used, and the peer's pool is never read", async () => {
    rows = [localRow, syzDirect];
    pools[url(LOCAL_EP)] = [strictScope(OLDER)];
    pools[url(SYZ_EP)] = [permissiveScope(NEWER)];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE);
    expect(poolHits.some((h) => h.url === url(SYZ_EP))).toBe(false);
  });

  it("the local spend-envelope pause holds against a newer open envelope from a peer", async () => {
    rows = [localRow, syzDirect];
    pools[url(LOCAL_EP)] = [pause(OLDER)];
    pools[url(SYZ_EP)] = [openEnvelope(NEWER)];
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(v.paused).toBe(true);
  });

  it("a peer's spend summary is not summed into OUR envelope (a negative cost cannot buy headroom)", async () => {
    rows = [localRow, syzDirect];
    pools[url(LOCAL_EP)] = [{ shape: "spendEnvelope", updated_at: OLDER, body: { usd_cap_per_hour: 0.05 } }];
    spendBy[url(LOCAL_EP)] = 0.1;
    spendBy[url(SYZ_EP)] = -5;
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(v.spend_sources).toBe(1);
    expect(v.reason).toContain("exhausted");
  });

  it("a peer row FORGING origin_upstream:\"local\" is still foreign when its node is not in the list", async () => {
    rows = [localRow, syzDirect];
    pools[url(LOCAL_EP)] = [strictScope(OLDER), nodeList(OLDER, [N1_DISCOVERY, N2_DISCOVERY])];
    pools[url(SYZ_EP)] = [permissiveScope(NEWER)];
    const s = await autonomyScope();
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE);
  });
});

describe("(b) peer-only: no own producer answers", () => {
  it("only peer producers listed (local down): the scope is unreadable and excludes everything", async () => {
    rows = [syzDirect];
    pools[url(SYZ_EP)] = [permissiveScope(NEWER)];
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(autonomyScopeExcludes(s, FREE)).not.toBeNull();
    expect(poolHits.some((h) => h.url === url(SYZ_EP))).toBe(false);
  });

  it("only peer producers listed (local down): the envelope is unreadable and refuses", async () => {
    rows = [syzDirect];
    pools[url(SYZ_EP)] = [openEnvelope(NEWER)];
    const v = await spendEnvelopeAllows();
    expect(v.unreadable).toBe(true);
    expect(v.allow).toBe(false);
  });

  it("local listed but not answering: closed (the node list itself cannot be read)", async () => {
    rows = [localRow, syzDirect];
    pools[url(LOCAL_EP)] = "down";
    pools[url(SYZ_EP)] = [permissiveScope(NEWER)];
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
  });

  it("an older discovery that stamps no origin: every row is foreign, so both reads fail closed", async () => {
    rows = [{ ...localRow, origin: undefined }, { ...n1Row, origin: undefined, origin_upstream: undefined }];
    pools[url(LOCAL_EP)] = [permissiveScope(NEWER), openEnvelope(NEWER)];
    pools[url(N1_EP)] = [permissiveScope(NEWER)];
    expect((await autonomyScope()).readable).toBe(false);
    expect((await spendEnvelopeAllows()).allow).toBe(false);
    expect(poolHits).toEqual([]);
  });
});

describe("(c) the autonomous_pick lease cannot be set by a peer", () => {
  it("the lease read is node-local: it performs no discovery or pool read at all, so no peer row can reach it", async () => {
    process.env["MAINTENANCE_LEASE_PATH"] = join(ROOT, "leases", "maintenance.json");
    const { resolveMaintenanceLease, resolveMaintenanceLeaseWrite } = await import("../../src/resolvers/maintenance-lease.js");
    rows = [localRow, syzDirect];
    pools[url(SYZ_EP)] = [{ shape: "maintenanceLease", updated_at: NEWER, body: { held: true, holder: "peer" } }];
    const free = (await resolveMaintenanceLease({ type: "maintenanceLease", name: "autonomous_pick" })).body as { held?: boolean };
    expect(free.held).toBe(false);
    await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", name: "autonomous_pick", holder: "local-window", ttl_ms: 60_000 });
    const held = (await resolveMaintenanceLease({ type: "maintenanceLease", name: "autonomous_pick" })).body as { held?: boolean; holder?: string };
    expect(held).toMatchObject({ held: true, holder: "local-window" });
    expect(fetchCalls).toBe(0);
    delete process.env["MAINTENANCE_LEASE_PATH"];
  });
});

describe("(d) node 2: its own substrate's node-1 producer is accepted", () => {
  it("a stricter scope held only on node 1 binds node 2; syzygy's row relayed through node 1 is not read", async () => {
    rows = [localRow, n1Row, syzViaN1];
    pools[url(LOCAL_EP)] = [nodeList(OLDER, [N1_DISCOVERY, N2_DISCOVERY])];
    pools[url(N1_EP)] = [strictScope(OLDER)];
    pools[url(SYZ_EP)] = [permissiveScope(NEWER)];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE);
    expect(poolHits.some((h) => h.url === url(N1_EP) && h.shape === "autonomyScope")).toBe(true);
    expect(poolHits.some((h) => h.url === url(SYZ_EP))).toBe(false);
  });

  it("a pause written only on node 1 binds node 2", async () => {
    rows = [localRow, n1Row, syzViaN1];
    pools[url(LOCAL_EP)] = [nodeList(OLDER, [`${N1_DISCOVERY}/`])]; // trailing slash normalised
    pools[url(N1_EP)] = [pause(OLDER)];
    pools[url(SYZ_EP)] = [openEnvelope(NEWER)];
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(v.paused).toBe(true);
  });

  it("node 1 being listed does not make node 1's view of the node list count: the list is read from local producers only", async () => {
    rows = [localRow, n1Row];
    pools[url(LOCAL_EP)] = [strictScope(OLDER)];
    pools[url(N1_EP)] = [nodeList(NEWER, [N1_DISCOVERY]), permissiveScope(NEWER)];
    const s = await autonomyScope();
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE); // node 1 is not in OUR (absent) list
    expect(poolHits.filter((h) => h.shape === "substrateNodes").map((h) => h.url)).toEqual([url(LOCAL_EP)]);
  });
});

describe("a FOREIGN row relayed through a LISTED node", () => {
  it("origin peer:<node1>, origin_upstream peer:<syzygy> is rejected even though node 1 is listed", async () => {
    // node 1's own row is present too (as on node 2 live), so the node list is read and node 1 IS listed
    rows = [localRow, n1Row, syzViaN1];
    pools[url(LOCAL_EP)] = [strictScope(OLDER), pause(OLDER), nodeList(OLDER, [N1_DISCOVERY, N2_DISCOVERY])];
    pools[url(N1_EP)] = [];
    pools[url(SYZ_EP)] = [permissiveScope(NEWER), openEnvelope(NEWER)];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE);
    const v = await spendEnvelopeAllows();
    expect(v.paused).toBe(true);
    expect(poolHits.some((h) => h.url === url(SYZ_EP))).toBe(false);
  });
});

describe("the node list is ABSENT: peers fail closed, local still reads", () => {
  it("node 2 with no list rejects node 1's producers and reads its own scope", async () => {
    rows = [localRow, n1Row, syzViaN1];
    pools[url(LOCAL_EP)] = [strictScope(OLDER)];
    pools[url(N1_EP)] = [permissiveScope(NEWER)];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE);
    expect(poolHits.some((h) => h.url === url(N1_EP))).toBe(false);
  });

  it("node 1 standing alone with no list: its local reads still work (no halt)", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [strictScope(OLDER), openEnvelope(OLDER)];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE);
    expect(autonomyScopeExcludes(s, FREE)).toBeNull();
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(true);
    expect(v.cap_usd).toBe(1000);
  });
});

describe("the own-producer predicate", () => {
  const own = (p: { origin?: string; originUpstream?: string | null }, nodes: string[]) => g2fPolicy.isOwnSubstrateProducer(p, nodes);
  it("local is own; an unstamped or overlay row is not", () => {
    expect(own({ origin: "local" }, [])).toBe(true);
    expect(own({}, [N1_DISCOVERY])).toBe(false);
    expect(own({ origin: "overlay" }, [N1_DISCOVERY])).toBe(false);
  });
  it("a listed node's local row is own; relayed through it, or unstamped upstream, is not", () => {
    expect(own({ origin: `peer:${N1_DISCOVERY}`, originUpstream: "local" }, [N1_DISCOVERY])).toBe(true);
    expect(own({ origin: `peer:${N1_DISCOVERY}`, originUpstream: `peer:${SYZ_DISCOVERY}` }, [N1_DISCOVERY])).toBe(false);
    expect(own({ origin: `peer:${N1_DISCOVERY}`, originUpstream: null }, [N1_DISCOVERY])).toBe(false);
    expect(own({ origin: `peer:${N1_DISCOVERY}` }, [N1_DISCOVERY])).toBe(false);
  });
  it("an unlisted peer is foreign whatever it claims", () => {
    expect(own({ origin: `peer:${SYZ_DISCOVERY}`, originUpstream: "local" }, [N1_DISCOVERY, N2_DISCOVERY])).toBe(false);
  });
});
