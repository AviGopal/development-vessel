import { describe, it, expect } from "bun:test";
import { verdictClassGaps, verdictClassGapId, DEFAULT_VERDICT_CLASS_POLICY, type VerdictClassPolicy } from "../../src/resolvers/verdict-class-gap.js";
import { gapClassKey } from "../../src/resolvers/substrate-gap.js";
import { isVerdictToken } from "../../src/lib/verdict-token.js";

/** Must-fail probes from review (qa15), kept as tests: each one filed (or reopened) wrongly in the first cut. */
const POLICY: VerdictClassPolicy = { ...DEFAULT_VERDICT_CLASS_POLICY, exclude_tokens: [...DEFAULT_VERDICT_CLASS_POLICY.exclude_tokens] };
const big = (cls: string) => ({ class: cls, count: 100, distinct_goals: 50 });

describe("verdictClassGaps — reached-side tokens goal-host emits today never file by default", () => {
  for (const t of ["edit-intent-landed", "early-edit-intent-landed", "grounded-report", "true"]) {
    it(`deterministic:${t} is excluded`, () => {
      const r = verdictClassGaps([big(`deterministic:${t}`)], [], POLICY);
      expect(r.gaps).toEqual([]);
      expect(r.skipped[0]!.reason).toBe("excluded_token");
    });
  }
  it("a not-reached token that merely contains 'landed' still files", () => {
    expect(verdictClassGaps([big("deterministic:edit-intent-no-landed-edit")], [], POLICY).gaps.length).toBe(1);
  });
});

describe("verdictClassGaps — an unread store files NOTHING (an open write over an unseen closed row is a silent reopen)", () => {
  it("existing = null files nothing and says why", () => {
    const r = verdictClassGaps([big("deterministic:edit-intent-no-landed-edit"), big("deterministic:artifact-not-written")], null, POLICY);
    expect(r.gaps).toEqual([]);
    expect(r.skipped.every((s) => s.reason === "store_unread")).toBe(true);
    expect(r.skipped.length).toBe(2);
  });
});

describe("verdictClassGaps — reopen guards", () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ ...big(`deterministic:cls-${String.fromCharCode(97 + i)}x`), since_close_count: 30, since_close_distinct_goals: 5 }));
  const closed = ten.map((c) => ({ id: `verdict-class-${c.class.slice("deterministic:".length)}`, status: "closed", closed_at: "2026-09-01T00:00:00Z" }));

  it("reopens count against the per-run budget (10 recurring closed classes reopen at most max_new_per_run)", () => {
    const r = verdictClassGaps(ten, closed, POLICY);
    expect(r.gaps.length).toBe(POLICY.max_new_per_run);
    expect(r.skipped.filter((s) => s.reason === "rate_limited").length).toBe(10 - POLICY.max_new_per_run);
  });

  it("a future closed_at is not a reopen anchor", () => {
    const r = verdictClassGaps([ten[0]!], [{ ...closed[0]!, closed_at: "2099-01-01T00:00:00Z" }], POLICY);
    expect(r.gaps).toEqual([]);
    expect(r.skipped[0]!.reason).toBe("closed_no_anchor");
  });
});

describe("the shared verdict-token rule agrees with the gap store", () => {
  it("every token the rule accepts survives gapClassKey unchanged; the ones it refuses are refused here too", () => {
    for (const t of ["edit-intent-no-landed-edit", "a1", "x-12345", "abc-1234567"]) {
      expect(isVerdictToken(t)).toBe(true);
      const id = `verdict-class-${t}`;
      expect(gapClassKey(id)).toBe(id);
      expect(verdictClassGapId(`deterministic:${t}`)).toBe(id);
    }
    for (const t of ["stale-2026-10-01", "run-1759363200", "foo--bar", "deadbeef-dead-beef-dead-beefdeadbeef"]) {
      expect(isVerdictToken(t)).toBe(false);
      expect(verdictClassGapId(`deterministic:${t}`)).toBeNull();
    }
  });
});

describe("qa17: underscore tokens file; more reached-side tokens are excluded by name", () => {
  it("underscore tokens goal-host emits with reached:false are fileable and survive gapClassKey", () => {
    for (const t of ["hollow_walklog_capped", "grep_files-mismatch", "avg_lines-mismatch", "total_lines-mismatch"]) {
      const id = `verdict-class-${t}`;
      expect(gapClassKey(id)).toBe(id);
      expect(verdictClassGaps([big(`deterministic:${t}`)], [], POLICY).gaps.map((g) => g.id)).toEqual([id]);
    }
  });
  for (const t of ["favorable-compose", "escalation-landed", "interrupted-landed"]) {
    it(`deterministic:${t} is excluded`, () => {
      expect(verdictClassGaps([big(`deterministic:${t}`)], [], POLICY).skipped[0]!.reason).toBe("excluded_token");
    });
  }
  it("exclusion is by name, not *-landed: staged-not-landed still files", () => {
    expect(verdictClassGaps([big("deterministic:staged-not-landed")], [], POLICY).gaps.length).toBe(1);
  });
  it("a policy glob may name an underscore token", () => {
    expect(verdictClassGaps([big("deterministic:hollow_walklog_capped")], [], { ...POLICY, exclude_tokens: ["hollow_*"] }).skipped[0]!.reason).toBe("excluded_token");
  });
});
