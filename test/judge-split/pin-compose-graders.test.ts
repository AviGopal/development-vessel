// BEHAVIOUR PIN: grading a compose outcome (judge split, extractions `gradeComposeOutcome` in resolveGapToFeatureOnce,
// `gradeSliceSequence` for the capacity-slice route, `gradeCapabilityCompose` in routeCapabilityGapToNewResolver).
// For each compose answer the stored row and the side effects are pinned:
//   - a genuine landing (FAVORABLE + a pushed cutover) goes to closeLandedGap: no bump;
//   - a non-attempt (BUSY/capacity) bumps nothing and releases the pick's cooldown;
//   - a terminal refusal bumps nothing;
//   - any other failure writes a class-posterior miss and bumps failed_attempts: +2 and mispredicted_lands +1 when
//     the self-model predicted a land (predictLand), +1 otherwise; an apply failure first escalates once to
//     patch_with_tools, whose held refusal is not graded;
//   - at the chronic threshold the bump escalates (escalateToDecomposition);
//   - a dry run grades nothing.
// Driven through resolveGapToFeature (targeted directed pointers, plus one auto-pick for the cooldown) over stored
// rows; feature_compose is a scripted stand-in. Written against the tree before the extraction; it must hold after.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, metaOf, writesFor, script, calls, tick, faTrail, posteriorWrites, readOverlay, COMPOSE, RUN, SCRATCH, type Row } from "./harness.js";

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fCredit = await import("../../src/judge/gap-attempt-credit.js");
const { resolveGapToFeature } = g2f;
const { gapClassOf } = g2fCredit;
const cooldowns = (): Map<string, number> => (resolveGapToFeature as unknown as { __test__gapComposeLastAttemptAt: () => Map<string, number> }).__test__gapComposeLastAttemptAt();

const VESSEL = `pingrade-${RUN}`;
const LITERAL = `http://pin-grade-literal-${RUN}`;
let n = 0;
/** A class-1 gap whose literal is present in its runtime site, so the pick-time check reads 'present' and the tick
 *  composes. Category is unique per gap, so predictLand's baseline is the 0.5 prior whatever calibration the process
 *  holds. */
function gap(tag: string, meta: Row = {}, extra: Row = {}): { id: string; site: string; file: string } {
  const id = `pin-grade-${tag}-${RUN}`;
  const rel = `src/grade-${++n}.ts`;
  const file = join(SCRATCH, "runtime", VESSEL, rel);
  mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
  writeFileSync(file, `export const url = "${LITERAL}";\n`);
  const site = `repos/${VESSEL}/${rel}`;
  seed({ id, category: `pin_cat_${tag}_${RUN}`, ...extra, classification_metadata: { falsifier: "class1", edit_site: site, hardcoded_url: LITERAL, ...meta } });
  return { id, site, file };
}
const directed = (id: string, extra: Row = {}) => tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: id, directed: true, ...extra } as never));
const clsOf = (id: string) => gapClassOf(stored(id)!);
const PICK_LOG = /pick-decisions\.jsonl$/;
let expectedFsBlocks: RegExp[] = [];

beforeEach(() => { beginPin(); expectedFsBlocks = [PICK_LOG]; });
afterEach(() => { expect(endPin(expectedFsBlocks)).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("gradeComposeOutcome: the main compose route", () => {
  it("[PIN] UNFAVORABLE on a gap predicted to land: posterior miss, failed_attempts +2, mispredicted_lands +1, decision joined", async () => {
    const g = gap("unfav-pred");
    const cls = clsOf(g.id);
    script.compose = [COMPOSE.unfavorable];
    const { result } = await directed(g.id);
    expect((result.body as Row).verdict).toBe("UNFAVORABLE");
    expect((result.body as Row).landed).toBe(false);
    expect(faTrail(g.id)).toEqual([0, 2]);
    expect(metaOf(g.id).mispredicted_lands).toBe(1);
    expect(typeof metaOf(g.id).last_failed_at).toBe("string");
    const decisions = metaOf(g.id).approach_decisions as Row[];
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.outcome?.landed).toBe(false);
    expect(posteriorWrites(cls).length).toBe(1);
    expect(calls.pwt.length).toBe(0);
    expect(stored(g.id)!.status).toBe("open");
  });

  it("[PIN] UNFAVORABLE on a gap NOT predicted to land: failed_attempts +1, mispredicted_lands 0", async () => {
    // "-recommit-" and "backlog" in the id lower landability to 0.45, under the 0.5 prior.
    const g = gap("backlog-recommit-nopred");
    script.compose = [COMPOSE.unfavorable];
    await directed(g.id);
    expect(faTrail(g.id)).toEqual([0, 1]);
    expect(metaOf(g.id).mispredicted_lands).toBe(0);
    expect(posteriorWrites(clsOf(g.id)).length).toBe(1);
  });

  it("[PIN] non-attempt (BUSY/capacity): no bump, no posterior write", async () => {
    const g = gap("busy");
    script.compose = [COMPOSE.busy];
    const { result, lines } = await directed(g.id);
    expect((result.body as Row).verdict).toBe("BUSY");
    expect(faTrail(g.id)).toEqual([0]);
    expect(posteriorWrites(clsOf(g.id)).length).toBe(0);
    expect(lines.some((l) => l.includes(`non-attempt (failure_kind=-, verdict=BUSY, stage=capacity) for gap ${g.id} — clearing cooldown`))).toBe(true);
  });

  it("[PIN] terminal refusal: no bump, no posterior write", async () => {
    const g = gap("terminal");
    script.compose = [COMPOSE.terminal("the gap is closed")];
    const { lines } = await directed(g.id);
    expect(faTrail(g.id)).toEqual([0]);
    expect(posteriorWrites(clsOf(g.id)).length).toBe(0);
    expect(lines).toContain(`[gap-to-feature] terminal refusal for ${g.id}: the gap is closed; no bump, full cooldown`);
  });

  it("[PIN] FAVORABLE but staged only (no pushed cutover): not a landing; graded as a failure", async () => {
    const g = gap("staged");
    script.compose = [COMPOSE.stagedOnly];
    const { result } = await directed(g.id);
    expect((result.body as Row).landed).toBe(false);
    expect(faTrail(g.id)).toEqual([0, 2]);
  });

  it("[PIN] dry run: nothing graded", async () => {
    const g = gap("dry");
    script.compose = [COMPOSE.unfavorable];
    await directed(g.id, { dry_run: true });
    expect(faTrail(g.id)).toEqual([0]);
    expect(posteriorWrites(clsOf(g.id)).length).toBe(0);
    expect(calls.compose[0]!.dry_run).toBe(true);
  });

  it("[PIN] a genuine landing goes to the close path, never to the bump", async () => {
    const g = gap("landed");
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    // The compose stand-in "lands the fix": the literal leaves the runtime file before the close re-measures.
    script.compose = [() => { writeFileSync(g.file, "export const url = null;\n"); return COMPOSE.landed(sha); }];
    const { result } = await directed(g.id);
    const body = result.body as Row;
    expect(body.landed).toBe(true);
    expect(body.landed_commit).toBe(sha);
    expect(faTrail(g.id)).toEqual([0]);
    expect(posteriorWrites(clsOf(g.id)).length).toBe(0);
    expect(body.gap_closed).toBe(false);
    expect(metaOf(g.id).pending_outcome_verification).toBe(sha);
    expect(metaOf(g.id).disposition).toBe("pending_verification");
    expect(stored(g.id)!.status).toBe("open");
  });

  describe("apply failure: one patch_with_tools escalation, then the grade", () => {
    it("[PIN] pwt does not land: pwt called once on the edit site, then posterior miss and failed_attempts +2", async () => {
      const g = gap("apply");
      script.compose = [COMPOSE.applyFailed];
      await directed(g.id);
      expect(calls.pwt.length).toBe(1);
      expect(calls.pwt[0]!.target_file).toBe(g.site);
      expect(calls.pwt[0]!.gap_id).toBe(g.id);
      expect(faTrail(g.id)).toEqual([0, 2]);
      expect(posteriorWrites(clsOf(g.id)).length).toBe(1);
    });

    it("[PIN] pwt refused under the live-tree hold: not graded; only the held stamp is written", async () => {
      const g = gap("apply-held");
      script.compose = [COMPOSE.applyFailed];
      script.pwt = { shape: "patchWithToolsReport", body: { ok: false, verdict: "REFUSED", stage: "live_tree_writes_held", hold_id: "pin-hold", why: "operator hold" } };
      await directed(g.id);
      expect(calls.pwt.length).toBe(1);
      expect(faTrail(g.id)).toEqual([0]);
      expect(posteriorWrites(clsOf(g.id)).length).toBe(0);
      const held = metaOf(g.id).pwt_escalation_held as Row;
      expect(held.stage).toBe("live_tree_writes_held");
      expect(held.hold_id).toBe("pin-hold");
      expect(metaOf(g.id).pwt_escalated).toBeUndefined();
    });
  });

  it("[PIN] the bump that reaches the chronic threshold escalates (escalateToDecomposition reads the stored row)", async () => {
    const g = gap("chronic", { failed_attempts: 2, decomposed_at: "2026-10-01T00:00:00.000Z", decomposition: { children: ["pin-step-1"] } });
    script.compose = [COMPOSE.unfavorable];
    const { lines } = await directed(g.id);
    // landability 0.9 - 0.2 = 0.7 >= the 0.5 prior: a predicted land, so the bump is +2.
    expect(faTrail(g.id, 2)).toEqual([2, 4]);
    expect(lines).toContain(`[gap-to-feature] NOT narrowing ${g.id}: no failure_lessons recorded — the child would be a verbatim duplicate`);
    expect(lines).toContain(`[gap-to-feature] ${g.id} already decomposed at 2026-10-01T00:00:00.000Z; not decomposed again`);
  });

  it("[PIN] auto-pick: a non-attempt releases the cooldown the pick stamped; a failure keeps it", async () => {
    const busy = gap("auto-busy");
    script.compose = [COMPOSE.busy];
    const t1 = await tick(() => resolveGapToFeature({ type: "gap_to_feature" } as never));
    expect((t1.result.body as Row).gap_id).toBe(busy.id);
    expect(cooldowns().has(busy.id)).toBe(false);
    expect(faTrail(busy.id)).toEqual([0]);

    const fail = gap("auto-fail");
    stored(busy.id)!.status = "closed";
    script.compose = [COMPOSE.unfavorable];
    const before = Date.now();
    const t2 = await tick(() => resolveGapToFeature({ type: "gap_to_feature" } as never));
    expect((t2.result.body as Row).gap_id).toBe(fail.id);
    expect(cooldowns().get(fail.id) ?? 0).toBeGreaterThanOrEqual(before);
    expect(faTrail(fail.id)).toEqual([0, 2]);
  });
});

describe("gradeSliceSequence: the capacity-slice route", () => {
  /** failed_attempts >= 2 and a compose report with capacity evidence naming two files: the tick slices. */
  function sliced(tag: string): { id: string } {
    const g = gap(tag, { failed_attempts: 2, decomposed_at: "2026-10-01T00:00:00.000Z", decomposition: { children: ["pin-step-1"] }, suspected_real_location: `repos/${VESSEL}/src/slice-a.ts repos/${VESSEL}/src/slice-b.ts` });
    readOverlay.set(`/workspace/proposals/${g.id}-compose-report.json`, JSON.stringify({ op_count: 25, verify: [] }));
    return g;
  }

  it("[PIN] every slice FAVORABLE and pushed: one close-path call with the last slice's commit, no bump", async () => {
    const g = sliced("slices-land");
    const sha = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    script.compose = [COMPOSE.landed("c0ffee0000000000000000000000000000000001"), () => { writeFileSync(join(SCRATCH, "runtime", VESSEL, `src/grade-${n}.ts`), "export const url = null;\n"); return COMPOSE.landed(sha); }];
    const { result, lines } = await directed(g.id);
    const body = result.body as Row;
    expect(body.route).toBe("capacity_slice_sequence");
    expect(calls.compose.length).toBe(2);
    expect(body.landed).toBe(true);
    expect(body.landed_commit).toBe(sha);
    expect(faTrail(g.id, 2)).toEqual([2]);
    expect(lines).toContain("[gap-to-feature] reach verdict: SUCCESS");
    expect(metaOf(g.id).pending_outcome_verification).toBe(sha);
  });

  it("[PIN] the first slice UNFAVORABLE: the sequence stops, one posterior miss and one bump (+1: the slice route never predicts)", async () => {
    const g = sliced("slices-fail");
    script.compose = [COMPOSE.unfavorable];
    const { result } = await directed(g.id);
    expect(calls.compose.length).toBe(1);
    expect((result.body as Row).ok).toBe(false);
    expect(faTrail(g.id, 2)).toEqual([2, 3]);
    expect(posteriorWrites(clsOf(g.id)).length).toBe(1);
  });

  it("[PIN] a slice BUSY: a non-attempt; no bump, no posterior", async () => {
    const g = sliced("slices-busy");
    script.compose = [COMPOSE.busy];
    await directed(g.id);
    expect(calls.compose.length).toBe(1);
    expect(faTrail(g.id, 2)).toEqual([2]);
    expect(posteriorWrites(clsOf(g.id)).length).toBe(0);
  });

  it("[PIN] a slice terminal refusal: no bump", async () => {
    const g = sliced("slices-terminal");
    script.compose = [COMPOSE.terminal("the gap is closed")];
    const { lines } = await directed(g.id);
    expect(faTrail(g.id, 2)).toEqual([2]);
    expect(lines).toContain(`[gap-to-feature] terminal refusal for ${g.id}: the gap is closed; no bump, full cooldown`);
  });

  it("[PIN] dry run: nothing graded", async () => {
    const g = sliced("slices-dry");
    script.compose = [COMPOSE.unfavorable];
    await directed(g.id, { dry_run: true });
    expect(faTrail(g.id, 2)).toEqual([2]);
  });
});

describe("gradeCapabilityCompose (and the route's own outer bump): a capability_gap routed to a new resolver", () => {
  function capGap(tag: string, meta: Row = {}): string {
    const id = `pin-cap-${tag}-${RUN}`;
    seed({ id, category: `pin_capcat_${tag}_${RUN}`, summary: `walk needs pin_shape_${tag}`, classification_metadata: { kind: "capability_gap", missing_shape: `pin_shape_${tag}`, goal: `a goal needing pin_shape_${tag}`, ...meta } });
    return id;
  }

  it("[PIN] UNFAVORABLE: the route bumps (+1) and the caller bumps again (+1): failed_attempts 0 -> 1 -> 2", async () => {
    const id = capGap("unfav");
    script.compose = [COMPOSE.unfavorable];
    const { result } = await directed(id);
    expect((result.body as Row).route).toBe("capability_gap_via_feature_compose");
    expect(calls.compose[0]!.directed).toBe(true);
    expect(faTrail(id)).toEqual([0, 1, 2]);
    expect(posteriorWrites(clsOf(id)).length).toBe(1);
  });

  it("[PIN] BUSY: no bump in the route, but the caller's ok:false bump still fires (+1)", async () => {
    const id = capGap("busy");
    script.compose = [COMPOSE.busy];
    await directed(id);
    expect(faTrail(id)).toEqual([0, 1]);
    expect(posteriorWrites(clsOf(id)).length).toBe(0);
  });

  it("[PIN] terminal refusal: no bump in the route; the caller bumps (+1)", async () => {
    const id = capGap("terminal");
    script.compose = [COMPOSE.terminal("the gap is closed")];
    await directed(id);
    expect(faTrail(id)).toEqual([0, 1]);
  });

  it("[PIN] a genuine landing: the close path, ok:true, no bump anywhere", async () => {
    const id = capGap("landed");
    const sha = "d1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    script.compose = [COMPOSE.landed(sha)];
    const { result } = await directed(id);
    const body = result.body as Row;
    expect(body.landed).toBe(true);
    expect(body.ok).toBe(true);
    expect(faTrail(id)).toEqual([0]);
    expect(metaOf(id).pending_outcome_verification).toBe(sha);
  });

  it("[PIN] no walk demand (no goal): skipped without composing; the caller bumps (+1)", async () => {
    const id = capGap("nogoal", { goal: "" });
    const { result } = await directed(id);
    expect((result.body as Row).route).toBe("capability_gap_skipped");
    expect(calls.compose.length).toBe(0);
    expect(faTrail(id)).toEqual([0, 1]);
  });

  it("[PIN] dry run: a plan, nothing graded", async () => {
    const id = capGap("dry");
    script.compose = [COMPOSE.unfavorable];
    const { result } = await directed(id, { dry_run: true });
    expect((result.body as Row).verdict).toBe("plan");
    expect(faTrail(id)).toEqual([0]);
  });
});
