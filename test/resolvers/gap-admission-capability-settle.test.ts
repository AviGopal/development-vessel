// THE CAPABILITY ROUTE'S OWN PICK-CONDITION SETTLE (gap-to-feature judge split, A2: settlePickConditionAtCapabilityRoute).
//
// routeCapabilityGapToNewResolver carries its own copy of the pick-time check. From the entry point it is unreachable:
// the main settle has already answered 'absent' and 'pending' on the same gap object (pin-bump-close-settles.test.ts
// states this and pins the reachable equivalent). The judge-split pins can therefore not see a change to this copy, so
// it is pinned here by a direct call over stored rows, through the same harness (fixture store, guarded fetch, fs and
// exec). The expectations are the original block's, verbatim: an absent condition closes already_resolved by
// gap_to_feature.pick_condition_check; a single unmeasured landing is held pending_verification with this copy's own
// note; a present condition settles nothing. Mutant: the settle answering null always -> red.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, metaOf, writesFor, RUN, SCRATCH } from "../judge-split/harness.js";

const { settlePickConditionAtCapabilityRoute } = await import("../../src/judge/gap-admission.js");

const VESSEL = `capsettle-${RUN}`;
const LITERAL = `http://cap-settle-literal-${RUN}`;
let n = 0;
function site(withLiteral: boolean): string {
  const rel = `src/cap-settle-${++n}.ts`;
  mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "runtime", VESSEL, rel), withLiteral ? `export const u = "${LITERAL}";\n` : "export const u = null;\n");
  return `repos/${VESSEL}/${rel}`;
}
const idOf = (tag: string) => `cap-settle-${tag}-${RUN}`;
const cap = (meta: Record<string, unknown>) => ({ kind: "capability_gap", missing_shape: "cap_settle_shape", goal: "a goal", falsifier: "class1", ...meta });

beforeEach(() => beginPin());
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("settlePickConditionAtCapabilityRoute", () => {
  it("[MUST-FAIL] absent: closed already_resolved by gap_to_feature.pick_condition_check, with the report", async () => {
    const id = idOf("absent");
    seed({ id, classification_metadata: cap({ edit_site: site(false), hardcoded_url: LITERAL }) });
    const r = await settlePickConditionAtCapabilityRoute(stored(id)! as Record<string, unknown>);
    expect(r).toEqual({ shape: "gapToFeatureReport", body: { ok: true, gap_id: id, gap_category: "systematic_failure", verdict: "already_resolved", note: "gap condition absent at pick time — closed as already_resolved" } });
    const row = stored(id)!;
    expect(row.status).toBe("closed");
    expect(row.classification_metadata.closed_reason).toBe("already_resolved");
    expect(row.classification_metadata.closed_by).toBe("gap_to_feature.pick_condition_check");
    expect(writesFor(id).map((w) => w.status)).toEqual(["closed"]); // the one close write (no pick ran: no decision write)
  });

  it("[MUST-FAIL] pending: held pending_verification with this copy's own note", async () => {
    const id = idOf("pending");
    seed({ id, classification_metadata: cap({ edit_site: site(false), hardcoded_url: LITERAL, predicate_source: "removed_line_of_landing_commit" }) });
    const r = await settlePickConditionAtCapabilityRoute(stored(id)! as Record<string, unknown>);
    expect(r).toEqual({ shape: "gapToFeatureReport", body: { ok: true, gap_id: id, gap_category: "systematic_failure", verdict: "pending_verification", note: "landed once but unmeasured — held pending verification; not re-composed" } });
    const m = metaOf(id);
    expect(stored(id)!.status).toBe("open");
    expect(m.disposition).toBe("pending_verification");
    expect(m.pending_note).toBe("pending at pick time: landed once, no measurement predicate — persisted so the candidate filter can exclude it");
  });

  it("[CONTROL] present: nothing settled, nothing written", async () => {
    const id = idOf("present");
    seed({ id, classification_metadata: cap({ edit_site: site(true), hardcoded_url: LITERAL }) });
    const before = writesFor(id).length;
    expect(await settlePickConditionAtCapabilityRoute(stored(id)! as Record<string, unknown>)).toBeNull();
    expect(writesFor(id).length).toBe(before);
    expect(stored(id)!.status).toBe("open");
  });
});
