// A ROUTE-EDIT GAP IS A ROW FROM THE MOMENT IT IS ROUTED (REALIGNMENT §2.1 / §2.2; law 7). goal-host's edit-intent route
// composes under a synthetic route-edit-<hash> the store never held, so the cutover's own check read "no gap row" and
// the landing went landed_unverified with nothing to verify or close (0f64cbbc / route-edit-849a2800, 81c9d93e /
// route-edit-faa5a58e). feature_compose now persists the row for a landing compose of such an id, after admission.
//
// MUST-FAIL: a route-edit landing compose writes its row (id, edit_site, open, provenance), and the cutover's own-check
// load (loadOwnCheck, the reader the cutover calls) then finds THAT row: an unverifiable landing is recorded against a
// row with a reason, not "no gap row". Wiring: the resolver calls it right after the pre-prompt hydration.
// CONTROL: a normal gap is untouched (a stored row, an unstored non-route-edit id), and so are a route-edit id the store
// already holds, an unreadable store and a non-landing compose; a stored gap's own check still loads as before.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as fc from "../../src/resolvers/feature-compose.js";
import { loadOwnCheck } from "../../src/resolvers/staged-mitosis-gate.js";

// A namespace import, so at the parent (no such export) the must-fails go red by name and the controls run against
// the parent's behaviour (nothing persisted), instead of the file failing to link.
type Persist = (p: Record<string, unknown>, h: { source: "store" | "caller" | "store_unreadable" }, w: (r: Record<string, unknown>) => Promise<unknown>) => Promise<{ persisted: boolean; why: string }>;
const exported = (fc as unknown as { persistRouteEditGap?: Persist }).persistRouteEditGap;
const persistRouteEditGap: Persist = exported ?? (async () => ({ persisted: false, why: "absent at this tree" }));
const FC = new URL("../../src/resolvers/feature-compose.ts", import.meta.url).pathname;
const SITE = "repos/development-vessel/src/resolvers/example.ts";
const routed = (over: Record<string, unknown> = {}) => ({
  land: true,
  directed: true,
  authoring_execution_id: "dispatch-1",
  spec: "Close substrate gap the-addressed-gap: Edit repos/development-vessel/src/resolvers/example.ts so it does the thing",
  gap: { id: "route-edit-849a2800", summary: "Edit example.ts so it does the thing", category: "edit_intent_route", classification_metadata: { edit_site: SITE } },
  ...over,
});
const recorder = () => {
  const rows: Array<Record<string, unknown>> = [];
  return { rows, write: async (r: Record<string, unknown>) => { rows.push(r); return { shape: "substrateGap_write", body: { ok: true } }; } };
};
const readFrom = (rows: Array<Record<string, unknown>>) => async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: rows.filter((r) => r.id === p.id) } });

describe("feature_compose persists a route-edit gap at route time, so its landing has a row", () => {
  it("MUST-FAIL: a landing compose of an unstored route-edit id writes its row with the caller's edit_site and provenance", async () => {
    expect(typeof exported).toBe("function");
    const rec = recorder();
    const r = await persistRouteEditGap(routed(), { source: "caller" }, rec.write);
    expect(r.persisted).toBe(true);
    expect(rec.rows.length).toBe(1);
    const row = rec.rows[0]!;
    const meta = row.classification_metadata as Record<string, unknown>;
    expect({ id: row.id, category: row.category, status: row.status, edit_site: meta.edit_site }).toEqual({ id: "route-edit-849a2800", category: "edit_intent_route", status: "open", edit_site: SITE });
    expect(meta.route_edit_persisted).toMatchObject({ directed: true, authoring_execution_id: "dispatch-1", addressed_gap_id: "the-addressed-gap" });
    expect(String(row.summary)).toContain("does the thing");
  });
  it("MUST-FAIL: the cutover's own-check load then finds that row — unverifiable with a reason on the row, not 'no gap row'", async () => {
    const rec = recorder();
    await persistRouteEditGap(routed(), { source: "caller" }, rec.write);
    const before = await loadOwnCheck("development-vessel", "route-edit-849a2800", readFrom([]));
    const after = await loadOwnCheck("development-vessel", "route-edit-849a2800", readFrom(rec.rows));
    expect(before).toEqual({ status: "none", why: "no gap row route-edit-849a2800" });
    expect(after.status).toBe("none");
    expect((after as { row?: Record<string, unknown> }).row?.id).toBe("route-edit-849a2800");
    expect((after as { why: string }).why).toBe("gap route-edit-849a2800 carries no test_suite check for development-vessel");
  });
  it("MUST-FAIL (wiring): the resolver persists it right after the pre-prompt hydration of the gap", () => {
    const src = readFileSync(FC, "utf8");
    const hydrate = src.indexOf("const composeGap = await hydrateComposeGap(pointer.gap, readComposeGapRows);");
    const call = src.indexOf("await persistRouteEditGap(pointer, composeGap)");
    expect(hydrate).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(hydrate);
    expect(call - hydrate).toBeLessThan(600);
  });
  it("CONTROL: a normal gap's compose is unchanged, as are a stored route-edit row, an unreadable store and a non-landing compose", async () => {
    const cases: Array<[string, Record<string, unknown>, "store" | "caller" | "store_unreadable"]> = [
      ["stored normal gap", routed({ gap: { id: "a-stored-gap", classification_metadata: { edit_site: SITE } } }), "store"],
      ["unstored normal id", routed({ gap: { id: "pwt-1234", classification_metadata: { edit_site: SITE } } }), "caller"],
      ["route-edit step child", routed({ gap: { id: "route-edit-849a2800-step-1", classification_metadata: { edit_site: SITE } } }), "caller"],
      ["route-edit already stored", routed(), "store"],
      ["store unreadable", routed(), "store_unreadable"],
      ["non-landing compose", routed({ land: false }), "caller"],
    ];
    for (const [name, pointer, source] of cases) {
      const rec = recorder();
      const r = await persistRouteEditGap(pointer, { source }, rec.write);
      expect({ name, persisted: r.persisted, writes: rec.rows.length }).toEqual({ name, persisted: false, writes: 0 });
    }
    const stored = { id: "a-stored-gap", status: "open", classification_metadata: { edit_site: SITE, evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/x.test.ts", only_tests: ["x"] } } } };
    const load = await loadOwnCheck("development-vessel", "a-stored-gap", readFrom([stored]));
    expect(load.status).toBe("found");
  });
  it("CONTROL: a refused or throwing write reports not persisted (the compose goes on, as before)", async () => {
    const refused = await persistRouteEditGap(routed(), { source: "caller" }, async () => ({ shape: "structuredError", body: { detail: "no" } }));
    const threw = await persistRouteEditGap(routed(), { source: "caller" }, async () => { throw new Error("down"); });
    expect({ refused: refused.persisted, threw: threw.persisted }).toEqual({ refused: false, threw: false });
  });
});
