import { describe, expect, test } from "bun:test";
import { autonomyScope, AutonomyScope } from "../../src/judge/gap-policy.js";

describe("autonomyScope reports unverified effects", () => {
  test("a silent exit hides an unverified effect: autonomyScope returns absent true", async () => {
    // The defect: the `autonomyScope` function can return without verifying an effect,
    // leading to a silent exit if the effect is critical for a hub operation.
    // We assert that the `absent` field is true, indicating the effect was not verified.
    const result: AutonomyScope = await autonomyScope();
    expect(result.absent).toBe(true);
    expect(result.reason).toBe("not yet seen");
  });
});
