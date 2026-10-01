// The autonomy scope and the spend envelope fail CLOSED whenever they cannot be read, including on
// a fresh process whose very first read fails (a restart during a discovery outage). Only a read
// that SUCCEEDED and found no record means "no scope" / "no cap".
//
// Driven through the real readers and the real admission with globalThis.fetch standing in for
// discovery and the pool (the shared discovery client calls globalThis.fetch at call time). Every
// test starts from fresh module state via __resetPolicyReadsForTests. No source-text assertions.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `scope-fail-closed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const { autonomyScope, autonomyScopeExcludes, autonomyScopeFloor, spendEnvelopeAllows, admitActionableGaps, __resetPolicyReadsForTests } = g2f;

const originalFetch = globalThis.fetch;
const POOL = "http://node-a:18090/v2/impulses/resolve";
const SPEND = "http://node-a:18090/v2/impulses/resolve";
// timeout/network: the discovery lookup itself fails. poolThrows: discovery answers, the pool read throws.
type Mode = "timeout" | "network" | "poolThrows" | "ok";
let mode: Mode = "ok";
let poolRecords: Array<Record<string, unknown>> = [];
let spentUsd = 0;

function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      if (mode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (mode === "network") throw new TypeError("Unable to connect. Is the computer able to access the url?");
      const vessels = [{ vesselId: "development-vessel-local", endpoint: "http://node-a:18090", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: true } });
    }
    if (url === POOL && body?.impulse?.type === "poolImpulse") {
      if (mode === "poolThrows") throw new DOMException("The operation timed out.", "TimeoutError");
      return Response.json({ body: { impulses: poolRecords.filter((r) => r["shape"] === body.impulse.shape) } });
    }
    if (url === SPEND && body?.impulse?.pointer?.type === "llmSpendSummaryNode") {
      return Response.json({ body: { window_ms: 3_600_000, current: { window_start: new Date(Date.now() - 60_000).toISOString(), cost_usd: spentUsd }, previous: null } });
    }
    // Anything else (a best-effort gap write-back) gets an inert answer, never the network.
    return Response.json({});
  }) as unknown as typeof fetch;
}

const EXCLUDED_SITE = "repos/goal-host-vessel/src/index.ts";
const FREE_SITE = "repos/boredom-vessel/src/index.ts";
const SCOPE = { shape: "autonomyScope", updated_at: "2026-09-30T20:00:00Z", body: { excluded_paths: [EXCLUDED_SITE] } };

let logSpy: ReturnType<typeof spyOn> | null = null;
const logLines = (): string[] => (logSpy?.mock.calls ?? []).map((c) => String(c[0]));

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
});
beforeEach(() => {
  setSystemTime(new Date("2026-09-30T21:00:00Z"));
  __resetPolicyReadsForTests(); // a fresh process: no verdict cached, no lookup remembered
  mode = "ok";
  poolRecords = [];
  spentUsd = 0;
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

describe("autonomy scope: the first read after a restart fails", () => {
  for (const m of ["timeout", "network", "poolThrows"] as const) {
    it(`unreadable on the first read (${m}) excludes every path and the floor names it unreadable`, async () => {
      mode = m;
      const s = await autonomyScope();
      expect(s.readable).toBe(false);
      expect(autonomyScopeExcludes(s, EXCLUDED_SITE)).not.toBeNull();
      expect(autonomyScopeExcludes(s, FREE_SITE)).not.toBeNull(); // everything, not only the core
      const floor = autonomyScopeFloor(s, [FREE_SITE]);
      expect(floor.hits.length).toBeGreaterThan(0);
      expect(floor.unreadable).not.toBeNull(); // an environment condition, not a draft verdict
      expect(floor.unreadable).toContain("autonomy scope unreadable");
    });
  }
});

describe("spend envelope: the first read after a restart fails", () => {
  for (const m of ["timeout", "network", "poolThrows"] as const) {
    it(`unreadable on the first read (${m}) refuses`, async () => {
      mode = m;
      const v = await spendEnvelopeAllows();
      expect(v.unreadable).toBe(true);
      expect(v.allow).toBe(false);
    });
  }
});

describe("controls: a read that succeeds", () => {
  it("with NO scope record excludes nothing", async () => {
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(s.excluded).toEqual([]);
    expect(autonomyScopeExcludes(s, FREE_SITE)).toBeNull();
    expect(autonomyScopeExcludes(s, EXCLUDED_SITE)).toBeNull();
    expect(autonomyScopeFloor(s, [FREE_SITE, EXCLUDED_SITE])).toEqual({ hits: [], unreadable: null });
  });

  it("with NO envelope record allows (no cap)", async () => {
    const v = await spendEnvelopeAllows();
    expect(v.unreadable).toBeUndefined();
    expect(v.allow).toBe(true);
    expect(v.reason).toContain("no spendEnvelope record");
  });

  it("with a scope record refuses the excluded path only, and the floor is a real hit", async () => {
    poolRecords = [SCOPE];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(autonomyScopeExcludes(s, EXCLUDED_SITE)).toBe(EXCLUDED_SITE);
    expect(autonomyScopeExcludes(s, FREE_SITE)).toBeNull();
    expect(autonomyScopeFloor(s, [EXCLUDED_SITE, FREE_SITE])).toEqual({ hits: [EXCLUDED_SITE], unreadable: null });
  });

  it("with an envelope record applies the cap", async () => {
    poolRecords = [{ shape: "spendEnvelope", updated_at: "2026-09-30T20:00:00Z", body: { usd_cap_per_hour: 1 } }];
    spentUsd = 0.25;
    const within = await spendEnvelopeAllows();
    expect(within.allow).toBe(true);
    expect(within.cap_usd).toBe(1);
    __resetPolicyReadsForTests();
    spentUsd = 2;
    const over = await spendEnvelopeAllows();
    expect(over.allow).toBe(false);
    expect(over.unreadable).toBeUndefined();
    expect(over.reason).toContain("exhausted");
  });
});

describe("admission with the scope", () => {
  const sited = (id: string, site: string) => ({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `gap ${id}`, classification_metadata: { edit_site: site, falsifier: "class1" } });
  // Siteless: an orphan gets its one auto-shot through a route that never consults an edit site.
  const orphan = { id: "orphaned-capability-fixtureShape", category: "orphaned_capability", source: "substrate_detected", status: "open", summary: "orphan", classification_metadata: { shape: "fixtureShape", failed_attempts: 0 } };
  const candidates = () => [sited("g-core", EXCLUDED_SITE), sited("g-free", FREE_SITE), structuredClone(orphan)];

  it("an unreadable scope on the first read excludes EVERY candidate, sited or not, under one reason key", async () => {
    mode = "timeout";
    const { admitted, excluded } = await admitActionableGaps(candidates(), { typecheckRunner: () => ({ ran: false, clean: false }) });
    expect(admitted).toEqual([]);
    expect(excluded.map((e) => e.id).sort()).toEqual(["g-core", "g-free", "orphaned-capability-fixtureShape"]);
    for (const e of excluded) expect(e.reason.startsWith("autonomy_scope_unreadable")).toBe(true);
    const lines = logLines();
    expect(lines.filter((l) => l.includes("autonomy scope unreadable: excluding all autonomous candidates")).length).toBe(1);
    expect(lines.some((l) => l.includes("auto-pick admission: 3 candidates → 0 admitted, 3 excluded") && l.includes('"autonomy_scope_unreadable":3'))).toBe(true);
  });

  it("control: a readable scope with a record excludes only the core site and admits the rest", async () => {
    poolRecords = [SCOPE];
    const { admitted, excluded } = await admitActionableGaps(candidates(), { typecheckRunner: () => ({ ran: false, clean: false }) });
    const core = excluded.find((e) => e.id === "g-core");
    expect(core?.reason).toBe(`autonomy_scope(${EXCLUDED_SITE})`);
    expect(excluded.some((e) => e.reason.startsWith("autonomy_scope_unreadable"))).toBe(false);
    expect(admitted.map((g) => g.id)).toContain("orphaned-capability-fixtureShape");
    expect(logLines().some((l) => l.includes("autonomy scope unreadable"))).toBe(false);
  });
});
