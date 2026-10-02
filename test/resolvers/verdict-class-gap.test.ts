import { describe, it, expect } from "bun:test";
import { verdictClassGaps, type VerdictClassPolicy } from "../../src/resolvers/verdict-class-gap.js";

/**
 * CHECK-FIRST (slice Y, step Y2a): one gap per deterministic verdict CLASS, never per instance.
 *
 * "Wrongness is a goal seed": ~800 deterministic HOLLOW verdicts in 6 days became 0 gaps. The
 * missing-verifier generator (goal-host missing-verifier-gap.ts) already keys by FAMILY and
 * writes a stable id, but only for 9 quantitative regex families, and its dedup set is
 * in-memory. This is that generator re-keyed by verdict class, as a pure builder: the caller
 * supplies per-class counts (from traceAggregateReport over `execution`) and the existing gap
 * rows; this decides what to write. The store's upsert-by-id holds the one-row invariant.
 *
 * Counts below are the live failure-memory distribution on node 1 (09-22 → 10-02):
 * class, records, distinct goal hashes.
 */

const POLICY: VerdictClassPolicy = {
  min_count: 20,
  min_distinct_goals: 3,
  max_new_per_run: 3,
  window_hours: 168,
  max_rate_count: 5,
  exclude_tokens: ["verified-*", "*-cited", "*-agrees", "*-verified"],
};

const LIVE = [
  { class: "deterministic:edit-intent-no-landed-edit", count: 450, distinct_goals: 288 },
  { class: "deterministic:code-investigation-citation-unverified", count: 108, distinct_goals: 67 },
  { class: "deterministic:code-investigation-uncited", count: 96, distinct_goals: 94 },
  { class: "deterministic:edit-intent-accepted-unfavorable", count: 57, distinct_goals: 49 },
  { class: "deterministic:artifact-not-written", count: 37, distinct_goals: 23 },
  { class: "deterministic:transform-mismatch", count: 27, distinct_goals: 27 },
  { class: "deterministic:edit-intent-accepted-refused", count: 9, distinct_goals: 9 },
  { class: "deterministic:wrong-git-commit-count", count: 3, distinct_goals: 1 },
  { class: "deterministic:stale-asserted-date", count: 3, distinct_goals: 1 },
  { class: "transport", count: 11088, distinct_goals: 400 },
  { class: "structural:not-registered", count: 651, distinct_goals: 90 },
  { class: "deterministic:code-investigation-cited", count: 91, distinct_goals: 60 },
];

describe("verdictClassGaps — positive control and must-fail", () => {
  it("POSITIVE CONTROL: edit-intent-no-landed-edit (450 records, 288 goals) becomes exactly ONE gap with a stable class id", () => {
    const { gaps } = verdictClassGaps([LIVE[0]!], [], POLICY);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.id).toBe("verdict-class-edit-intent-no-landed-edit");
    expect(gaps[0]!.status).toBe("open");
    expect(gaps[0]!.classification_metadata.verdict_class).toBe("deterministic:edit-intent-no-landed-edit");
    expect(gaps[0]!.classification_metadata.occurrence_count).toBe(450);
    expect(gaps[0]!.classification_metadata.distinct_goals).toBe(288);
  });

  it("MUST-FAIL: a class seen on ONE goal files nothing, however often it repeats", () => {
    const { gaps, skipped } = verdictClassGaps([LIVE[7]!, LIVE[8]!], [], POLICY);
    expect(gaps).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["below_distinct_goals", "below_distinct_goals"]);
  });

  it("a class below the count floor files nothing", () => {
    const { gaps, skipped } = verdictClassGaps([LIVE[6]!], [], POLICY);
    expect(gaps).toEqual([]);
    expect(skipped[0]!.reason).toBe("below_count");
  });

  it("only deterministic verdict classes are filed; transport and structural classes have other owners", () => {
    const { gaps } = verdictClassGaps([LIVE[9]!, LIVE[10]!], [], POLICY);
    expect(gaps).toEqual([]);
  });

  it("reached-side tokens excluded by policy never file (the floor records code-investigation-cited as a failure reason)", () => {
    const { gaps, skipped } = verdictClassGaps([LIVE[11]!], [], POLICY);
    expect(gaps).toEqual([]);
    expect(skipped[0]!.reason).toBe("excluded_token");
  });

  it("a malformed token is never turned into a gap id", () => {
    const { gaps } = verdictClassGaps([{ class: "deterministic:Has Spaces/../x", count: 999, distinct_goals: 99 }], [], POLICY);
    expect(gaps).toEqual([]);
  });
});

describe("verdictClassGaps — flood guards", () => {
  it("the whole live distribution files at most max_new_per_run NEW gaps, highest count first", () => {
    const { gaps, skipped } = verdictClassGaps(LIVE, [], POLICY);
    expect(gaps.length).toBe(3);
    expect(gaps.map((g) => g.id)).toEqual([
      "verdict-class-edit-intent-no-landed-edit",
      "verdict-class-code-investigation-citation-unverified",
      "verdict-class-code-investigation-uncited",
    ]);
    expect(skipped.filter((s) => s.reason === "rate_limited").length).toBe(3);
  });

  it("an OPEN class gap is refreshed under the same id and does not count against the new-gap budget", () => {
    const existing = [{ id: "verdict-class-edit-intent-no-landed-edit", status: "open" }];
    const { gaps } = verdictClassGaps(LIVE, existing, POLICY);
    const ids = gaps.map((g) => g.id);
    expect(ids.filter((i) => i === "verdict-class-edit-intent-no-landed-edit").length).toBe(1);
    expect(ids.length).toBe(4); // the refresh + 3 new
  });

  it("a CLOSED class gap is NOT reopened by its historical count (an open write over a closed row is a reopen)", () => {
    const existing = [{ id: "verdict-class-edit-intent-no-landed-edit", status: "closed", classification_metadata: { closed_at: "2026-10-01T00:00:00Z" } }];
    const { gaps, skipped } = verdictClassGaps([LIVE[0]!], existing, POLICY);
    expect(gaps).toEqual([]);
    expect(skipped[0]!.reason).toBe("closed_no_recurrence");
  });

  it("a CLOSED class gap IS reopened when the class recurs SINCE the close at or above the floor", () => {
    const existing = [{ id: "verdict-class-edit-intent-no-landed-edit", status: "closed", classification_metadata: { closed_at: "2026-10-01T00:00:00Z" } }];
    const { gaps } = verdictClassGaps([{ ...LIVE[0]!, since_close_count: 25, since_close_distinct_goals: 10 }], existing, POLICY);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.status).toBe("open");
  });
});

describe("verdictClassGaps — the gap is actionable and honest", () => {
  const g = verdictClassGaps([LIVE[0]!], [], POLICY).gaps[0]!;

  it("carries a class2 falsifier whose check is a READ shape the dev-vessel serves, with a DEFECT-count zero_field", () => {
    const m = g.classification_metadata;
    expect(m.falsifier).toBe("class2");
    expect(m.evidence_resolve.shape).toBe("trace_failure_pattern_report");
    expect(m.evidence_resolve.shape.endsWith("_write")).toBe(false);
    expect(m.evidence_resolve.input.failure_class).toBe("deterministic:edit-intent-no-landed-edit");
    expect(m.evidence_resolve.input.window_hours).toBe(168);
    expect(m.evidence_resolve.input.max_count).toBe(5);
    expect(m.evidence_resolve.zero_field).toBe("excess_failures");
  });

  it("does not fabricate an edit_site; a located verdict site is carried separately for localization", () => {
    expect(g.classification_metadata.edit_site).toBeUndefined();
    const located = verdictClassGaps([LIVE[0]!], [], POLICY, { verdictSites: { "deterministic:edit-intent-no-landed-edit": "repos/goal-host-vessel/src/index.ts:4063" } }).gaps[0]!;
    expect(located.classification_metadata.verdict_site).toBe("repos/goal-host-vessel/src/index.ts:4063");
    expect(located.classification_metadata.edit_site).toBeUndefined();
  });

  it("is a detector-born gap with a summary that names the class, the count, the goals and the window", () => {
    expect(g.source).toBe("substrate_detected");
    expect(g.category).toBe("verdict_class");
    expect(g.summary).toContain("edit-intent-no-landed-edit");
    expect(g.summary).toContain("450");
    expect(g.summary).toContain("288");
    expect(g.summary).not.toMatch(/\{\{/);
  });
});
