// Pins the verdict the whole baseline mechanism exists to make possible.
//
// THE FAILURE THIS GUARDS: an after-only reading cannot separate two worlds that look
// identical from the outside —
//
//     was present, now absent  -> the action changed something; the fix worked
//     never present at all     -> the predicate was inert from the start, and closing on it
//                                 is a FALSE CLOSE that looks exactly like success
//
// Baselines were being stamped faithfully — thousands of them — and the pure adjudication
// functions had no callers outside these tests. So the substrate recorded "before" with care
// and never once asked "and now?". Collecting a before-reading and never comparing it buys
// none of the protection it was taken for: a fact about the past is provenance, not proof,
// until something compares it to the present.
import { describe, expect, test } from "bun:test";
import { adjudicate, adjudicateAll } from "../../src/resolvers/causal-adjudication";

const PRESENT = { present: true };
const ABSENT = { present: false };

describe("causal adjudication verdicts", () => {
  test("present-then-absent over an ELAPSED horizon supports the causal claim", () => {
    const a = adjudicate(PRESENT, ABSENT, "1h", true);
    expect(a.supports_causal_claim).toBe(true);
  });

  test("ABSENT-THEN-ABSENT DOES NOT — the false close this exists to catch", () => {
    // Identical after-reading to the case above. Only the baseline distinguishes them, and
    // without it this closes green while the action did nothing.
    const a = adjudicate(ABSENT, ABSENT, "1h", true);
    expect(a.supports_causal_claim).toBe(false);
  });

  test("an UNELAPSED horizon is pending, never refuted", () => {
    // Refusing to conclude early is the point. A change that shows after a day is a different
    // claim about mechanism than one that shows in a minute; calling it refuted at 1h would
    // convert "too soon to tell" into a false negative.
    const a = adjudicate(PRESENT, PRESENT, "24h", false);
    expect(a.verdict).toBe("pending");
    expect(a.supports_causal_claim).toBe(false);
  });

  test("an unmeasurable baseline cannot support a claim however good the after-reading looks", () => {
    // Absent evidence is not evidence. If we could not see the value beforehand, no present
    // reading recovers the comparison.
    expect(adjudicate(null, ABSENT, "1h", true).supports_causal_claim).toBe(false);
    expect(adjudicate(PRESENT, null, "1h", true).supports_causal_claim).toBe(false);
  });

  test("a regression is reported rather than folded into 'not confirmed'", () => {
    // Absent-then-present is not merely an unconfirmed fix; it is the fix going backwards,
    // and collapsing the two would hide the more urgent one.
    const all = adjudicateAll(ABSENT, [{ horizon: "1h", elapsed: true, observation: PRESENT }]);
    expect(all.any_regression).toBe(true);
    expect(all.confirmed_at).toBeNull();
  });

  test("across horizons, the FIRST confirming horizon is reported", () => {
    // Which horizon confirmed is itself the claim about mechanism — a same-minute effect and
    // a next-day effect are different findings and must not both report as simply 'confirmed'.
    const all = adjudicateAll(PRESENT, [
      { horizon: "1h", elapsed: true, observation: ABSENT },
      { horizon: "24h", elapsed: true, observation: ABSENT },
    ]);
    expect(all.confirmed_at).toBe("1h");
    expect(all.all_pending).toBe(false);
  });
});
