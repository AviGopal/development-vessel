// Pins the compose capacity cap's arithmetic.
//
// Measured on substrate-live before this landed: 27 concurrent typecheck/test
// processes at load 50.8 on 14 CPUs — 3.6x oversubscribed. Per-compose worktree
// isolation had made concurrent composes CORRECT, so the old refusal was dropped
// as "no longer needed"; nothing replaced it with a resource bound. Correct is
// not the same as affordable.
//
// The predicate is duplicated rather than exported because importing the resolver
// pulls in the whole vessel; it must change in both places together.
import { describe, test, expect } from "bun:test";

// Mirrors the resolver. `Math.max(1, Number("typo"))` is NaN and `n >= NaN` is
// always false, so a mistyped env var would silently disable the cap — a
// fail-open wearing protection's clothes. Any invalid value falls back to the
// default, never to "unlimited".
const capFrom = (env: string | undefined): number => {
  const raw = Number(env ?? 2);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
};
const shouldRefuse = (inFlight: number, cap: number): boolean => inFlight >= cap;

describe("compose capacity cap", () => {
  test("defaults to 2 concurrent composes", () => {
    expect(capFrom(undefined)).toBe(2);
  });

  test("refuses at and above the cap, admits below", () => {
    expect(shouldRefuse(0, 2)).toBe(false);
    expect(shouldRefuse(1, 2)).toBe(false);
    expect(shouldRefuse(2, 2)).toBe(true);
    expect(shouldRefuse(27, 2)).toBe(true); // the observed storm
  });

  test("never floors below 1 — a cap of 0 would halt self-development entirely", () => {
    // A misconfigured 0 or a garbage value must not become "refuse everything".
    for (const bad of ["0", "-5", "not-a-number", "", "2x", "Infinity"]) {
      const c = capFrom(bad);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(1);
      // and it must still REFUSE at the storm level, not silently admit
      expect(shouldRefuse(27, c)).toBe(true);
    }
  });

  test("is tunable upward for a bigger host", () => {
    expect(capFrom("6")).toBe(6);
    expect(shouldRefuse(4, 6)).toBe(false);
  });
});
