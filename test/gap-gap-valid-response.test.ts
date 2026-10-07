import { test, expect } from "bun:test";
import { type ValidResponse } from "../src/schemas/valid_response";

test("valid_response producer capability gap", async () => {
  // This test will fail because there is no producer for 'valid_response'.
  // The goal is to add a resolver that produces this shape.
  const response = await fetch("http://localhost:3000/impulse", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      goal: "Produce a valid response",
      _produce_shape: "valid_response",
    }),
  });

  expect(response.status).toBe(200);
  const data: ValidResponse = await response.json();
  expect(data).toEqual({
    status: "success",
    message: "This is a valid response.",
  });
});
