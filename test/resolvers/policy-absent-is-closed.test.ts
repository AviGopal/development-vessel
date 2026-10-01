// An ABSENT autonomyScope or spendEnvelope among this substrate's own producers is CLOSED, exactly like
// an unreadable one. "No containment" and "no cap" exist only as explicit records ({unrestricted: true},
// {uncapped: true}). On 10-01 node 2 held no policy record of its own while node 1 was not yet own (no
// node list), read the scope as EMPTY and READABLE, admitted 229 gaps with no exclusions and started an
// autonomous compose on an excluded path; only the landing floor withheld it.
//
// Driven through the real readers with globalThis.fetch standing in for discovery and every node's pool,
// as in policy-reads-own-substrate.test.ts. This file imports only symbols that exist on the parent
// (70ed3ee), so its must-fail cases fail there on an assertion, not on an import.
import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `policy-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const { autonomyScope, autonomyScopeExcludes, spendEnvelopeAllows, admitActionableGaps, __resetPolicyReadsForTests } = g2f;

const originalFetch = globalThis.fetch;
const N1_DISCOVERY = "http://host.containers.internal:18100";
const N2_DISCOVERY = "http://host.containers.internal:26100";
const LOCAL_EP = "http://node-local:8090";
const N1_EP = "http://node-one:18090";
const url = (ep: string) => `${ep}/v2/impulses/resolve`;

type Row = Record<string, unknown>;
const localRow: Row = { vesselId: "development-vessel-local", endpoint: LOCAL_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
const n1Row: Row = { vesselId: "development-vessel-local@n1", endpoint: N1_EP, resolve_endpoint: "/v2/impulses/resolve", origin: `peer:${N1_DISCOVERY}`, origin_upstream: "local" };

let rows: Row[] = [];
let pools: Record<string, Array<Record<string, unknown>> | "down"> = {};
let poolHits: Array<{ url: string; shape: string }> = [];

function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
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
      return Response.json({ body: { window_ms: 3_600_000, current: { window_start: new Date(Date.now() - 60_000).toISOString(), cost_usd: 0.1 }, previous: null } });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
}

const CORE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const FREE = "repos/boredom-vessel/src/index.ts";
const AT = "2026-10-01T11:00:00Z";
const strictScope = { shape: "autonomyScope", updated_at: AT, body: { excluded_paths: [CORE], reason: "stage 1" } };
const unrestrictedScope = { shape: "autonomyScope", updated_at: AT, body: { unrestricted: true, reason: "operator: no containment" } };
const emptyScopeNoFlag = { shape: "autonomyScope", updated_at: AT, body: { excluded_paths: [], reason: "a list that lost its entries" } };
const cappedEnvelope = { shape: "spendEnvelope", updated_at: AT, body: { usd_cap_per_hour: 2, paused: false } };
const uncappedEnvelope = { shape: "spendEnvelope", updated_at: AT, body: { uncapped: true, paused: false, reason: "operator: no cap" } };
const noCapNoFlag = { shape: "spendEnvelope", updated_at: AT, body: { paused: false, reason: "a cap that was never written" } };
const nodeList = (endpoints: string[]) => ({ shape: "substrateNodes", updated_at: AT, body: { discovery_endpoints: endpoints } });

let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  setSystemTime(new Date("2026-10-01T12:00:00Z"));
  __resetPolicyReadsForTests();
  rows = [];
  pools = {};
  poolHits = [];
  logs = [];
  install();
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
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

describe("autonomyScope: absent among own producers is closed", () => {
  it("[must-fail on 70ed3ee] every own producer answers and none holds a scope: closed, every autonomous path excluded, and the reason says absent", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [];
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(autonomyScopeExcludes(s, FREE)).not.toBeNull();
    expect(autonomyScopeExcludes(s, CORE)).not.toBeNull();
    expect(s.reason).toContain("absent");
    expect(s.reason).not.toContain("unreadable");
  });

  it("an explicit {unrestricted: true} record is open: nothing excluded", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [unrestrictedScope];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(s.excluded).toEqual([]);
    expect(autonomyScopeExcludes(s, FREE)).toBeNull();
    expect(autonomyScopeExcludes(s, CORE)).toBeNull();
  });

  it("a record with an empty excluded_paths and no unrestricted flag is closed (no containment is never implied)", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [emptyScopeNoFlag];
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(autonomyScopeExcludes(s, FREE)).not.toBeNull();
  });

  it("unrestricted:true is honoured only as the boolean true", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [{ ...unrestrictedScope, body: { unrestricted: "true" } }];
    expect((await autonomyScope()).readable).toBe(false);
  });

  it("a contradictory record (unrestricted:true AND excluded paths) is closed", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [{ ...strictScope, body: { excluded_paths: [CORE], unrestricted: true } }];
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(autonomyScopeExcludes(s, FREE)).not.toBeNull();
  });

  it("[must-fail on 70ed3ee] node 2: the scope lives only on node 1 and node 1 is not own (no node list): closed, not empty", async () => {
    rows = [localRow, n1Row];
    pools[url(LOCAL_EP)] = [];
    pools[url(N1_EP)] = [strictScope, cappedEnvelope];
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(autonomyScopeExcludes(s, FREE)).not.toBeNull();
    expect(poolHits.some((h) => h.url === url(N1_EP))).toBe(false);
  });

  it("node 2 once the node list names node 1: node 1's scope binds (the absent rule does not break the own-substrate read)", async () => {
    rows = [localRow, n1Row];
    pools[url(LOCAL_EP)] = [nodeList([N1_DISCOVERY, N2_DISCOVERY])];
    pools[url(N1_EP)] = [strictScope];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(autonomyScopeExcludes(s, CORE)).toBe(CORE);
    expect(autonomyScopeExcludes(s, FREE)).toBeNull();
  });

  it("unreadable is still closed (a producer that does not answer)", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = "down";
    const s = await autonomyScope();
    expect(s.readable).toBe(false);
    expect(autonomyScopeExcludes(s, FREE)).not.toBeNull();
  });

  it("[must-fail on 70ed3ee] admission with an absent scope admits nothing", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [];
    const gaps = [{ id: "g1", status: "open", classification_metadata: { edit_site: FREE } }, { id: "g2", status: "open", classification_metadata: { edit_site: CORE } }];
    const r = await admitActionableGaps(gaps as Record<string, unknown>[], { typecheckRunner: () => ({ ran: true, clean: true }) as never });
    expect(r.admitted).toEqual([]);
    expect(r.excluded.length).toBe(2);
  });
});

describe("spendEnvelope: absent among own producers is closed", () => {
  it("[must-fail on 70ed3ee] every own producer answers and none holds an envelope: refuses, unreadable, reason says absent", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [];
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(v.unreadable).toBe(true);
    expect(v.reason).toContain("absent");
  });

  it("an explicit {uncapped: true} record allows without a cap", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [uncappedEnvelope];
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(true);
    expect(v.cap_usd).toBeUndefined();
  });

  it("[must-fail on 70ed3ee] a record with no cap and no uncapped flag refuses (no cap is never implied)", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [noCapNoFlag];
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
  });

  it("a contradictory record (a cap AND uncapped:true) refuses", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [{ ...cappedEnvelope, body: { usd_cap_per_hour: 2, uncapped: true } }];
    expect((await spendEnvelopeAllows()).allow).toBe(false);
  });

  it("a capped record still allows within the cap", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [cappedEnvelope];
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(true);
    expect(v.cap_usd).toBe(2);
  });

  it("[must-fail on 70ed3ee] node 2: the envelope lives only on node 1 and node 1 is not own (no node list): refuses", async () => {
    rows = [localRow, n1Row];
    pools[url(LOCAL_EP)] = [];
    pools[url(N1_EP)] = [strictScope, cappedEnvelope];
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(poolHits.some((h) => h.url === url(N1_EP))).toBe(false);
  });

  it("unreadable is still closed (a producer that does not answer)", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = "down";
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(v.unreadable).toBe(true);
  });
});

describe("one journal line per policy read", () => {
  it("[must-fail on 70ed3ee] the absent case is its own line: producers asked (count + origins), which answered, record ABSENT among N answering own producers → closed", async () => {
    rows = [localRow, n1Row];
    pools[url(LOCAL_EP)] = [];
    pools[url(N1_EP)] = [strictScope];
    await autonomyScope();
    await spendEnvelopeAllows();
    const scope = logs.filter((l) => l.startsWith("[policy-read] autonomyScope:"));
    expect(scope.length).toBe(1);
    expect(scope[0]).toContain("asked 1 [local] own producer(s)");
    expect(scope[0]).toContain("answered 1 [local]");
    expect(scope[0]).toContain("record ABSENT among 1 answering own producer(s) → closed (absent)");
    const env = logs.filter((l) => l.startsWith("[policy-read] spendEnvelope:"));
    expect(env.length).toBe(1);
    expect(env[0]).toContain("record ABSENT among 1 answering own producer(s) → closed (absent)");
    const nodes = logs.filter((l) => l.startsWith("[policy-read] substrateNodes:"));
    expect(nodes.length).toBe(1);
    expect(nodes[0]).toContain("asked 1 [local]");
    expect(nodes[0]).toContain("record ABSENT among 1 answering own producer(s)");
    expect(nodes[0]).toContain("local rows only");
  });

  it("a found record logs its entry count and every own producer asked, by origin", async () => {
    rows = [localRow, n1Row];
    pools[url(LOCAL_EP)] = [nodeList([N1_DISCOVERY, N2_DISCOVERY])];
    pools[url(N1_EP)] = [{ ...strictScope, body: { excluded_paths: [CORE, "scripts/substrate/"] } }];
    await autonomyScope();
    const scope = logs.filter((l) => l.startsWith("[policy-read] autonomyScope:"));
    expect(scope.length).toBe(1);
    expect(scope[0]).toContain(`asked 2 [local, peer:${N1_DISCOVERY}] own producer(s)`);
    expect(scope[0]).toContain(`answered 2 [local, peer:${N1_DISCOVERY}]`);
    expect(scope[0]).toContain("record found (2 entries) → contained (2 excluded path(s))");
    const nodes = logs.filter((l) => l.startsWith("[policy-read] substrateNodes:"));
    expect(nodes[0]).toContain("record found (2 entries)");
  });

  it("an unreadable read says unreadable, not absent", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = "down";
    await autonomyScope();
    const scope = logs.filter((l) => l.startsWith("[policy-read] autonomyScope:"));
    expect(scope.length).toBe(1);
    expect(scope[0]).toContain("answered 0 []");
    expect(scope[0]).toContain("closed (unreadable");
    expect(scope[0]).not.toContain("ABSENT");
  });

  it("a cached verdict logs nothing: the line is per read, and an absent verdict is held for the normal TTL (not re-read every 2 s)", async () => {
    rows = [localRow];
    pools[url(LOCAL_EP)] = [];
    await autonomyScope();
    setSystemTime(new Date(Date.now() + 10_000));
    await autonomyScope();
    expect(logs.filter((l) => l.startsWith("[policy-read] autonomyScope:")).length).toBe(1);
    expect(poolHits.filter((h) => h.shape === "autonomyScope").length).toBe(1);
  });
});
