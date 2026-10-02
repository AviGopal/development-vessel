import { describe, it, expect } from "bun:test";
import { verdictClassGaps, verdictClassGapId, recurrenceWindowHours, DEFAULT_VERDICT_CLASS_POLICY, type VerdictClassPolicy } from "../../src/resolvers/verdict-class-gap.js";

/** Fail-closed edges of the verdict-class builder beyond the check-first test: unknown decides nothing. */
const POLICY: VerdictClassPolicy = { ...DEFAULT_VERDICT_CLASS_POLICY, exclude_tokens: [...DEFAULT_VERDICT_CLASS_POLICY.exclude_tokens] };
const C = { class: "deterministic:edit-intent-no-landed-edit", count: 450, distinct_goals: 288 };

describe("verdictClassGaps — fail closed", () => {
  it("an invalid policy files nothing", () => {
    const r = verdictClassGaps([C], [], { ...POLICY, min_count: 0 });
    expect(r.gaps).toEqual([]);
    expect(r.skipped[0]!.reason).toBe("policy_invalid");
    expect(verdictClassGaps([C], [], { ...POLICY, max_new_per_run: Number.NaN }).gaps).toEqual([]);
  });

  it("a non-number count or an unknown goal count never clears a floor", () => {
    expect(verdictClassGaps([{ ...C, count: Number.NaN }], [], POLICY).skipped[0]!.reason).toBe("unmeasured_count");
    expect(verdictClassGaps([{ ...C, distinct_goals: null }], [], POLICY).skipped[0]!.reason).toBe("below_distinct_goals");
  });

  it("a rejected row is a disposition and is never refiled; an unknown status is left alone", () => {
    const id = "verdict-class-edit-intent-no-landed-edit";
    expect(verdictClassGaps([C], [{ id, status: "rejected" }], POLICY).skipped[0]!.reason).toBe("rejected_disposition");
    expect(verdictClassGaps([C], [{ id }], POLICY).skipped[0]!.reason).toBe("existing_status_unknown");
  });

  it("a closed row with no usable closed_at has no recurrence anchor and stays closed", () => {
    const id = "verdict-class-edit-intent-no-landed-edit";
    const r = verdictClassGaps([{ ...C, since_close_count: 99, since_close_distinct_goals: 9 }], [{ id, status: "closed" }], POLICY);
    expect(r.gaps).toEqual([]);
    expect(r.skipped[0]!.reason).toBe("closed_no_anchor");
  });

  it("a reopen carries the since-close basis and reads the top-level closed_at the store writes", () => {
    const id = "verdict-class-edit-intent-no-landed-edit";
    const r = verdictClassGaps([{ ...C, since_close_count: 25, since_close_distinct_goals: 10 }], [{ id, status: "closed", closed_at: "2026-10-01T00:00:00Z" }], POLICY);
    expect(r.gaps[0]!.classification_metadata.reopen_basis).toEqual({ since_closed_at: "2026-10-01T00:00:00Z", since_close_count: 25, since_close_distinct_goals: 10 });
  });

  it("a token the store would rewrite as volatile (date, epoch) is not a class id", () => {
    expect(verdictClassGapId("deterministic:stale-2026-10-01")).toBeNull();
    expect(verdictClassGapId("deterministic:run-1759363200")).toBeNull();
    expect(verdictClassGapId("deterministic:artifact-not-written")).toBe("verdict-class-artifact-not-written");
    expect(verdictClassGapId("deterministic:trailing-")).toBeNull();
  });

  it("the same class twice files one row", () => {
    const r = verdictClassGaps([C, { ...C, count: 400 }], [], POLICY);
    expect(r.gaps.length).toBe(1);
    expect(r.skipped[0]!.reason).toBe("duplicate_class");
  });

  it("the recurrence window is hours since the row's closed_at, or null with no anchor", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    expect(recurrenceWindowHours({ id: "x", status: "closed", closed_at: "2026-10-01T00:00:00Z" }, now)).toBe(24);
    expect(recurrenceWindowHours({ id: "x", status: "closed" }, now)).toBeNull();
  });
});
