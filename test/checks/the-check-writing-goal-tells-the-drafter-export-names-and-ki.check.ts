import { expect, test } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply";

// Reproduces: The goal text only names exports and their kind, so the drafter
// guessed how to call them. Here the drafter passes a shape with a `status`
// field to outcomeKindOf, expecting the function to read it — but the defect
// reads the wrong property (e.g. 'kin'), so this assertion fails because of the
// module's behaviour, not a load error.

test("outcomeKindOf respects a drafter's 'status' guess (it doesn't — defect)", () => {
  const guessed = { status: "green" } as const;
  const got = (mod as any).outcomeKindOf(guessed);
  // Expectation from the drafter's guess based on export name/kind only:
  expect(got).toBe(guessed.status);
});
