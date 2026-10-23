import { describe, test, expect } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply";

describe("existenceOnlyCheck classifier bug", () => {
  test("should identify a behavior check even when the result is bound to a local variable", () => {
    const testSrc = `
      import { describe, test, expect } from "bun:test";
      import * as foreign from "./some-module";

      describe("suite", () => {
        test("a real behavior check", () => {
          const result = foreign.someFunction();
          expect(result).not.toBeNull();
        });
      });
    `;

    const analysis = mod.existenceOnlyCheck(testSrc, ["a real behavior check"]);

    // According to the docstring, a check on a call's result is a behavior assertion.
    // The classifier should see that `result` comes from a function call, so `existence_only` should be false.
    // The bug is that the classifier only looks at `expect(result)` textually and marks it as existence-only.
    // This assertion will therefore fail, which is the purpose of this test.
    expect(analysis.existence_only).toBe(false);
  });
});
