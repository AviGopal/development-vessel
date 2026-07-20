import { test, expect } from "bun:test";
import { resolveRecurringPatternConcept } from "../../src/resolvers/recurring-pattern-concept.js";

test("resolveRecurringPatternConcept returns non-hollow report shape", async () => {
  const result = await resolveRecurringPatternConcept({ type: "recurringPatternConcept", limit: 5 });
  expect(result.shape).toBe("recurringPatternConcept");
  const body = result.body as { name: string; description: string; activities: unknown[] };
  expect(typeof body.name).toBe("string");
  expect(typeof body.description).toBe("string");
  expect(Array.isArray(body.activities)).toBe(true);
});
