import { describe, it, expect, afterEach, spyOn } from "bun:test";
import * as vcg from "../../src/resolvers/verdict-class-gap.js";
import { resolveDetectorCoverageScan } from "../../src/resolvers/detector-coverage-scan.js";

/**
 * CHECK-FIRST (slice Y, step Y2c): the already-scheduled coverage tick files ONE gap per
 * deterministic verdict class.
 *
 * detector_coverage_scan is the generator that fires (detector-coverage-audit-tick, emit_gap:true),
 * but it clusters by `failure_type::activity_prefix` over the latest 300 list rows, so a verdict
 * class never forms a cluster: hundreds of deterministic not-reached verdicts became 0 gaps.
 * The pure builder verdictClassGaps (verdict-class-gap.ts) already decides which class gaps to
 * write; nothing calls it. This step adds a class pass on the same tick (law 3: no new resolver,
 * no new tick):
 *   - per-class counts from traceAggregateReport over `execution`, group_by failure_class
 *     (the Y1-read-b dimension), and the distinct-goal count of a class from group_by goal_hash
 *     filtered by failure_class (total_groups);
 *   - the store's existing class rows (an unread store must reach the builder as null);
 *   - the policy from readVerdictClassPolicy (shaped, read at use time; defaults when absent);
 *   - each returned gap written through substrateGap_write.
 *
 * The aggregate echoes the group_by it actually used, and an unknown group_by silently falls
 * back to activity_id. Until the failure_class dimension is served, the pass must file nothing:
 * rows keyed by something else are not class counts.
 *
 * The store stub honours the read filters the real store honours (id, category, source, status,
 * limit) over a store holding more rows than one unfiltered read returns, as the live store does.
 */

const AA = "http://aa.test";
const DV = "http://dv.test/v2/impulses/resolve";
const CLASS = "deterministic:edit-intent-no-landed-edit";
const CLASS_ID = "verdict-class-edit-intent-no-landed-edit";

const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

type Write = { id: string; gap: any };

interface StubOpts {
  classes: Array<{ key: string; value: number }>;
  goals: Record<string, number>;
  existing?: any[];
  /** The group_by the aggregate actually serves for a failure_class request (live today: activity_id). */
  servedGroupBy?: string;
  storeUnreadable?: boolean;
}

function filler(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({ id: `unrelated-gap-${i}`, category: "systematic_failure", source: "substrate_detected", status: "open", summary: "x", classification_metadata: {} }));
}

function stub(opts: StubOpts): Write[] {
  const writes: Write[] = [];
  const store = [...filler(700), ...(opts.existing ?? [])];
  const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
  const aggregate = (p: any) => {
    const asked = String(p.group_by ?? "activity_id");
    const served = asked === "failure_class" ? (opts.servedGroupBy ?? "failure_class") : asked;
    let rows: Array<{ key: string; value: number }> = [];
    let total = 0;
    if (served === "failure_class") {
      rows = opts.classes;
      total = rows.length;
    } else if (served === "goal_hash") {
      const n = typeof p.failure_class === "string" ? (opts.goals[p.failure_class] ?? 0) : 0;
      rows = Array.from({ length: Math.min(n, 3) }, (_, i) => ({ key: `goal${i}`, value: 1 }));
      total = n;
    } else {
      rows = [{ key: "feature-compose-template", value: 812 }, { key: "walk-template", value: 404 }];
      total = rows.length;
    }
    const report = { shape: "traceAggregateReport", metric: "count", group_by: served, window_hours: Number(p.window_hours ?? 24), rows, total_groups: total, matched_total: rows.reduce((s, r) => s + r.value, 0), measured: true, generated_at: new Date().toISOString() };
    return ok({ success: true, content: JSON.stringify(report), metadata: { shape: "traceAggregateReport" } });
  };
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let body: any = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    const p = body?.impulse?.pointer ?? body?.pointer ?? {};
    if (url.startsWith(`${AA}/v2/activities/execution-traces`)) return ok({ executions: [] });
    if (url.startsWith(`${AA}/v2/activities/templates`)) return ok({ templates: [] });
    if (p.type === "traceAggregateReport") return aggregate(p);
    if (url === DV && p.type === "substrateGap") {
      if (opts.storeUnreadable) return new Response("gap store unavailable", { status: 503 });
      let rows = store;
      if (p.id) rows = rows.filter((g) => g.id === p.id);
      if (p.category) rows = rows.filter((g) => g.category === p.category);
      if (p.source) rows = rows.filter((g) => g.source === p.source);
      if (p.status) rows = rows.filter((g) => g.status === p.status);
      rows = rows.slice(0, Number(p.limit ?? 50));
      return ok({ shape: "substrateGap", body: { gaps: rows, total: rows.length } });
    }
    if (url === DV && p.type === "substrateGap_write") { writes.push({ id: String(p.gap?.id), gap: p.gap }); return ok({ shape: "substrateGap_write", body: { ok: true, id: p.gap?.id } }); }
    return ok({});
  }) as unknown as typeof fetch);
  restores.push(() => spy.mockRestore());
  return writes;
}

function spyBuilder() {
  const spy = spyOn(vcg, "verdictClassGaps");
  restores.push(() => spy.mockRestore());
  return spy;
}

const run = () => resolveDetectorCoverageScan({ type: "detector_coverage_scan", emit_gap: true, metabobEndpoint: AA, devVesselImpulsesUrl: DV });
const classWrites = (w: Write[]) => w.filter((x) => x.id.startsWith(vcg.VERDICT_CLASS_ID_PREFIX));

const LIVE_LIKE = {
  classes: [
    { key: CLASS, value: 369 },
    { key: "deterministic:stale-asserted-date", value: 30 },
    { key: "transport", value: 11088 },
    { key: "structural:not-registered", value: 651 },
  ],
  goals: { [CLASS]: 288, "deterministic:stale-asserted-date": 1, transport: 400, "structural:not-registered": 90 },
};

describe("detector_coverage_scan verdict-class pass", () => {
  it("POSITIVE CONTROL: a deterministic class above the policy floors is filed as exactly one verdict-class gap through verdictClassGaps", async () => {
    const builder = spyBuilder();
    const writes = stub(LIVE_LIKE);
    await run();
    expect(builder).toHaveBeenCalled();
    const [counts, existing] = builder.mock.calls[0]!;
    const c = (counts as vcg.ClassCount[]).find((x) => x.class === CLASS);
    expect(c?.count).toBe(369);
    expect(c?.distinct_goals).toBe(288);
    expect(Array.isArray(existing)).toBe(true);
    const cls = classWrites(writes);
    expect(cls.map((w) => w.id)).toEqual([CLASS_ID]);
    const gap = cls[0]!.gap;
    expect(gap.status).toBe("open");
    expect(typeof gap.summary).toBe("string");
    expect(gap.summary.length).toBeGreaterThan(0);
    expect(gap.category).toBe("verdict_class");
    expect(gap.classification_metadata.detector).toBe("verdict_class_scan");
    expect(gap.classification_metadata.falsifier).toBe("class2");
    expect(gap.classification_metadata.evidence_resolve.zero_field).toBe("excess_failures");
  });

  it("the report says how many verdict-class gaps it wrote", async () => {
    stub(LIVE_LIKE);
    const r = await run();
    expect((r.body as any).verdict_class_gaps_emitted).toBe(1);
  });

  it("CONTROL: classes below the policy floors file nothing", async () => {
    const writes = stub({ classes: [{ key: CLASS, value: 5 }, { key: "deterministic:wrong-git-commit-count", value: 300 }], goals: { [CLASS]: 5, "deterministic:wrong-git-commit-count": 1 } });
    await run();
    expect(classWrites(writes)).toEqual([]);
  });

  it("CONTROL: an unreadable gap store files nothing", async () => {
    const writes = stub({ ...LIVE_LIKE, storeUnreadable: true });
    await run();
    expect(classWrites(writes)).toEqual([]);
  });

  it("CONTROL: an aggregate that does not serve the failure_class dimension files nothing", async () => {
    const writes = stub({ ...LIVE_LIKE, servedGroupBy: "activity_id" });
    await run();
    expect(classWrites(writes)).toEqual([]);
  });

  it("CONTROL: a closed class gap with no recurrence since its close is not rewritten open", async () => {
    const writes = stub({ ...LIVE_LIKE, existing: [{ id: CLASS_ID, status: "closed", category: "verdict_class", source: "substrate_detected", summary: "x", closed_at: new Date().toISOString(), classification_metadata: { closed_at: new Date().toISOString() } }] });
    await run();
    expect(classWrites(writes).filter((w) => w.id === CLASS_ID && w.gap.status === "open")).toEqual([]);
  });
});
