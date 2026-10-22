// ADDENDUM 2a LINEAGE (USER RULING 2026-10-21T09:47:33Z), PORTED: the research watcher's test_lineage cases, run against
// operator-acts.ts (lineageAncestors, rowFieldOperatorActs) instead of the watcher's own Python. A hold OR a release on
// the row or ANY lineage ancestor is an operator act in the fix's provenance; ancestry follows the explicit links AND
// the id rule (recommit- PREPENDED, -<suffix> appended).
//
// The real ids come from ONE archive snapshot, vendored as test/self-fact-evaluator/fixtures/lineage-archive-rows.json (only
// the fields lineage reads), so these must-fail cases never depend on the live store. Each case is named by its frozen
// case id (fixtures-manifest.json) and that id's sha256 prefix; case ids are never renamed.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineageAncestors, rowFieldOperatorActs, type GapRow } from "../../src/resolvers/operator-acts.js";

const FIX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "lineage-archive-rows.json"), "utf8")) as { rows: GapRow[] };
const byid = new Map<string, GapRow>(FIX.rows.map((r) => [String(r["id"]), r]));
const ts = (s: string) => Date.parse(s);
const anc = (gid: string, m: ReadonlyMap<string, GapRow>) => lineageAncestors(gid, m);
const acts = (gid: string, m: ReadonlyMap<string, GapRow>, until: number) => rowFieldOperatorActs(gid, m, until).length > 0;

const P = "failing-test-activity-api-src-services-phase5-integration-test-ts-gen-assert-r202610160128-narrowed-verify_failed-step-2";
const cand = "recommit-recommit-" + P + "-verify_failed";
// The three rows held 09:13:10-20Z (synthesized: they postdate the snapshot, or are replaced by the held form).
const H: Record<string, string> = {
  "recommit-recommit-prior-seeding-x-step-3-verify_failed": "2026-10-21T09:13:10Z",
  "recommit-prior-seeding-x-step-1": "2026-10-21T09:13:15Z",
  "failing-test-activity-api-src-services-phase5-integration-test-ts-gen-assert-r202610210647": "2026-10-21T09:13:20Z",
};
const fake = new Map<string, GapRow>(byid);
for (const [i, at] of Object.entries(H)) fake.set(i, { id: i, classification_metadata: { operator_hold: true, operator_hold_by: "operator:qa (user ruling)", operator_hold_at: at } });
const kids: Record<string, string> = {
  "recommit-recommit-recommit-prior-seeding-x-step-3-verify_failed": "suffix-free recommit child",
  "recommit-prior-seeding-x-step-1-verify_failed": "append child",
  "recommit-recommit-prior-seeding-x-step-1-verify_failed-step-2": "recommit+append grandchild",
  "recommit-failing-test-activity-api-src-services-phase5-integration-test-ts-gen-assert-r202610210647-narrowed": "recommit+narrow of r202610210647",
};
for (const k of Object.keys(kids)) fake.set(k, { id: k, classification_metadata: {} });
fake.set("linked-only-child", { id: "linked-only-child", classification_metadata: { parent_gap_id: "recommit-prior-seeding-x-step-1" } });
const after = ts("2026-10-21T10:00:00Z");
const before = ts("2026-10-21T09:00:00Z");

describe("test_lineage (13 frozen cases, real ids from the vendored archive rows)", () => {
  it("the vendored fixture is the snapshot the cases were recorded against", () => {
    expect(FIX.rows.length).toBe(8);
    expect(byid.has("recommit-" + P)).toBe(true);
  });
  it("lineage#01 [83c941682f35] real: recommit-recommit candidate has its recommit parent as ancestor", () => {
    expect(anc(cand, byid).has("recommit-" + P)).toBe(true);
  });
  it("lineage#02 [a01b05d776b1] real: and the un-prefixed narrowed row", () => {
    expect(anc(cand, byid).has(P) || !byid.has(P)).toBe(true);
  });
  it("lineage#03 [05c1ac191886] real: a parent is not its own child's descendant", () => {
    expect(anc("recommit-" + P, byid).has(cand)).toBe(false);
  });
  it("lineage#04 [335b8ea35fdd] held row itself ASSISTED after hold: recommit-recommit-prior-seeding-x-step-3", () => {
    expect(acts("recommit-recommit-prior-seeding-x-step-3-verify_failed", fake, after)).toBe(true);
  });
  it("lineage#05 [52378155d044] held row itself ASSISTED after hold: recommit-prior-seeding-x-step-1", () => {
    expect(acts("recommit-prior-seeding-x-step-1", fake, after)).toBe(true);
  });
  it("lineage#06 [b4430f85e53f] held row itself ASSISTED after hold: failing-test-activity-api-src-services-p", () => {
    expect(acts("failing-test-activity-api-src-services-phase5-integration-test-ts-gen-assert-r202610210647", fake, after)).toBe(true);
  });
  it("lineage#07 [c9fdfa782c54] child ASSISTED (suffix-free recommit child)", () => {
    expect(acts("recommit-recommit-recommit-prior-seeding-x-step-3-verify_failed", fake, after)).toBe(true);
  });
  it("lineage#08 [c0db8dcf1650] child ASSISTED (append child)", () => {
    expect(acts("recommit-prior-seeding-x-step-1-verify_failed", fake, after)).toBe(true);
  });
  it("lineage#09 [63f740637643] child ASSISTED (recommit+append grandchild)", () => {
    expect(acts("recommit-recommit-prior-seeding-x-step-1-verify_failed-step-2", fake, after)).toBe(true);
  });
  it("lineage#10 [fa634b00df4f] child ASSISTED (recommit+narrow of r202610210647)", () => {
    expect(acts("recommit-failing-test-activity-api-src-services-phase5-integration-test-ts-gen-assert-r202610210647-narrowed", fake, after)).toBe(true);
  });
  it("lineage#11 [15bc98d70b99] child via parent_gap_id link only", () => {
    expect(acts("linked-only-child", fake, after)).toBe(true);
  });
  it("lineage#12 [8eff66b559ad] fix BEFORE the hold: not provenance", () => {
    expect(acts("recommit-prior-seeding-x-step-1-verify_failed", fake, before)).toBe(false);
  });
  it("lineage#13 [e27048c0049f] sibling lineage unaffected (prior-seeding-x-step-2)", () => {
    const m = new Map(fake);
    m.set("recommit-prior-seeding-x-step-2", { id: "recommit-prior-seeding-x-step-2", classification_metadata: {} });
    expect(acts("recommit-prior-seeding-x-step-2", m, after)).toBe(false);
  });
});

describe("addendum 2a / 2a′ beyond the frozen cases (controls on the reader itself)", () => {
  it("a RELEASE stamp counts like a hold, and an operator_*_at with no _by still counts", () => {
    const m = new Map<string, GapRow>([
      ["g-released", { id: "g-released", classification_metadata: { operator_hold: false, operator_hold_released_by: "operator:x", operator_hold_released_at: "2026-10-21T08:00:00Z" } }],
      ["g-at-only", { id: "g-at-only", classification_metadata: { operator_hold_released_at: "2026-10-21T08:00:00Z" } }],
      ["g-clean", { id: "g-clean", classification_metadata: { operator_hold: true } }],
    ]);
    expect(rowFieldOperatorActs("g-released", m, after).map((a) => a.addendum)).toEqual(["2a"]);
    expect(rowFieldOperatorActs("g-at-only", m, after).map((a) => a.addendum)).toEqual(["2a-at-without-by"]);
    // A bare operator_hold flag has no stamp to date: rowFieldOperatorActs reads stamps only. operatorActsOf counts the
    // undated flag on its own (addendum "hold-undated"; self-fact-repair-review-fixes [item 3]).
    expect(rowFieldOperatorActs("g-clean", m, after)).toEqual([]);
  });
  it("a root_gap_id link on an ancestor is followed transitively", () => {
    const m = new Map<string, GapRow>([
      ["root", { id: "root", classification_metadata: { operator_hold_by: "operator:x", operator_hold_at: "2026-10-21T08:00:00Z" } }],
      ["mid", { id: "mid", classification_metadata: { root_gap_id: "root" } }],
      ["leaf", { id: "leaf", classification_metadata: { parent_gap_id: "mid" } }],
    ]);
    expect([...lineageAncestors("leaf", m)].sort()).toEqual(["mid", "root"]);
    expect(rowFieldOperatorActs("leaf", m, after)[0]!.on).toBe("root");
  });
});
