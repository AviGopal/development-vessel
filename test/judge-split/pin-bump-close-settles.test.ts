// BEHAVIOUR PIN: the route settles and bumps (judge split, extractions `settlePickCondition`,
// `settlePickConditionAtCapabilityRoute`, `settleReachabilityRepair`, `settleAuthorProducerMint`,
// `gradeTraceStoreDispatch`, `gradeCapabilityRouteResult`).
//   - pick-time condition: a class-1 literal already absent closes the gap already_resolved
//     (gap_to_feature.pick_condition_check) without composing; a single unmeasured landing ('pending') is held
//     pending_verification without composing; 'present' composes.
//   - unreachable_producer → reachability_gap_repair: FAVORABLE closes producer_now_exists, anything else bumps.
//   - orphaned_capability → author_producer: a mint closes producer_now_exists, a failed mint bumps.
//   - trace_store_reconciliation → goal-host /run-goal: dispatched writes the dispatched_at marker, a retryable 503
//     (draining) is no attempt, any other failure or a throw bumps.
//   - capability_gap: the caller bumps on any ok:false route result (pinned with the graders in
//     pin-compose-graders.test.ts; the skip path is pinned here too).
//   - a dry run settles and bumps nothing.
// Driven through resolveGapToFeature over stored rows. Written against the tree before the extraction; it must hold
// after it.
//
// UNREACHABLE AT BASE, stated: settlePickConditionAtCapabilityRoute (routeCapabilityGapToNewResolver's own copy of
// the pick-time check) runs the same verifyGapCondition on the same gap object after the main pick-time check has
// already returned for 'absent' and 'pending', with nothing in between that changes the gap or its site. It is
// therefore unreachable from the entry point. The capability case below pins the reachable equivalent: an absent
// capability_gap closes through the main settle and never reaches the capability route.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, metaOf, writesFor, script, calls, route, hitsOf, tick, faTrail, RUN, SCRATCH, type Row } from "./harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const VESSEL = `pinsettle-${RUN}`;
const LITERAL = `http://pin-settle-literal-${RUN}`;
let n = 0;
function site(withLiteral: boolean): string {
  const rel = `src/settle-${++n}.ts`;
  mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "runtime", VESSEL, rel), withLiteral ? `export const u = "${LITERAL}";\n` : "export const u = null;\n");
  return `repos/${VESSEL}/${rel}`;
}
const idOf = (tag: string) => `pin-settle-${tag}-${RUN}`;
const directed = (id: string, extra: Row = {}) => tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: id, directed: true, ...extra } as never));

beforeEach(() => beginPin());
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("pick-time condition settle", () => {
  it("[PIN] absent: closed already_resolved by gap_to_feature.pick_condition_check; nothing composed", async () => {
    const id = idOf("absent");
    seed({ id, classification_metadata: { falsifier: "class1", edit_site: site(false), hardcoded_url: LITERAL } });
    const { result } = await directed(id);
    expect(result.body).toEqual({ ok: true, gap_id: id, gap_category: "systematic_failure", verdict: "already_resolved", note: "gap condition absent at pick time — closed as already_resolved" });
    const row = stored(id)!;
    expect(row.status).toBe("closed");
    expect(row.classification_metadata.closed_reason).toBe("already_resolved");
    expect(row.classification_metadata.resolution).toBe("already_resolved");
    expect(row.classification_metadata.closed_by).toBe("gap_to_feature.pick_condition_check");
    expect(writesFor(id).map((w) => w.status)).toEqual(["open", "closed"]);
    expect(calls.compose.length).toBe(0);
  });

  it("[PIN] pending (a landing-derived sentinel reads absent): held pending_verification; nothing composed", async () => {
    const id = idOf("pending");
    seed({ id, classification_metadata: { falsifier: "class1", edit_site: site(false), hardcoded_url: LITERAL, predicate_source: "removed_line_of_landing_commit" } });
    const { result, lines } = await directed(id);
    expect(result.body).toEqual({ ok: true, gap_id: id, gap_category: "systematic_failure", verdict: "pending_verification", note: "landed once but unmeasured — held pending verification; not re-composed" });
    expect(lines).toContain(`[gap-to-feature] gap ${id} PENDING verification at pick time — skipping re-compose`);
    const m = metaOf(id);
    expect(stored(id)!.status).toBe("open");
    expect(m.disposition).toBe("pending_verification");
    expect(m.pending_outcome_verification).toBe("unknown");
    expect(m.pending_note).toBe("pending at pick time (site B): landed once, no measurement predicate — persisted so the candidate filter can exclude it");
    expect(calls.compose.length).toBe(0);
  });

  it("[PIN] pending on a gap held needs_information: the parking disposition is kept", async () => {
    const id = idOf("pending-parked");
    seed({ id, classification_metadata: { falsifier: "class1", edit_site: site(false), hardcoded_url: LITERAL, predicate_source: "removed_line_of_landing_commit", disposition: "needs_information" } });
    await directed(id);
    expect(metaOf(id).disposition).toBe("needs_information");
    expect(metaOf(id).pending_outcome_verification).toBe("unknown");
  });

  it("[CONTROL] present: no settle; composes", async () => {
    const id = idOf("present");
    seed({ id, classification_metadata: { falsifier: "class1", edit_site: site(true), hardcoded_url: LITERAL } });
    const { result } = await directed(id);
    expect((result.body as Row).verdict).toBe("BUSY");
    expect(calls.compose.length).toBe(1);
    expect(stored(id)!.status).toBe("open");
  });

  it("[PIN] a capability_gap whose condition is absent closes through the main settle and never reaches its route", async () => {
    const id = idOf("cap-absent");
    seed({ id, classification_metadata: { kind: "capability_gap", missing_shape: "pin_cap_shape", goal: "a goal", falsifier: "class1", edit_site: site(false), hardcoded_url: LITERAL } });
    const { result } = await directed(id);
    expect((result.body as Row).verdict).toBe("already_resolved");
    expect((result.body as Row).route).toBeUndefined();
    expect(stored(id)!.classification_metadata.closed_by).toBe("gap_to_feature.pick_condition_check");
    expect(calls.compose.length).toBe(0);
    expect(faTrail(id)).toEqual([0]);
  });
});

describe("unreachable_producer → reachability_gap_repair", () => {
  const seedRP = (tag: string) => { const id = idOf(tag); seed({ id, category: "unreachable_producer", classification_metadata: { shape: "pin_rp_shape" } }); return id; };

  it("[PIN] FAVORABLE: closed producer_now_exists by reachability_gap_repair; no bump", async () => {
    const id = seedRP("rp-fav");
    script.reachability = { shape: "reachabilityGapRepairReport", body: { verdict: "FAVORABLE", detail: "pin" } };
    const { result } = await directed(id);
    expect(result.body).toEqual({ ok: true, stage: "route_reachability", gap_id: id, gap_category: "unreachable_producer", route: "reachability_gap_repair", repair: { verdict: "FAVORABLE", detail: "pin" } });
    expect(calls.reachability).toEqual([{ type: "reachability_gap_repair", gap_id: id, dry_run: undefined }]);
    const row = stored(id)!;
    expect(row.status).toBe("closed");
    expect(row.classification_metadata.closed_reason).toBe("producer_now_exists");
    expect(row.classification_metadata.closed_by).toBe("reachability_gap_repair");
    expect(faTrail(id)).toEqual([0]);
  });

  it("[PIN] not FAVORABLE: bumped +1, left open", async () => {
    const id = seedRP("rp-unfav");
    const { result } = await directed(id);
    expect((result.body as Row).ok).toBe(false);
    expect(faTrail(id)).toEqual([0, 1]);
    expect(stored(id)!.status).toBe("open");
  });

  it("[PIN] dry run: neither close nor bump", async () => {
    const id = seedRP("rp-dry");
    script.reachability = { shape: "reachabilityGapRepairReport", body: { verdict: "FAVORABLE" } };
    await directed(id, { dry_run: true });
    expect(calls.reachability[0]!.dry_run).toBe(true);
    expect(stored(id)!.status).toBe("open");
    expect(faTrail(id)).toEqual([0]);
  });
});

describe("orphaned_capability → author_producer", () => {
  const seedOC = (tag: string, meta: Row = { shape: "pin_orphan_shape" }) => { const id = idOf(tag); seed({ id, category: "orphaned_capability", summary: `Author an activity that invokes resolver pin_${tag}`, classification_metadata: meta }); return id; };

  it("[PIN] minted: closed producer_now_exists by author_producer; no bump", async () => {
    const id = seedOC("oc-mint");
    script.author = { shape: "author_producer", body: { minted_activity_id: "pin-bridge", two_task_bridge: true } };
    const { result } = await directed(id);
    const body = result.body as Row;
    expect(body.verdict).toBe("MINTED");
    expect(body.minted_activity_id).toBe("pin-bridge");
    expect(calls.author).toEqual([{ type: "author_producer", shape: "pin_orphan_shape", goal: `Author an activity that invokes resolver pin_oc-mint` }]);
    const row = stored(id)!;
    expect(row.status).toBe("closed");
    expect(row.classification_metadata.closed_reason).toBe("producer_now_exists");
    expect(row.classification_metadata.closed_by).toBe("author_producer");
    expect(faTrail(id)).toEqual([0]);
  });

  it("[PIN] mint failed: bumped +1, left open", async () => {
    const id = seedOC("oc-fail");
    const { result } = await directed(id);
    expect((result.body as Row).verdict).toBe("MINT_FAILED");
    expect(faTrail(id)).toEqual([0, 1]);
    expect(stored(id)!.status).toBe("open");
  });

  it("[PIN] no shape: refused before any mint; no bump", async () => {
    const id = seedOC("oc-noshape", {});
    const { result } = await directed(id);
    expect((result.body as Row).error).toBe("orphaned_capability gap missing classification_metadata.shape");
    expect(calls.author.length).toBe(0);
    expect(faTrail(id)).toEqual([0]);
  });

  it("[PIN] dry run: a plan, no mint, no close, no bump", async () => {
    const id = seedOC("oc-dry");
    const { result } = await directed(id, { dry_run: true });
    expect((result.body as Row).verdict).toBe("plan");
    expect(calls.author.length).toBe(0);
    expect(faTrail(id)).toEqual([0]);
  });
});

describe("trace_store_reconciliation → goal-host run-goal", () => {
  const pathIs = (re: RegExp) => (u: string) => { try { return re.test(new URL(u).pathname); } catch { return false; } };
  function routeTraceStore(runGoal: () => Response): void {
    route({ name: "variants", match: pathIs(/^\/v2\/activities\/[^/]+\/variants$/), respond: () => Response.json({ variants: [] }) });
    route({ name: "templates", match: pathIs(/^\/v2\/activities\/templates$/), respond: () => Response.json({ templates: [] }) });
    route({ name: "posterior", match: (u, b) => pathIs(/^\/v2\/impulses\/resolve$/)(u) && b?.impulse?.pointer?.type === "thompson_posterior", respond: () => Response.json({ content: "" }) });
    route({ name: "run-goal", match: pathIs(/^\/run-goal$/), respond: runGoal });
  }
  const seedTS = (tag: string) => { const id = idOf(tag); seed({ id, category: "trace_store_reconciliation", classification_metadata: {} }); return id; };

  it("[PIN] dispatched (200): the dispatched_at marker is written, status open, no bump", async () => {
    const id = seedTS("ts-ok");
    routeTraceStore(() => Response.json({ ok: true, dispatchId: "pin" }));
    const { result } = await directed(id);
    const body = result.body as Row;
    expect(body.ok).toBe(true);
    expect(body.dispatch_status).toBe(200);
    expect(hitsOf("run-goal").length).toBe(1);
    expect(hitsOf("run-goal")[0]!.body.targetTemplateId).toBe("development-vessel:trace-store-reconcile");
    expect(metaOf(id).dispatch_route).toBe("trace-store-reconcile");
    expect(typeof metaOf(id).dispatched_at).toBe("string");
    expect(stored(id)!.status).toBe("open");
    expect(faTrail(id)).toEqual([0]);
  });

  it("[PIN] a retryable 503 (goal-host draining): no attempt, no bump, no marker", async () => {
    const id = seedTS("ts-drain");
    routeTraceStore(() => new Response(JSON.stringify({ draining: true }), { status: 503 }));
    const { result, lines } = await directed(id);
    expect((result.body as Row).ok).toBe(false);
    expect(faTrail(id)).toEqual([0]);
    expect(metaOf(id).dispatched_at).toBeUndefined();
    expect(lines.some((l) => l.includes(`trace-store-reconcile for ${id}: goal-host refused retryably (503`))).toBe(true);
  });

  it("[PIN] any other failure status (500): bumped +1", async () => {
    const id = seedTS("ts-500");
    routeTraceStore(() => new Response("boom", { status: 500 }));
    const { result } = await directed(id);
    expect((result.body as Row).dispatch_status).toBe(500);
    expect(faTrail(id)).toEqual([0, 1]);
  });

  it("[PIN] a 503 that does not say draining is a real failure: bumped +1", async () => {
    const id = seedTS("ts-503");
    routeTraceStore(() => new Response(JSON.stringify({ error: "overloaded" }), { status: 503 }));
    await directed(id);
    expect(faTrail(id)).toEqual([0, 1]);
  });

  it("[PIN] the dispatch throws: bumped +1, error report", async () => {
    const id = seedTS("ts-throw");
    routeTraceStore(() => { throw new TypeError("pin: goal-host unreachable"); });
    const { result } = await directed(id);
    expect((result.body as Row).error).toBe("pin: goal-host unreachable");
    expect(faTrail(id)).toEqual([0, 1]);
  });

  it("[PIN] dry run: a plan, no dispatch, no bump", async () => {
    const id = seedTS("ts-dry");
    routeTraceStore(() => Response.json({ ok: true }));
    const { result } = await directed(id, { dry_run: true });
    expect((result.body as Row).dry_run).toBe(true);
    expect(hitsOf("run-goal").length).toBe(0);
    expect(faTrail(id)).toEqual([0]);
  });
});

describe("capability_gap: the caller's bump on an ok:false route result", () => {
  it("[PIN] skipped for no walk demand: bumped +1 by the caller; a dry run is not bumped", async () => {
    const id = idOf("cap-skip");
    seed({ id, classification_metadata: { kind: "capability_gap", missing_shape: "pin_cap_skip" } });
    await directed(id);
    expect(faTrail(id)).toEqual([0, 1]);
    const dry = idOf("cap-skip-dry");
    seed({ id: dry, classification_metadata: { kind: "capability_gap", missing_shape: "pin_cap_skip" } });
    await directed(dry, { dry_run: true });
    expect(faTrail(dry)).toEqual([0]);
  });

  it("[PIN] a shape with no snake_case resolver name: refused, and the caller bumps +1", async () => {
    const id = idOf("cap-badname");
    seed({ id, classification_metadata: { kind: "capability_gap", missing_shape: "!!!", goal: "g" } });
    const { result } = await directed(id);
    expect(String((result.body as Row).error)).toContain("cannot derive snake_case resolver name");
    expect(faTrail(id)).toEqual([0, 1]);
  });
});
