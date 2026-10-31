import { describe, it, expect, afterAll } from "bun:test";
import { resolveGapLifecycleScan } from "../../src/resolvers/gap-lifecycle-scan.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// gap_priority_ranking scores every open gap against every gap's summary. As one synchronous map it
// blocked the event loop for the whole pass (50.8 s on a copy of a 5075-open / 11297-gap store), so a
// scan left the vessel unable to answer /health. These tests pin that the pass yields while it runs,
// stops at its wall budget, and still scores and orders gaps exactly as before.

const root = join(tmpdir(), `dev-vessel-gaprank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const gapsPath = join(root, "gaps.json");
const proposalsDir = join(root, "proposals");
const NOW = new Date().toISOString();

function seed(gaps: unknown[]) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(proposalsDir, ".applied"), { recursive: true });
  writeFileSync(gapsPath, JSON.stringify(gaps));
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const WORDS = ["store", "landing", "verdict", "region", "compose", "drafter", "walk", "shape", "trace", "lease", "judge", "rhythm"];
function bigStore(n: number, chars: number) {
  return Array.from({ length: n }, (_, i) => {
    let s = `defect ${i}:`;
    for (let k = 0; s.length < chars; k++) s += " " + WORDS[(i * 7 + k * 3) % WORDS.length] + (k % 11 === 0 ? `-${i}-${k}` : "");
    return { id: `gap-rank-${i}`, category: "other", status: "open", created_at: NOW, updated_at: NOW, summary: s };
  });
}

type Ranked = { id: string; citations: number; unlock_fan_out: number; drafter_fit: string; score: number; justification: string };
const scan = (extra: Record<string, unknown> = {}) =>
  resolveGapLifecycleScan({ type: "gap_lifecycle_scan", gapsPath, proposalsDir, staleHours: 48, dry_run: true, rankBudgetMs: 120_000, ...extra } as never) as Promise<{ body: { open: number; gap_priority_ranking: Ranked[] } }>;

describe("gap_lifecycle_scan gap_priority_ranking does not block the event loop", () => {
  it("a concurrent timer keeps firing while a large store is ranked", async () => {
    seed(bigStore(1600, 2000));
    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; ticks++; }, 10);
    const started = performance.now();
    let r: Awaited<ReturnType<typeof scan>>;
    try { r = await scan(); } finally { clearInterval(timer); }
    const tail = performance.now() - last;
    maxGap = Math.max(maxGap, tail);
    const took = performance.now() - started;
    console.log(`[test] ranking ${r.body.open} open gaps took ${took.toFixed(0)} ms; ${ticks} timer ticks; longest event-loop gap ${maxGap.toFixed(0)} ms`);
    expect(r.body.open).toBe(1600);
    expect(r.body.gap_priority_ranking.length).toBe(15);
    expect(maxGap).toBeLessThan(750);
  }, 120_000);

  it("stops at the wall budget, says how many it ranked, and ranks only that store-order prefix", async () => {
    const store = bigStore(1600, 2000);
    seed(store);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    let r: Awaited<ReturnType<typeof scan>>;
    try { r = await scan({ rankBudgetMs: 40 }); } finally { console.log = orig; }
    const line = lines.find((l) => l.includes("gap_priority_ranking stopped at the wall budget"));
    expect(line).toBeDefined();
    const m = /ranked (\d+) of (\d+) open gap/.exec(line ?? "");
    const k = Number(m?.[1]);
    expect(Number(m?.[2])).toBe(1600);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(1600);
    const prefix = new Set(store.slice(0, k).map((g) => g.id));
    expect(r.body.gap_priority_ranking.length).toBe(Math.min(15, k));
    for (const g of r.body.gap_priority_ranking) expect(prefix.has(g.id)).toBe(true);
  }, 120_000);
});

describe("CONTROL: gap_priority_ranking scores and order are unchanged", () => {
  const small = () => [
    { id: "gap-alpha", category: "other", status: "open", created_at: NOW, updated_at: NOW, summary: "base defect one", classification_metadata: { failed_attempts: 2 } },
    { id: "gap-beta", category: "other", status: "open", created_at: NOW, updated_at: NOW, summary: "needs gap-alpha first", classification_metadata: { edit_site: "repos/x/src/a.ts" } },
    { id: "gap-gamma", category: "other", status: "open", created_at: NOW, updated_at: NOW, summary: "see GAP-ALPHA and gap-beta", classification_metadata: { desired_shape: "widgetShape" } },
    { id: "gap-delta", category: "other", status: "closed", created_at: NOW, updated_at: NOW, summary: "mentions gap-gamma and widgetshape" },
    { id: "gap-eps", category: "other", status: "open", created_at: NOW, updated_at: NOW, summary: "plain" },
    { id: "gap-zeta", category: "other", status: "open", created_at: NOW, updated_at: NOW, summary: "plain too" },
  ];

  it("citations, unlock fan-out, drafter fit and score per gap", async () => {
    seed(small());
    const r = await scan();
    const by = new Map(r.body.gap_priority_ranking.map((g) => [g.id, g]));
    expect(by.get("gap-alpha")).toMatchObject({ citations: 2, unlock_fan_out: 2, drafter_fit: "unanchored" });
    expect(by.get("gap-beta")).toMatchObject({ citations: 0, unlock_fan_out: 1, drafter_fit: "surgical" });
    // desired_shape is matched against every gap's summary, closed ones too; unlock counts open gaps only
    expect(by.get("gap-gamma")).toMatchObject({ citations: 1, unlock_fan_out: 0, drafter_fit: "unanchored" });
    expect(by.get("gap-eps")).toMatchObject({ citations: 0, unlock_fan_out: 0 });
    const land = by.get("gap-eps")!.score;
    expect(by.get("gap-alpha")!.score).toBeCloseTo(10 + land, 9);
    expect(by.get("gap-beta")!.score).toBeCloseTo(3 + land, 9);
    expect(by.get("gap-gamma")!.score).toBeCloseTo(3 + land, 9);
    expect(by.get("gap-beta")!.justification.startsWith("cited by 0 failure signal(s), unlocks 1 other gap(s), surgical (anchored code site), landability ")).toBe(true);
    expect(by.has("gap-delta")).toBe(false);
  });

  it("orders by score, ties kept in store order", async () => {
    seed(small());
    const r = await scan();
    expect(r.body.gap_priority_ranking.map((g) => g.id)).toEqual(["gap-alpha", "gap-beta", "gap-gamma", "gap-eps", "gap-zeta"]);
  });
});
