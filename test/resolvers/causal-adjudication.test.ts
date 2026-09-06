import { describe, it, expect } from "bun:test";
import { adjudicate, adjudicateAll } from "../../src/resolvers/causal-adjudication.js";

/**
 * AN AFTER-ONLY READING CANNOT SUPPORT A CAUSAL CLAIM.
 *
 * A Class-2 falsifier re-resolves a shape and reads a field, answering "is the defect present
 * NOW?". With nothing recorded before the action, these two are indistinguishable:
 *
 *     was present, now absent  — the fix worked
 *     never present at all     — the predicate was inert; closing is a FALSE CLOSE
 *
 * and the second looks exactly like success. substrate-gap.ts records the same hazard in its
 * own words: a derived literal "read 'present' by construction and manufactured re-lands".
 *
 * The tests below are mostly about the verdicts that are NOT "confirmed", because those are
 * the ones a system grading its own work will be tempted to round up.
 */
const present = { present: true };
const absent = { present: false };

describe("adjudicate — before/after, not after-only", () => {
  it("CONFIRMS only when the condition was present before and is absent after", () => {
    const a = adjudicate(present, absent, "1h", true);
    expect(a.verdict).toBe("confirmed");
    expect(a.supports_causal_claim).toBe(true);
  });

  it("REFUTES when the condition survived the action", () => {
    const a = adjudicate(present, present, "1h", true);
    expect(a.verdict).toBe("refuted");
    expect(a.supports_causal_claim).toBe(false);
  });

  it("calls absent-before-and-after NEVER_PRESENT, not confirmed — the false-close case", () => {
    // This is the whole point. An after-only reader sees "absent" and closes the gap, which is
    // indistinguishable from a real fix. With a baseline it is visibly a predicate that was
    // inert from the start, and it must NOT support a causal claim.
    const a = adjudicate(absent, absent, "1h", true);
    expect(a.verdict).toBe("never_present");
    expect(a.supports_causal_claim).toBe(false);
    expect(a.detail).toContain("false close");
  });

  it("calls absent-before, present-after a REGRESSION — the action introduced it", () => {
    const a = adjudicate(absent, present, "1h", true);
    expect(a.verdict).toBe("regressed");
    expect(a.supports_causal_claim).toBe(false);
  });

  // ---- the refusals to conclude ----

  it("is INCONCLUSIVE with no baseline, however clear the after-reading looks", () => {
    // The seductive case: the defect is absent now, so it is tempting to call it fixed.
    // Without a before-value that is exactly the claim the evidence cannot carry.
    const a = adjudicate(null, absent, "1h", true);
    expect(a.verdict).toBe("inconclusive");
    expect(a.supports_causal_claim).toBe(false);
    expect(a.detail).toContain("never present");
  });

  it("is INCONCLUSIVE when the predicate cannot be measured now", () => {
    const a = adjudicate(present, null, "1h", true);
    expect(a.verdict).toBe("inconclusive");
  });

  it("is PENDING, never refuted, before the declared horizon elapses", () => {
    // Concluding early discards the reason for declaring a horizon at all. A slow effect and
    // an absent effect look identical until the window closes.
    const a = adjudicate(present, present, "24h", false);
    expect(a.verdict).toBe("pending");
    expect(a.supports_causal_claim).toBe(false);
  });

  it("prefers INCONCLUSIVE over PENDING when a reading is missing", () => {
    // Waiting longer cannot fix an unmeasurable observation, so promising a later verdict
    // would be a promise nothing can keep.
    expect(adjudicate(null, absent, "24h", false).verdict).toBe("inconclusive");
    expect(adjudicate(present, null, "24h", false).verdict).toBe("inconclusive");
  });

  it("only ever sets supports_causal_claim for confirmed", () => {
    const cases = [
      adjudicate(present, absent, "1h", true),
      adjudicate(present, present, "1h", true),
      adjudicate(absent, absent, "1h", true),
      adjudicate(absent, present, "1h", true),
      adjudicate(null, absent, "1h", true),
      adjudicate(present, null, "1h", true),
      adjudicate(present, present, "1h", false),
    ];
    expect(cases.filter((c) => c.supports_causal_claim).length).toBe(1);
  });
});

describe("adjudicateAll — horizons are plural because effects have durations", () => {
  it("reports each horizon separately rather than collapsing them", () => {
    // Confirmed at 1h and refuted at 24h is not a contradiction: it says the effect did not
    // last. A single verdict would throw away the only interesting part.
    const r = adjudicateAll(present, [
      { horizon: "1h", elapsed: true, observation: absent },
      { horizon: "24h", elapsed: true, observation: present },
    ]);
    expect(r.per_horizon.map((a) => a.verdict)).toEqual(["confirmed", "refuted"]);
    expect(r.confirmed_at).toBe("1h");
  });

  it("names the EARLIEST horizon at which the claim held — that is what bounds the mechanism", () => {
    const r = adjudicateAll(present, [
      { horizon: "1h", elapsed: true, observation: present },
      { horizon: "24h", elapsed: true, observation: absent },
    ]);
    expect(r.confirmed_at).toBe("24h");
  });

  it("surfaces a regression at any horizon", () => {
    const r = adjudicateAll(absent, [
      { horizon: "1h", elapsed: true, observation: absent },
      { horizon: "24h", elapsed: true, observation: present },
    ]);
    expect(r.any_regression).toBe(true);
    expect(r.confirmed_at).toBeNull();
  });

  it("reports all_pending so an unfinished experiment is not read as a null result", () => {
    const r = adjudicateAll(present, [
      { horizon: "1h", elapsed: false, observation: present },
      { horizon: "24h", elapsed: false, observation: present },
    ]);
    expect(r.all_pending).toBe(true);
    expect(r.confirmed_at).toBeNull();
  });

  it("returns no confirmation for an empty horizon set", () => {
    const r = adjudicateAll(present, []);
    expect(r.confirmed_at).toBeNull();
    expect(r.all_pending).toBe(false);
  });
});

import { measureClass1 } from "../../src/resolvers/causal-adjudication.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The measurement half. A Class-1 predicate says a literal must go ABSENT, so the baseline is
 * simply whether it is there — but the unreadable case has to stay distinct from the absent
 * case, or "I could not look" silently becomes "it is gone", which is the false close again.
 */
describe("measureClass1 — present, absent, and unreadable are three states", () => {
  it("reports present when the literal is in the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c1-"));
    await writeFile(join(dir, "f.ts"), 'const x = "http://127.0.0.1:8080/impulses";\n');
    expect(await measureClass1(dir, "f.ts", "http://127.0.0.1:8080/impulses")).toEqual({ present: true });
  });

  it("reports absent when the file exists and the literal does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c1-"));
    await writeFile(join(dir, "f.ts"), "const x = 1;\n");
    expect(await measureClass1(dir, "f.ts", "http://127.0.0.1:8080/impulses")).toEqual({ present: false });
  });

  it("returns null — NOT absent — when the file cannot be read", async () => {
    // The distinction that matters. Returning {present:false} here would let an unreadable
    // path adjudicate as a successful removal.
    expect(await measureClass1("/nonexistent-root", "f.ts", "literal")).toBeNull();
  });

  it("returns null for an empty edit site or empty literal rather than guessing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c1-"));
    await writeFile(join(dir, "f.ts"), "x\n");
    expect(await measureClass1(dir, "", "literal")).toBeNull();
    expect(await measureClass1(dir, "f.ts", "")).toBeNull();
  });
});
