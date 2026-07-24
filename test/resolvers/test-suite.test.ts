import { expect, test } from "bun:test";
import { resolveTestSuite } from "../../src/resolvers/test-suite.js";

test("resolveTestSuite returns expected shape and body structure", async () => {
  // Invoke the resolver with a minimal pointer.
  const result = await resolveTestSuite({ type: "test_suite" });

  // Assert shape and body presence.
  expect(result).toHaveProperty("shape", "test_suite");
  expect(result).toHaveProperty("body");
  const body = result.body as any;
  expect(body).toHaveProperty("total");
  expect(body).toHaveProperty("pass");
  expect(body).toHaveProperty("fail");
  expect(body).toHaveProperty("skip");
  expect(body).toHaveProperty("failingTests");
  expect(body).toHaveProperty("timestamp");
  expect(Array.isArray(body.failingTests)).toBe(true);
});

test("resolveTestSuite is async and returns a Promise", async () => {
  const resultP = resolveTestSuite({ type: "test_suite" });
  expect(resultP).toBeInstanceOf(Promise);
  const result = await resultP;
  expect(result).toHaveProperty("shape", "test_suite");
});
