// BEHAVIOUR PIN: the pick as a whole (qa ruling 10.2, option B: the closed `pickCandidate(gaps, {lineageIndex,
// score, rerank, onPicked})` skeleton with the ranker injected, extracted from pickMostLandable). The judging steps
// run in today's order: hopeless partition (+ human escalation), empty-pool null, rank by score, LANDABILITY_FLOOR,
// rerank, pick-skip walk, return.
//   - A gap the hopeless partition, the floor or pick-skip excludes is never returned, whatever the ranking does,
//     including when the score (human_reported x1.5) and the rerank (its class sampling theta ~ 1) both put it first.
//   - The ranker only orders the eligible gaps: flipping the class posteriors flips which eligible gap is picked.
//   - CONTROL for each gate: the same pool with that gate's condition removed returns the excluded gap.
//   - Order: the hopeless partition runs before the floor (a hopeless gap that is also below the floor is still
//     escalated and is not counted by the floor), and an all-excluded pool returns null.
// Driven through auto-pick ticks of resolveGapToFeature over stored pools (see pick-fixture.ts). Before the skeleton
// exists the "injected ranker" is today's score and rerank; the pins hold for any ranker the residue injects. Written
// against the tree before the extraction; it must hold after it.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { beginPin, endPin, restoreHarness, store, calls, stored } from "./harness.js";
import { candidate, classPosteriors, posteriorsWereRead, autoPick, PICK_LOG } from "./pick-fixture.js";

const { gapClassOf } = await import("../../src/judge/gap-attempt-credit.js");
const cls = (id: string) => gapClassOf(stored(id)!);
const HOPELESS_CAT = "pin_skeleton_hopeless";

beforeEach(() => beginPin());
afterEach(() => { expect(endPin([PICK_LOG])).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

type Gate = "hopeless" | "floor" | "skip";
/** The pool: three excluded gaps that rank first (human_reported, class theta ~ 1), each by one gate, plus two eligible
 *  gaps (theta ~ 0.91 for the preferred one, ~ 0 for the other). `off` removes one gate's condition (its control). `prefer` picks which eligible class the rerank favours. */
function pool(tag: string, prefer: "e1" | "e2", off?: Gate): Record<"h" | "l" | "s" | "e1" | "e2", string> {
  const h = candidate(`psk-hope-${tag}`, {}, { category: HOPELESS_CAT, source: "human_reported" });
  const l = candidate(`psk-low-${tag}`, off === "floor" ? {} : { failed_attempts: 4 }, { category: "architectural_pattern", source: "human_reported" });
  const s = candidate(`psk-skip-${tag}`, off === "skip" ? {} : { regressed_by: { sha: "abcdef1234567" } }, { source: "human_reported" });
  const e1 = candidate(`psk-ea-${tag}`);
  const e2 = candidate(`psk-eb-${tag}`);
  store.calibration = { [HOPELESS_CAT]: off === "hopeless" ? { attempts: 2, lands: 0 } : { attempts: 12, lands: 0 } };
  classPosteriors({
    [cls(h)]: "favour", [cls(l)]: "favour", [cls(s)]: "favour",
    [cls(e1)]: prefer === "e1" ? "mid" : "disfavour",
    [cls(e2)]: prefer === "e2" ? "mid" : "disfavour",
  });
  return { h, l, s, e1, e2 };
}

describe("pickCandidate: an excluded gap is never returned, whatever the ranker does", () => {
  for (const prefer of ["e1", "e2"] as const) {
    it(`[PIN] the ranker favours ${prefer}: ${prefer} is picked; the hopeless, below-floor and skipped gaps never are`, async () => {
      const p = pool(`r${prefer}`, prefer);
      const { picked, lines } = await autoPick();
      expect(posteriorsWereRead()).toBe(true);
      expect(picked).toBe(p[prefer]);
      expect(calls.uiWrite.map((c) => c.id)).toEqual([`needs-human-${p.h}`]);
      expect(lines).toContain("[gap-to-feature] landability_floor excluded 1 of 4 candidates (floor=0.15)");
      const pickLine = lines.find((l) => l.startsWith("[gap-to-feature] pick "))!;
      expect(pickLine).toContain('"skipped_pending":1');
      expect(pickLine).toContain('"hopeless_excluded":1');
    });
  }

  for (const [gate, key] of [["hopeless", "h"], ["floor", "l"], ["skip", "s"]] as const) {
    it(`[CONTROL] the same pool with the ${gate} condition removed returns that gap (it ranks first)`, async () => {
      const p = pool(`c${gate}`, "e1", gate);
      // The freed gap's class samples theta ~ 1, above e1's ~ 0.91, so it ranks ahead of every eligible gap.
      const { picked } = await autoPick();
      expect(picked).toBe(p[key]);
    });
  }

  it("[PIN] order: a hopeless gap that is also below the floor is escalated and not counted by the floor", async () => {
    // "backlog" (-0.3), "-recommit-" (-0.15) and four failed attempts (-0.4): landability 0.05, below the floor.
    const hl = candidate("psk-backlog-recommit-hl", { failed_attempts: 4 }, { category: HOPELESS_CAT });
    const e = candidate("psk-elig-a");
    store.calibration = { [HOPELESS_CAT]: { attempts: 8, lands: 0 } };
    const { picked, lines } = await autoPick();
    expect(picked).toBe(e);
    expect(calls.uiWrite.map((c) => c.id)).toEqual([`needs-human-${hl}`]);
    expect(lines.some((l) => l.includes("landability_floor excluded"))).toBe(false);
  });

  it("[PIN] every gap excluded by hopeless or floor: nothing is picked; pick-skip alone never empties the pick (fail open)", async () => {
    candidate("psk-allh-a", {}, { category: HOPELESS_CAT });
    candidate("psk-alll-a", { failed_attempts: 4 }, { category: "architectural_pattern" });
    store.calibration = { [HOPELESS_CAT]: { attempts: 8, lands: 0 } };
    const t = await autoPick();
    expect(t.picked).toBeNull();
    expect(t.body.error).toBe("no matching open gap");
    expect(calls.compose.length).toBe(0);
  });
});
