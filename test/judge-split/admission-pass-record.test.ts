// THE ADMISSION PASS RECORD. Admission builds a reason for every row it excludes and the landability floor drops rows
// inside the pick, but both only printed counts: nothing a reader could resolve said why a given gap is never picked.
// After each auto-pick, gap_to_feature upserts one pool row per node (shape gapAdmissionPass) naming the admitted rows,
// the floored ids and every non-parked exclusion with its reason. It is read here the way any reader reads it, through
// development-vessel's own /v2/impulses/resolve route. Written only on a change of content, bounded in entries, and
// observation only: the floored-ids hook it reads does not change the pick.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { beginPin, endPin, restoreHarness, stored, tick, SCRATCH, RUN, type Row } from "./harness.js";
import { candidate, classPosteriors, autoPick, pickSite, PICK_LOG } from "./pick-fixture.js";

const pool = await import("../../src/resolvers/pool-impulse.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js") as Record<string, unknown>;
const { pickCandidate } = await import("../../src/judge/gap-admission.js");
const { gapClassOf, landabilityScore } = await import("../../src/judge/gap-attempt-credit.js");
// A fresh instance of the route module: several observer tests replace "../../src/routes/impulses.js" with a
// resolveDispatch-only stand-in (mock.module is never undone), so in an order where one of them ran first, a plain
// import here would get the stand-in and no router. The query makes it a distinct module that mock does not match;
// its own imports (the pool store among them) are the shared instances this file points at its scratch pool.
const routeSpec = "../../src/routes/impulses.js" + "?admission-pass-record";
const { impulsesRouter } = await import(routeSpec) as typeof import("../../src/routes/impulses.js");
if (typeof (impulsesRouter as { fetch?: unknown } | undefined)?.fetch !== "function") throw new Error("admission-pass-record: the real impulses router did not load");
const app = new Hono();
app.route("/", impulsesRouter);
/** The record as a reader gets it: through the vessel's resolve route, by shape. */
async function readRecord(): Promise<Row | null> {
  const res = await app.fetch(new Request("http://localhost/v2/impulses/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "gapAdmissionPass" } }),
  }));
  const j = await res.json() as { body?: { impulses?: Array<{ body: Row }> } };
  return j.body?.impulses?.[0]?.body ?? null;
}
const reset = g2f.__resetAdmissionPassForTests as (() => void) | undefined;
let n = 0;
beforeEach(() => {
  beginPin();
  pool.__setPoolFileForTests(join(SCRATCH, `pool-${RUN}-${++n}.json`));
  reset?.();
});
afterEach(() => { pool.__setPoolFileForTests(null); expect(endPin([PICK_LOG])).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("the auto-pick records why it admitted what it did", () => {
  it("[MUST-FAIL] after a pass the record, read through the resolve route, names a saturated row's reason, the floored row and the admitted rows", async () => {
    const site = pickSite();
    // The read is newest first, so the row seeded first is last in store order: two later rows take the file's two slots.
    const late = candidate("apr-late-a", { edit_site: site });
    const one = candidate("apr-one-a", { edit_site: site });
    const two = candidate("apr-two-a", { edit_site: site });
    // architectural_pattern (-0.4) with four failed attempts on a sited gap (-0.4): 0.10, under the floor.
    const low = candidate("apr-low-a", { failed_attempts: 4 }, { category: "architectural_pattern" });
    const parked = candidate("apr-parked-a", { disposition: "needs_information" });
    classPosteriors({ [gapClassOf(stored(one)!)]: "favour" });
    const { picked } = await autoPick();
    expect([one, two]).toContain(picked);
    const rec = await readRecord();
    expect(rec).not.toBeNull();
    expect((rec!.excluded as Row)[late]).toBe(`edit_site_saturated(${site})`);
    expect(rec!.floored).toEqual([low]);
    expect((rec!.admitted as Array<{ id: string }>).map((a) => a.id)).toEqual(expect.arrayContaining([one, two, low]));
    expect((rec!.admitted as Array<{ id: string }>).map((a) => a.id)).not.toContain(late);
    expect((rec!.excluded as Row)[parked]).toBeUndefined(); // a parked row carries its reason on its own row
    expect(Number(rec!.parked)).toBeGreaterThanOrEqual(1);
    expect(typeof rec!.since).toBe("string");
    expect(rec!.truncated).toBe(0);
  });
});

describe("bounded and written only on change", () => {
  const record = () => g2f.recordAdmissionPass as (p: unknown) => "written" | "unchanged" | "failed";
  const pass = (k: number) => ({
    node: `apr-node-${RUN}`, candidates: k + 2,
    admitted: [{ id: "apr-adm", category: "failing_test", classification_metadata: { edit_site: "repos/x/src/a.ts" } }],
    excluded: Array.from({ length: k }, (_, i) => ({ id: `apr-ex-${String(i).padStart(5, "0")}`, reason: `edit_site_saturated(repos/x/src/a.ts)` }))
      .concat([{ id: "apr-parked", reason: "needs_information(falsifier=unset)" }]),
    floored: [],
  });

  it("an unchanged pass writes nothing; a changed one writes once; a restart that finds the same row writes nothing", async () => {
    const { lines } = await tick(async () => {
      expect(record()(pass(3))).toBe("written");
      expect(record()(pass(3))).toBe("unchanged");
      reset!();
      expect(record()(pass(3))).toBe("unchanged");
      expect(record()(pass(4))).toBe("written");
    });
    expect(lines.filter((l) => l.startsWith("[pool-impulse] write:")).length).toBe(2);
    const rec = await readRecord();
    expect(Object.keys(rec!.excluded as Row).length).toBe(4);
    expect(rec!.by_reason).toEqual({ edit_site_saturated: 4, needs_information: 1 });
  });

  it("a pass with more than the cap keeps 1000 entries and counts the rest", async () => {
    expect(record()(pass(1200))).toBe("written");
    const rec = await readRecord();
    const entries = (rec!.admitted as unknown[]).length + (rec!.floored as unknown[]).length + Object.keys(rec!.excluded as Row).length;
    expect(entries).toBe(g2f.ADMISSION_PASS_MAX_ENTRIES as number);
    expect(rec!.truncated).toBe(1201 - 1000);
    expect((rec!.by_reason as Row).edit_site_saturated).toBe(1200);
  });
});

describe("the floored-ids hook is observation only", () => {
  it("[CONTROL] the pick is the same with the hook present and absent, and the hook names the floored row", async () => {
    const rows = [
      candidate("apr-hk-low", { failed_attempts: 4 }, { category: "architectural_pattern" }),
      candidate("apr-hk-mid", { failed_attempts: 4 }),
      candidate("apr-hk-top"),
    ].map((id) => stored(id)!);
    const base = { lineageIndex: new Map(rows.map((g) => [String(g.id), g])), score: (g: Row) => landabilityScore(g), rerank: () => {}, onPicked: () => {}, ask: async () => null };
    const seen: string[][] = [];
    const without = await tick(async () => pickCandidate(rows, base as never));
    const withHook = await tick(async () => pickCandidate(rows, { ...base, onFloored: (ids: string[]) => { seen.push(ids); } } as never));
    expect(String(withHook.result?.id)).toBe(String(without.result?.id));
    expect(String(without.result?.id)).toBe(String(rows[2]!.id));
    expect(seen).toEqual([[String(rows[0]!.id)]]);
  });
});
