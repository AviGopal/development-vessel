// FAIR SHARE OF THE SHARED SPEND ENVELOPE (value-per-cost-selection 4.5).
//
// Measured 2026-10-02 06:00-14:17Z: the fleet's $2/h `spendEnvelope` is shared by both nodes and was
// exhausted twice. Node 1 spent $1.09-$1.78/h on picks of gaps already at 6-8 failed attempts and landed
// 1 in 18 (~$6.7/landing) while node 2 lands at ~$0.85/landing; the global cap cannot tell them apart,
// so the low-yield lineage starved the productive one. These pin:
//   - a lineage that spent its window ceiling without landing is held from auto-pick, and another lineage
//     is then admitted (the scenario);
//   - the ceiling and the node share are read from the spendEnvelope record at use time (law 1), absent =
//     off, invalid = closed;
//   - the selection filter actually consumes the predicate (a helper nothing calls is hollow);
//   - a compose report carries the spend the ledger is written from.
//
// Symbols are read through the module namespace so that on the parent the must-fail cases fail on an
// assertion, not on an import.
import { afterAll, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `lineage-spend-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;

const g2f = (await import("../../src/resolvers/gap-to-feature.js")) as Record<string, any>;
const { spendEnvelopeAllows, __resetPolicyReadsForTests } = g2f;

const NOW = Date.parse("2026-10-02T14:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
type Gap = Record<string, unknown>;
const gap = (id: string, meta: Record<string, unknown>): Gap => ({ id, category: "systematic_failure", summary: id, classification_metadata: meta });
const index = (gs: Gap[]) => new Map(gs.map((g) => [String(g.id), g]));

/** The auto-pick hold as the selection filter applies it (lineageSpendHeld; absent on the parent = no hold). */
function admittedUnder(gs: Gap[], policy: unknown): string[] {
  const held = g2f.lineageSpendHeld as ((g: Gap, byId: Map<string, Gap>, now: number, p: unknown) => boolean) | undefined;
  const byId = index(gs);
  return gs.filter((g) => !(held ? held(g, byId, NOW, policy) : false)).map((g) => String(g.id));
}

describe("lineage spend ceiling: one low-yield lineage cannot starve another", () => {
  // Lineage A: a root at 7 failed attempts and its recommit child; between them $0.80 of compose spend
  // in the last hour and no landing. Lineage B: a fresh root with one cheap attempt.
  const aRoot = gap("shell-gate-root", { failed_attempts: 7, spend_ledger: [{ at: ago(50 * 60_000), usd: 0.3 }, { at: ago(30 * 60_000), usd: 0.25 }] });
  const aChild = gap("recommit-shell-gate-root-verify_failed", { source_gap_id: "shell-gate-root", failed_attempts: 1, spend_ledger: [{ at: ago(5 * 60_000), usd: 0.25 }] });
  const b = gap("productive-root", { spend_ledger: [{ at: ago(10 * 60_000), usd: 0.05 }] });
  const policy = { lineage_usd_cap: 0.5, lineage_window_ms: 3_600_000 };

  it("holds the lineage that spent its ceiling without landing and admits the other", () => {
    expect(admittedUnder([aRoot, aChild, b], policy)).toEqual(["productive-root"]);
  });

  it("sums spend across the lineage walk, so a recommit cannot mint its way past the ceiling", () => {
    const byId = index([aRoot, aChild, b]);
    expect(g2f.lineageWindowSpendUsd(aChild, byId, NOW, 3_600_000)).toBeCloseTo(0.8, 6);
    // A root sees its own ledger only (same upward walk as lineageBackoffState).
    expect(g2f.lineageWindowSpendUsd(aRoot, byId, NOW, 3_600_000)).toBeCloseTo(0.55, 6);
  });

  it("releases the lineage when the window rolls", () => {
    const byId = index([aRoot, aChild, b]);
    // 20-minute window: only the child's $0.25 is inside it.
    expect(g2f.lineageSpendHeld(aChild, byId, NOW, { lineage_usd_cap: 0.5, lineage_window_ms: 20 * 60_000 })).toBe(false);
  });

  it("is off when the envelope sets no ceiling, and fails open on a row with no ledger", () => {
    expect(admittedUnder([aRoot, aChild, b], {}).length).toBe(3);
    expect(admittedUnder([aRoot, aChild, b], null).length).toBe(3);
    expect(g2f.lineageSpendHeld(gap("bare", {}), new Map(), NOW, policy)).toBe(false);
  });

  it("the ledger the compose path writes is what the hold reads (bounded, oldest dropped)", () => {
    let meta: Record<string, unknown> = {};
    for (let i = 0; i < g2f.SPEND_LEDGER_MAX_ENTRIES + 5; i++) meta = { ...meta, spend_ledger: g2f.appendSpendLedger(meta, 0.03, ago(60_000)) };
    expect((meta.spend_ledger as unknown[]).length).toBe(g2f.SPEND_LEDGER_MAX_ENTRIES);
    expect(g2f.lineageSpendHeld(gap("g", meta), new Map(), NOW, policy)).toBe(true);
  });
});

describe("the selection filter consumes the hold (not just a helper)", () => {
  const src = readFileSync(new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url), "utf8");
  it("auto-pick filters candidates through lineageSpendHeld with the envelope it admitted under", () => {
    expect(src).toContain("if (lineageSpendHeld(g, gapsById, nowMs, pickEnvelope)) {");
    expect(src).toMatch(/pickEnvelope = envelope;/);
  });
  it("every compose call site charges its spend to the gap's ledger", () => {
    const composes = src.match(/await resolveFeatureCompose\(/g)?.length ?? 0;
    const charges = src.match(/await recordLineageSpend\(/g)?.length ?? 0;
    expect(composes).toBeGreaterThan(0);
    expect(charges).toBe(composes);
  });
  it("feature_compose reports its accumulated spend as llm_usage", () => {
    const fc = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    expect(fc).toContain("llm_usage: { ...usage }");
  });
});

// ── the policy fields are read from the spendEnvelope record at use time ──
const originalFetch = globalThis.fetch;
const LOCAL_EP = "http://node-local:8090";
const PEER_EP = "http://node-two:26090";
const N2_DISCOVERY = "http://host.containers.internal:26100";
const url = (ep: string) => `${ep}/v2/impulses/resolve`;
let envelopeBody: Record<string, unknown> = {};
let spendByEp: Record<string, number> = {};
function install(): void {
  const localRow = { vesselId: "development-vessel-local", endpoint: LOCAL_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
  const peerRow = { vesselId: "development-vessel-local@n2", endpoint: PEER_EP, resolve_endpoint: "/v2/impulses/resolve", origin: `peer:${N2_DISCOVERY}`, origin_upstream: "local" };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      const vessels = body.pointer.shape === "llmSpendSummaryNode" ? [localRow, peerRow] : [localRow];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") {
      const s = body.impulse.shape;
      const recs = s === "spendEnvelope" ? [{ shape: s, updated_at: "2026-10-02T13:00:00Z", body: envelopeBody }]
        : s === "substrateNodes" ? [{ shape: s, updated_at: "2026-10-02T13:00:00Z", body: { discovery_endpoints: [N2_DISCOVERY] } }] : [];
      return Response.json({ body: { impulses: recs } });
    }
    if (body?.impulse?.pointer?.type === "llmSpendSummaryNode") {
      const ep = u === url(LOCAL_EP) ? LOCAL_EP : PEER_EP;
      return Response.json({ body: { window_ms: 3_600_000, current: { window_start: new Date(Date.now() - 60_000).toISOString(), cost_usd: spendByEp[ep] ?? 0 }, previous: null } });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
}
let logSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  __resetPolicyReadsForTests();
  install();
  logSpy?.mockRestore();
  logSpy = spyOn(console, "log").mockImplementation(() => { });
});
afterAll(() => { globalThis.fetch = originalFetch; logSpy?.mockRestore(); setSystemTime(); __resetPolicyReadsForTests(); });

describe("spendEnvelope fair-share fields", () => {
  it("carries the lineage ceiling and window from the record", async () => {
    envelopeBody = { usd_cap_per_hour: 2, paused: false, lineage_usd_cap_per_window: 0.5, lineage_window_s: 1800 };
    spendByEp = { [LOCAL_EP]: 0.2, [PEER_EP]: 0.1 };
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(true);
    expect(v.lineage_usd_cap).toBe(0.5);
    expect(v.lineage_window_ms).toBe(1_800_000);
  });

  it("absent fields leave the envelope exactly as before (no ceiling, no share)", async () => {
    envelopeBody = { usd_cap_per_hour: 2, paused: false };
    spendByEp = { [LOCAL_EP]: 1.5, [PEER_EP]: 0.1 };
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(true);
    expect(v.lineage_usd_cap).toBeUndefined();
    expect(v.node_share_exhausted).toBeUndefined();
  });

  it("a node past its share refuses while the fleet is under the cap, leaving the rest to the other node", async () => {
    envelopeBody = { usd_cap_per_hour: 2, paused: false, max_node_share: 0.6 };
    spendByEp = { [LOCAL_EP]: 1.3, [PEER_EP]: 0.2 };
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(false);
    expect(v.node_share_exhausted).toBe(true);
    expect(v.own_spent_usd).toBeCloseTo(1.3, 6);
    expect(v.unreadable).toBeUndefined();
  });

  it("the node under its share is still admitted", async () => {
    envelopeBody = { usd_cap_per_hour: 2, paused: false, max_node_share: 0.6 };
    spendByEp = { [LOCAL_EP]: 0.2, [PEER_EP]: 1.3 };
    const v = await spendEnvelopeAllows();
    expect(v.allow).toBe(true);
  });

  it("an invalid fair-share field refuses like a non-finite cap", async () => {
    for (const bad of [{ lineage_usd_cap_per_window: "0.5" }, { lineage_usd_cap_per_window: -1 }, { max_node_share: 1.5 }, { lineage_window_s: 0 }]) {
      __resetPolicyReadsForTests();
      envelopeBody = { usd_cap_per_hour: 2, paused: false, ...bad };
      spendByEp = { [LOCAL_EP]: 0.1, [PEER_EP]: 0.1 };
      const v = await spendEnvelopeAllows();
      expect(v.allow).toBe(false);
      expect(v.unreadable).toBe(true);
    }
  });
});
