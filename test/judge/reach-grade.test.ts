// THE REACH GRADE AS AN ACTIVITY (src/judge/learning-credit.ts reachGrade; seed/reach-grade.ts).
//
// CONTROL-RED (run at the base and at the top; red at the base by name):
//   "CONTROL-RED: a dispatch id that misses as given maps under variant-1" — variant-0 leaves it unresolved, variant-1
//   maps it to the dispatch's execution and delivers.
// The rest pin delivery (delivered = updated >= 1, moved = delivered && !idempotent), the once-per-resolved-id dedupe of
// one landing's posts, the activityVariantMask read (none / in force / expired / unreadable), and the traces.
// Every seam is injected: no network, no pool file.
import { describe, it, expect, spyOn, afterEach } from "bun:test";
import * as lc from "../../src/judge/learning-credit.js";

type Fn = (...a: any[]) => any;
const L = lc as unknown as Record<string, Fn | undefined>;
const reachGrade = L["reachGrade"];
const DAY = 86_400_000;
const T0 = 1_900_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = iso(T0);
const mask = (active_variant: number, from: string, until: string) => ({ id: "mask-rg", body: { activity_id: "development-vessel:reach-grade", active_variant, from, until, reason: "window", lift: "research", by: "research" } });
const IN_FORCE = (v: number) => () => [mask(v, iso(T0 - DAY), iso(T0 + DAY))];

/** A /reach stand-in: rows maps an id to its reply. */
function deps(rows: Record<string, { updated: number; idempotent?: boolean }>, o: { readMasks?: () => unknown[]; map?: Record<string, string> } = {}) {
  const posts: Array<{ execution_id: string; completion_shapes?: string[] }> = [];
  const mapped: string[] = [];
  const traces: Array<Record<string, unknown>> = [];
  return {
    posts, mapped, traces,
    d: {
      nowIso: NOW,
      readMasks: o.readMasks ?? (() => []),
      post: async (v: { execution_id: string }) => { posts.push(v); const r = rows[v.execution_id] ?? { updated: 0 }; return { sent: true, status: 200, updated: r.updated, idempotent: r.idempotent === true }; },
      executionIdOf: async (id: string) => { mapped.push(id); return o.map?.[id] ?? null; },
      postTrace: async (t: Record<string, unknown>) => { traces.push(t); return 201; },
    },
  };
}

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => { warn?.mockRestore(); warn = null; });

describe("CONTROL-RED", () => {
  it("CONTROL-RED: a dispatch id that misses as given maps under variant-1", async () => {
    expect(typeof reachGrade).toBe("function");
    const c0 = deps({ "exec-real": { updated: 1 } }, { map: { "disp-1": "exec-real" } });
    const r0 = await reachGrade!({ execution_id: "disp-1", reached: true }, { source: "authoring", why: "t" }, c0.d);
    expect(r0).toMatchObject({ variant: 0, delivered: false, resolution: "unresolved", resolved_id: null });
    expect(c0.mapped).toEqual([]);
    const c1 = deps({ "exec-real": { updated: 1 } }, { readMasks: IN_FORCE(1), map: { "disp-1": "exec-real" } });
    const r1 = await reachGrade!({ execution_id: "disp-1", reached: true }, { source: "authoring", why: "t" }, c1.d);
    expect(r1).toMatchObject({ variant: 1, delivered: true, moved: true, resolution: "dispatch_mapped", resolved_id: "exec-real", posted_id: "disp-1" });
    expect(c1.posts.map((p) => p.execution_id)).toEqual(["disp-1", "exec-real"]);
  });
});

describe("delivery", () => {
  it("an id that is a real trace id hits as given under variant-1; the mapping is not called", async () => {
    const c = deps({ "exec-override": { updated: 1 } }, { readMasks: IN_FORCE(1), map: { "exec-override": "other" } });
    const r = await reachGrade!({ execution_id: "exec-override", reached: false }, { source: "authoring", why: "t" }, c.d);
    expect(r).toMatchObject({ resolution: "as_given", resolved_id: "exec-override", delivered: true });
    expect(c.mapped).toEqual([]);
    expect(c.posts.length).toBe(1);
  });
  it("{updated:1, idempotent:true} is delivered, not moved; {updated:0} on both posts is unresolved, not delivered", async () => {
    const a = deps({ "exec-a": { updated: 1, idempotent: true } });
    expect(await reachGrade!({ execution_id: "exec-a", reached: true }, { source: "landing", why: "t" }, a.d)).toMatchObject({ delivered: true, moved: false, idempotent: true, updated: 1 });
    const b = deps({}, { readMasks: IN_FORCE(1), map: { "disp-b": "exec-b" } });
    const r = await reachGrade!({ execution_id: "disp-b", reached: true }, { source: "authoring", why: "t" }, b.d);
    expect(r).toMatchObject({ resolution: "unresolved", delivered: false, moved: false, resolved_id: null });
    expect(b.posts.map((p) => p.execution_id)).toEqual(["disp-b", "exec-b"]);
  });
  it("a landing whose landing trace and authoring id resolve to the same row posts that row once", async () => {
    const c = deps({ "exec-cut": { updated: 1 } }, { readMasks: IN_FORCE(1), map: { "disp-a": "exec-cut" } });
    const seen = new Map<string, boolean>();
    await reachGrade!({ execution_id: "exec-cut", reached: true, completion_shapes: ["cutoverApplied"] }, { source: "landing", why: "t", seen }, c.d);
    const r = await reachGrade!({ execution_id: "disp-a", reached: true }, { source: "authoring", why: "t", seen }, c.d);
    expect(c.posts.filter((p) => p.execution_id === "exec-cut").length).toBe(1);
    expect(r).toMatchObject({ resolution: "dispatch_mapped", resolved_id: "exec-cut", delivered: true, moved: false });
    // the same id posted twice in one landing is graded once
    expect(await reachGrade!({ execution_id: "exec-cut", reached: true }, { source: "authoring", why: "t", seen }, c.d)).toBeNull();
    expect(c.posts.filter((p) => p.execution_id === "exec-cut").length).toBe(1);
  });
});

describe("the activityVariantMask read", () => {
  const variantOf = async (readMasks: () => unknown[]) => (await reachGrade!({ execution_id: "e", reached: true }, { source: "landing", why: "t" }, deps({ e: { updated: 1 } }, { readMasks }).d))?.variant;
  it("none -> variant-0; in force with active_variant 1 -> variant-1; expired -> variant-0; another activity's -> variant-0", async () => {
    expect(await variantOf(() => [])).toBe(0);
    expect(await variantOf(IN_FORCE(1))).toBe(1);
    expect(await variantOf(() => [mask(1, iso(T0 - 2 * DAY), NOW)])).toBe(0);
    expect(await variantOf(() => [{ id: "m", body: { ...mask(1, iso(T0 - DAY), iso(T0 + DAY)).body, activity_id: "x" } }])).toBe(0);
  });
  it("a pool that cannot be read -> variant-0, logged mask_unread", async () => {
    const lines: string[] = [];
    warn = spyOn(console, "warn").mockImplementation(((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }) as never);
    expect(await variantOf(() => { throw new Error("pool unreadable"); })).toBe(0);
    expect(lines.some((l) => l.includes("[reach-grade] mask_unread"))).toBe(true);
  });
});

describe("the traces", () => {
  it("each grade posts the variant's own trace, then a consumer credit chained to it with reached = delivered", async () => {
    const c = deps({}, { readMasks: IN_FORCE(1), map: { "disp-1": "exec-real" } });
    await reachGrade!({ execution_id: "disp-1", reached: true }, { source: "authoring", why: "t", gap_id: "g1", sha: "a".repeat(40) }, c.d);
    expect(c.traces.length).toBe(2);
    const [own, credit] = c.traces as [Record<string, any>, Record<string, any>];
    expect(own.activity_id).toBe("development-vessel:reach-grade-v1");
    expect(own.output_shapes).toEqual(["executionReachResult"]);
    expect(own.metadata).toMatchObject({ gap_id: "g1", sha: "a".repeat(40), verdict: true });
    expect(credit.activity_id).toBe("development-vessel:reach-grade-credit");
    expect(credit.composition_chain).toEqual([own.execution_id]);
    expect(credit.success).toBe(false);
  });
  it("a trace post that throws does not fail the grade", async () => {
    const c = deps({ e: { updated: 1 } });
    warn = spyOn(console, "warn").mockImplementation((() => undefined) as never);
    const r = await reachGrade!({ execution_id: "e", reached: true }, { source: "landing", why: "t" }, { ...c.d, postTrace: async () => { throw new Error("down"); } });
    expect(r).toMatchObject({ delivered: true, variant: 0 });
  });
});
