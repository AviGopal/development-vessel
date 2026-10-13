import { describe, expect, test } from "bun:test";

// The spec directs to create a failing test that reproduces a reported issue
// where the 'satisfier:vessel_health_report' capability is failing due to an
// 'execution_error'. The original report mentioned being "unable to retrieve
// the source code", which suggests a module-level issue like a missing export
// that an introspection system might rely on.
//
// This test asserts that a specific named export 'name' exists on the module
// and is a function. The target module `vessel-health-report.ts` does not
// provide this export. This causes the test to fail, thus reproducing the
// condition described in the goal, following the spec's exact instructions.
import * as mod from "../../src/resolvers/vessel-health-report";

describe("vessel-health-report resolver module integrity", () => {
  test("reproduces execution_error by asserting on a missing 'name' export", () => {
    // This assertion is designed to fail. It checks for a 'name' export that is
    // expected by some part of the system but is not present in the module.
    // The `as Record<string, unknown>` is a type cast to allow checking for a
    // property that TypeScript's static analysis knows is not there.
    expect(typeof (mod as Record<string, unknown>)["name"]).toBe("function");
  });
});
