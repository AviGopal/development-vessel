import { describe, expect, test } from "bun:test";
import { checkValueSanity } from "../../src/lib/detector-output-sanity.js";

describe("detector value-sanity (Nth-order self-check)", () => {
  test("flags a *_fraction outside [0,1] (the coverage_fraction=1.65 regression)", () => {
    const v = checkValueSanity({ coverage_fraction: 1.65, total_advertised_shapes: 20 });
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("fraction_out_of_range");
  });

  test("flags a *_passing=true over an explicitly-unmeasured dimension", () => {
    const v = checkValueSanity({
      health_verdict: { optimality_passing: true, optimality_measured: false, overall_passing: true },
    });
    expect(v.some((x) => x.kind === "passing_while_unmeasured")).toBe(true);
  });

  test("flags non-finite numbers (NaN / Infinity)", () => {
    expect(checkValueSanity({ autonomous_closure_ratio: NaN }).some((x) => x.kind === "non_finite")).toBe(true);
    expect(checkValueSanity({ some_fraction: Infinity }).some((x) => x.kind === "non_finite")).toBe(true);
  });

  test("flags a negative *_ratio", () => {
    expect(checkValueSanity({ optimality_ratio: -0.3 }).some((x) => x.kind === "negative_ratio")).toBe(true);
  });

  test("does NOT flag healthy detector output (no false positives)", () => {
    expect(checkValueSanity({ coverage_fraction: 0.375, advertised_learned_unique: 9 })).toHaveLength(0);
    expect(
      checkValueSanity({
        health_verdict: { optimality_passing: null, optimality_measured: false, overall_passing: true, confidence_passing: true },
      }),
    ).toHaveLength(0);
  });

  test("allows a *_ratio > 1 (ratios may legitimately exceed 1, unlike fractions)", () => {
    expect(checkValueSanity({ mean_optimality_ratio: 1.8 })).toHaveLength(0);
  });

  test("recurses into nested objects and arrays", () => {
    const v = checkValueSanity({ rows: [{ ok_fraction: 0.5 }, { bad_fraction: 2.0 }] });
    expect(v.some((x) => x.path.includes("bad_fraction"))).toBe(true);
  });
});
