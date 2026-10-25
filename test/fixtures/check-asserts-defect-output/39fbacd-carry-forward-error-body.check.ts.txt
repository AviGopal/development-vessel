import { expect, describe, it } from "bun:test";
import * as mod from "../../src/walk-pool";
import type { PoolImpulseLike } from "../../src/walk-pool";

describe("carryForward", () => {
  it("should not carry forward impulses with non-stub error bodies", () => {
    const pool: readonly PoolImpulseLike[] = [
      {
        id: "impulse-1",
        content: {
          // This error shape, where `error` is an object instead of a string,
          // is not recognized by the current `isFailedContent` logic, unlike
          // `{ error: "string_code" }` which is correctly handled.
          error: {
            code: "E_DOWNSTREAM_FAILURE",
            message: "The downstream service returned an error.",
          },
        },
        metadata: {
          shape: "service-result",
          producedBy: "step-A",
          producerExecutionId: "exec-123",
        },
      },
    ];

    const carried = mod.carryForward(pool, new Set());

    // The defect is that `carryForward` carries this impulse, because `isFailedContent`
    // does not recognize this error body shape (where `error` is an object).
    // The retry then starts with failed content. The correct behavior is to drop it,
    // resulting in an empty array.
    expect(carried).toEqual([]);
  });
});
