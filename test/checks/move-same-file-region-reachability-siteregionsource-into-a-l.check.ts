import { describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply";

// The desired state: siteRegionSource lives in a LEAF module importable by the evaluator
// (exports only the reachability reader), so verify-time can run the reachability half
// without pulling the entire gap-check-supply surface. Today, it is co-located with many
// unrelated exports. This check pins the realignment.
describe("move same-file region reachability (siteRegionSource) into a leaf module importable by the evaluator", () => {
  test("siteRegionSource is exported from a LEAF module (the only export)", () => {
    // Sanity: the symbol exists and is callable.
    expect(typeof mod.siteRegionSource).toBe("function");

    // Desired outcome: the module that carries siteRegionSource should export ONLY it,
    // making it safe to import from the evaluator at verify time. This will FAIL today
    // because gap-check-supply exports many names — a structural (placement) defect.
    const exported = Object.keys(mod).filter((k) => k !== "__esModule").sort();
    expect(exported).toEqual(["siteRegionSource"]);
  });
});
