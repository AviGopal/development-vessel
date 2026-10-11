// BEHAVIOUR PIN: the three pick gates inside pickMostLandable, one by one (judge split, extractions
// `partitionHopeless` + `escalateHopelessToHuman`, `applyLandabilityFloor`, `pickSkipPending`; under qa ruling 10.2
// they become the closed `pickCandidate` skeleton, pinned as a whole in pin-pick-skeleton.test.ts).
//   - HOPELESS: a gap whose category the held calibration shows at >= 8 attempts and 0 lands is excluded and
//     escalated to a human once (uiQuestion_write needs-human-<id>, kind gap_needs_human), unless it carries a live
//     human exemption. A pool of only hopeless gaps picks nothing.
//   - FLOOR: a candidate with landability < 0.15 is dropped before the class rerank, even when its class samples
//     theta ~ 1; a pool entirely below the floor picks nothing.
//   - PICK-SKIP: walking the ranked list, a candidate is skipped when it carries regressed_by with no revert_sha,
//     a landing stamp (pending_outcome_verification) without a measurable predicate, a parent whose landing is
//     unjudged, or a pick-time check that reads 'pending'. When every candidate is skipped the top one is returned
//     (fail open).
// Each gate has a CONTROL: the same pool with the gate's condition removed returns the excluded gap.
// Driven through auto-pick ticks of resolveGapToFeature over stored pools; the calibration is the store holder's
// (include_calibration), the class posteriors are served at their load-time path. Written against the tree before
// the extraction; it must hold after it.
//
// NOT REACHABLE through the entry point, stated: pick-skip's operator_hold branch (an open read drops held rows and
// admission excludes operator_hold before the pick), and its landed-awaiting-verification branch for a row whose
// disposition is pending_verification (admission excludes those too). The landing-stamp case below uses a stamp
// with no pending_verification disposition, which admission lets through.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { beginPin, endPin, restoreHarness, store, calls, metaOf, stored } from "./harness.js";
import { candidate, classPosteriors, posteriorsWereRead, autoPick, pickSite, PICK_LITERAL, PICK_LOG } from "./pick-fixture.js";

const { gapClassOf } = await import("../../src/resolvers/gap-to-feature.js");
const cls = (id: string) => gapClassOf(stored(id)!);

beforeEach(() => beginPin());
afterEach(() => { expect(endPin([PICK_LOG])).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("hopeless: a category with >= 8 attempts and 0 lands", () => {
  const HOPELESS_CAT = "pin_hopeless_category";
  it("[PIN] the hopeless gap is excluded even when it ranks first; the other is picked; one human escalation", async () => {
    const h = candidate("pkh-hope-a", {}, { category: HOPELESS_CAT, source: "human_reported" });
    const o = candidate("pkh-other-a");
    store.calibration = { [HOPELESS_CAT]: { attempts: 8, lands: 0 } };
    classPosteriors({ [cls(h)]: "favour", [cls(o)]: "disfavour" });
    const { picked } = await autoPick();
    expect(posteriorsWereRead()).toBe(true);
    expect(picked).toBe(o);
    expect(calls.uiWrite.map((c) => [c.id, c.kind, c.importance])).toEqual([[`needs-human-${h}`, "gap_needs_human", "high"]]);
    expect(String(calls.uiWrite[0]!.body)).toContain(`Gap ${h} (${HOPELESS_CAT}) has failed auto-repair 8+ times with 0 lands.`);
  });

  for (const [tag, calib, meta] of [
    ["7 attempts", { attempts: 7, lands: 0 }, {}],
    ["one land", { attempts: 20, lands: 1 }, {}],
    ["a live human exemption", { attempts: 8, lands: 0 }, { human_exemption_attempts_remaining: 1 }],
  ] as const) {
    it(`[CONTROL] ${tag}: not hopeless; the same gap is picked, no escalation`, async () => {
      const h = candidate(`pkh-ctl-${tag.replace(/\W+/g, "")}`, meta, { category: HOPELESS_CAT, source: "human_reported" });
      const o = candidate(`pkh-oth-${tag.replace(/\W+/g, "")}`);
      store.calibration = { [HOPELESS_CAT]: calib };
      classPosteriors({ [cls(h)]: "favour", [cls(o)]: "disfavour" });
      const { picked } = await autoPick();
      expect(picked).toBe(h);
      expect(calls.uiWrite.length).toBe(0);
    });
  }

  it("[PIN] two hopeless gaps are escalated in pool order, once each across ticks; a pool of only hopeless gaps picks nothing", async () => {
    const a = candidate("pkh-only-a", {}, { category: HOPELESS_CAT });
    const b = candidate("pkh-only-b", {}, { category: HOPELESS_CAT });
    store.calibration = { [HOPELESS_CAT]: { attempts: 9, lands: 0 } };
    const t1 = await autoPick();
    expect(t1.picked).toBeNull();
    expect(t1.body.error).toBe("no matching open gap");
    // The store reads newest first: b was seeded after a.
    expect(calls.uiWrite.map((c) => c.id)).toEqual([`needs-human-${b}`, `needs-human-${a}`]);
    const t2 = await autoPick();
    expect(t2.picked).toBeNull();
    expect(calls.uiWrite.length).toBe(2);
    expect(calls.compose.length).toBe(0);
  });
});

describe("landability floor (0.15)", () => {
  // architectural_pattern is a hard category (-0.4) and four failed attempts on a sited gap cost 0.4: 0.9 - 0.8 = 0.1.
  it("[PIN] a below-floor candidate is dropped before the rerank, though its class samples theta ~ 1", async () => {
    const low = candidate("pkf-low-a", { failed_attempts: 4 }, { category: "architectural_pattern" });
    const ok = candidate("pkf-ok-a");
    classPosteriors({ [cls(low)]: "favour", [cls(ok)]: "disfavour" });
    const { picked, lines } = await autoPick();
    expect(posteriorsWereRead()).toBe(true);
    expect(picked).toBe(ok);
    expect(lines).toContain("[gap-to-feature] landability_floor excluded 1 of 2 candidates (floor=0.15)");
  });

  it("[CONTROL] the same gap at landability 0.5 (no failed attempts) is above the floor and wins the rerank", async () => {
    const low = candidate("pkf-low-b", {}, { category: "architectural_pattern" });
    const ok = candidate("pkf-ok-b");
    classPosteriors({ [cls(low)]: "favour", [cls(ok)]: "disfavour" });
    const { picked, lines } = await autoPick();
    expect(picked).toBe(low);
    expect(lines.some((l) => l.includes("landability_floor excluded"))).toBe(false);
  });

  it("[PIN] a pool entirely below the floor picks nothing", async () => {
    candidate("pkf-low-c", { failed_attempts: 4 }, { category: "architectural_pattern" });
    const { picked, body, lines } = await autoPick();
    expect(picked).toBeNull();
    expect(body.error).toBe("no matching open gap");
    expect(lines).toContain("[gap-to-feature] landability_floor excluded 1 of 1 candidates (floor=0.15)");
    expect(calls.compose.length).toBe(0);
  });
});

describe("pick-skip: a candidate that cannot be composed does not consume the pick", () => {
  /** `skipped` ranks first (human_reported, favoured class); the walk must pass it and pick `next`. */
  async function expectSkipped(skippedMeta: Record<string, unknown>, tag: string): Promise<void> {
    const s = candidate(`pks-skip-${tag}`, skippedMeta, { source: "human_reported" });
    const next = candidate(`pks-next-${tag}`);
    classPosteriors({ [cls(s)]: "favour", [cls(next)]: "disfavour" });
    const { picked, lines } = await autoPick();
    expect(posteriorsWereRead()).toBe(true);
    expect(picked).toBe(next);
    expect(lines.find((l) => l.startsWith("[gap-to-feature] pick "))).toContain('"skipped_pending":1');
  }
  async function expectPicked(meta: Record<string, unknown>, tag: string): Promise<void> {
    const s = candidate(`pks-ctl-${tag}`, meta, { source: "human_reported" });
    const next = candidate(`pks-nxc-${tag}`);
    classPosteriors({ [cls(s)]: "favour", [cls(next)]: "disfavour" });
    const { picked, lines } = await autoPick();
    expect(picked).toBe(s);
    expect(lines.find((l) => l.startsWith("[gap-to-feature] pick "))).toContain('"skipped_pending":0');
  }

  it("[PIN] regressed_by with no revert_sha is skipped", () => expectSkipped({ regressed_by: { sha: "abcdef1234567" } }, "reg"));
  it("[CONTROL] regressed_by with its revert recorded is picked", () => expectPicked({ regressed_by: { sha: "abcdef1234567", revert_sha: "fedcba7654321" } }, "reg"));

  it("[PIN] a landing stamp with no measurable predicate is skipped", () =>
    expectSkipped({ falsifier: "class2", hardcoded_url: undefined, evidence_resolve: { shape: "pin_shape", zero_field: "n" }, pending_outcome_verification: "abcdef1234567" }, "stamp"));
  it("[CONTROL] the same stamp on a gap with a measurable predicate (class-1 literal) is picked", () =>
    expectPicked({ pending_outcome_verification: "abcdef1234567" }, "stamp"));

  it("[PIN] a pick-time check that reads 'pending' (a landing-derived sentinel, literal gone) is skipped", async () => {
    await expectSkipped({ edit_site: pickSite(false), predicate_source: "removed_line_of_landing_commit" }, "pend");
  });
  it("[CONTROL] the same sentinel with the literal still present reads 'present' and is picked", () =>
    expectPicked({ predicate_source: "removed_line_of_landing_commit" }, "pend"));

  describe("a narrowed child whose parent's landing is unjudged", () => {
    function family(tag: string, parentMeta: Record<string, unknown>): { child: string; next: string } {
      // The parent is parked (excluded from admission) but still in the store-wide lineage index.
      const parent = candidate(`pkp-par-${tag}`, { disposition: "needs_information", ...parentMeta });
      const child = candidate(`pkp-chi-${tag}`, { parent_gap_id: parent }, { source: "human_reported" });
      const next = candidate(`pkp-nxt-${tag}`);
      classPosteriors({ [cls(child)]: "favour", [cls(next)]: "disfavour" });
      return { child, next };
    }
    it("[PIN] the child is skipped while the parent carries a landing stamp", async () => {
      const f = family("a", { pending_outcome_verification: "abcdef1234567" });
      expect((await autoPick()).picked).toBe(f.next);
    });
    it("[CONTROL] the child is picked once the parent carries none", async () => {
      const f = family("b", {});
      expect((await autoPick()).picked).toBe(f.child);
    });
  });

  it("[PIN] every candidate skipped: fails open to the top-ranked one (which the pick-time check then holds pending)", async () => {
    const only = candidate("pks-only-a", { edit_site: pickSite(false), predicate_source: "removed_line_of_landing_commit" });
    const { picked, body, lines } = await autoPick();
    expect(picked).toBe(only);
    expect(body.verdict).toBe("pending_verification");
    expect(lines.find((l) => l.startsWith("[gap-to-feature] pick "))).toContain('"skipped_pending":1');
    expect(metaOf(only).disposition).toBe("pending_verification");
    expect(calls.compose.length).toBe(0);
  });
});

void PICK_LITERAL;
