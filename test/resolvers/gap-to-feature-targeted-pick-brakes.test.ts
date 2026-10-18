// THE TARGETED ENTRY ASKS THE PICK BRAKES (gapPickRefusal).
//
// gap-drain-observer posts gap_to_feature WITH gap_id ({gap_id, triggered_by:"gap-drain"}) on every completion scan.
// Every pick brake (durable backoff, reconcile skip, in-flight hold, cooldown) was applied on the auto-pick path only,
// so one trace_store_reconciliation gap at failed_attempts 138, whose backoff is the 24 h cap, was dispatched to
// goal-host ~10x/h. The targeted entry now asks the same predicate as the auto-pick filter and refuses a non-directed
// pick with a non-attempt body naming the predicate. Controls: a directed pick still dispatches; a gap with no
// failures still dispatches. The auto-pick control is the judge-split pins, run alone beside this file.
// Driven through resolveGapToFeature over stored rows, with the judge-split harness (fixture store, guarded fetch).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { beginPin, endPin, restoreHarness, seed, stored, metaOf, route, hitsOf, tick, faTrail, RUN, type Row } from "../judge-split/harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const idOf = (tag: string) => `targeted-brakes-${tag}-${RUN}`;
const drain = (id: string, extra: Row = {}) => tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: id, triggered_by: "gap-drain", ...extra } as never));
const pathIs = (re: RegExp) => (u: string) => { try { return re.test(new URL(u).pathname); } catch { return false; } };
function routeTraceStore(): void {
  route({ name: "variants", match: pathIs(/^\/v2\/activities\/[^/]+\/variants$/), respond: () => Response.json({ variants: [] }) });
  route({ name: "templates", match: pathIs(/^\/v2\/activities\/templates$/), respond: () => Response.json({ templates: [] }) });
  route({ name: "posterior", match: (u, b) => pathIs(/^\/v2\/impulses\/resolve$/)(u) && b?.impulse?.pointer?.type === "thompson_posterior", respond: () => Response.json({ content: "" }) });
  route({ name: "run-goal", match: pathIs(/^\/run-goal$/), respond: () => Response.json({ ok: true, dispatchId: "brakes" }) });
}
const anHourAgo = () => new Date(Date.now() - 60 * 60_000).toISOString();
const seedTS = (tag: string, meta: Row) => { const id = idOf(tag); seed({ id, category: "trace_store_reconciliation", classification_metadata: meta }); return id; };

beforeEach(() => { beginPin(); routeTraceStore(); });
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("targeted gap_to_feature: the shared pick brakes", () => {
  it("[MUST-FAIL] fa 138 inside its 24 h backoff: a gap-drain pick is refused as a non-attempt naming backoff; no /run-goal, no bump", async () => {
    const id = seedTS("backed-off", { failed_attempts: 138, last_failed_at: anHourAgo() });
    const { result, lines } = await drain(id);
    expect(hitsOf("run-goal").length).toBe(0);
    const body = result.body as Row;
    expect(body.ok).toBe(false);
    expect(body.verdict).toBe("REFUSED");
    expect(body.non_attempt).toBe(true);
    expect(body.refused_by).toBe("backoff");
    expect(body.reason).toBe("pick_refused_backoff");
    expect((body.detail as Row).lineage_attempts).toBe(138);
    expect((body.detail as Row).remaining_ms).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith(`[gap-to-feature] targeted pick refused: gap ${id} → {"backoff":1}`)).length).toBe(1);
    expect(metaOf(id).dispatched_at).toBeUndefined();
    expect(stored(id)!.status).toBe("open");
    expect(faTrail(id, 138)).toEqual([138]);
  });

  it("[CONTROL] the same gap picked directed still dispatches", async () => {
    const id = seedTS("directed", { failed_attempts: 138, last_failed_at: anHourAgo() });
    const { result } = await drain(id, { directed: true });
    expect(hitsOf("run-goal").length).toBe(1);
    expect((result.body as Row).ok).toBe(true);
  });

  it("[CONTROL] a gap with no failures: a gap-drain pick dispatches as before", async () => {
    const id = seedTS("fresh", {});
    const { result } = await drain(id);
    expect(hitsOf("run-goal").length).toBe(1);
    expect((result.body as Row).ok).toBe(true);
    expect(typeof metaOf(id).dispatched_at).toBe("string");
  });

  it("[CONTROL] backoff served out (last failure 25 h ago): a gap-drain pick dispatches", async () => {
    const id = seedTS("served", { failed_attempts: 138, last_failed_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
    await drain(id);
    expect(hitsOf("run-goal").length).toBe(1);
  });
});
