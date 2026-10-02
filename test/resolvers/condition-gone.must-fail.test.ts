import { describe, it, expect } from "bun:test";
import { conditionGoneVerdict } from "../../src/resolvers/condition-gone.js";
import { signalAddress } from "../../src/lib/signal-window.js";

/** Must-fail probes from review (qa15), kept as tests: each one CLOSED a gap in the first cut. */
const ADDR = signalAddress({ reason_contains: "URL is invalid", window_hours: 72, limit: 100 }, "organizations:substrate");
const OTHER_ORG = signalAddress({ reason_contains: "URL is invalid", window_hours: 72 }, "unknown");
const m = (matched_total: number | null, window_hours = 72, address = ADDR) => ({ matched_total, measured: true, window_hours, address });
const ctl = (matched_total: number, population: string = "failed_with_failure_mode", address = ADDR) => ({ ...m(matched_total, 72, address), population });
const BASE = { min_before: 3, min_after_hours: 72, after_window_hours: 72, address: ADDR, signature_kind: "reason_contains" as const, control: ctl(9043) };

describe("conditionGoneVerdict — the control is the FILTERED population, through the same address", () => {
  it("a raw-traffic control (no population, or 'all') does not close", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(500), after: m(0), control: { ...m(9043) } as never }).reason).toBe("control_unfiltered");
    expect(conditionGoneVerdict({ ...BASE, before: m(500), after: m(0), control: ctl(9043, "all") as never }).reason).toBe("control_unfiltered");
  });
  it("a failure_class signature needs a control of CLASSED failures: class stamping that regressed does not read as gone", () => {
    const v = conditionGoneVerdict({ ...BASE, signature_kind: "failure_class", before: m(500), after: m(0), control: ctl(9043, "failed_with_failure_mode") as never });
    expect(v.close).toBe(false);
    expect(v.reason).toBe("control_unfiltered");
    expect(conditionGoneVerdict({ ...BASE, signature_kind: "failure_class", before: m(500), after: m(0), control: ctl(0, "failed_with_class") as never }).reason).toBe("control_saw_nothing");
  });
  it("a read through another address (other org) does not close", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(500), after: m(0, 72, OTHER_ORG) }).reason).toBe("address_mismatch");
    expect(conditionGoneVerdict({ ...BASE, before: m(500), after: m(0), control: ctl(436, "failed_with_failure_mode", OTHER_ORG) as never }).reason).toBe("address_mismatch");
  });
});

describe("conditionGoneVerdict — a recorded baseline counts only for the address it was read through", () => {
  it("a bare-number baseline is not used", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(0), after: m(0), recorded_baseline: 6853 as never }).reason).toBe("signature_never_matched");
  });
  it("a baseline recorded through another address (org or input) is not used", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(0), after: m(0), recorded_baseline: { count: 6853, address: OTHER_ORG } }).reason).toBe("signature_never_matched");
  });
  it("the address ignores the window keys, so the baseline recorded at filing still matches later reads", () => {
    const later = signalAddress({ limit: 100, window_hours: 168, until_hours_ago: 72, reason_contains: "URL is invalid" }, "organizations:substrate");
    expect(later).toEqual(ADDR);
    expect(conditionGoneVerdict({ ...BASE, before: m(0), after: m(0), recorded_baseline: { count: 6853, address: later } }).close).toBe(true);
  });
});

describe("conditionGoneVerdict — windows", () => {
  it("the caller's after_window_hours must match the window the reads echo (1e9 does not close)", () => {
    expect(conditionGoneVerdict({ ...BASE, after_window_hours: 1e9, before: m(500), after: m(0) }).reason).toBe("window_mismatch");
  });
  it("a read that does not echo its window does not close", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(500), after: { matched_total: 0, measured: true, address: ADDR } as never }).reason).toBe("window_mismatch");
  });
  it("min_after_hours below 24 is an invalid policy", () => {
    expect(conditionGoneVerdict({ ...BASE, min_after_hours: 1, after_window_hours: 1, before: m(500), after: m(0, 1), control: { ...ctl(9), window_hours: 1 } as never }).reason).toBe("policy_invalid");
  });
});

describe("conditionGoneVerdict — the CONTROL must cover the caller's after-window too (qa17)", () => {
  it("a control read over another window does not close, even when the after read matches", () => {
    const v = conditionGoneVerdict({ ...BASE, before: m(500), after: m(0), control: { ...ctl(9043), window_hours: 24 } as never });
    expect(v.close).toBe(false);
    expect(v.reason).toBe("window_mismatch");
  });
  it("a control read that does not echo its window does not close", () => {
    const { window_hours: _w, ...noWindow } = ctl(9043);
    expect(conditionGoneVerdict({ ...BASE, before: m(500), after: m(0), control: noWindow as never }).reason).toBe("window_mismatch");
  });
});
