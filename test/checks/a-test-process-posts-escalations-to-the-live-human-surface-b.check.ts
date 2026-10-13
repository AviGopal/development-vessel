import { test, expect, mock } from "bun:test";
import * as mod from "../../src/resolvers/gap-to-feature.js";
import type { GapToFeaturePointer } from "../../src/resolvers/gap-to-feature.js";

// This check file is being added to reproduce a bug where the test suite
// can make live HTTP calls to escalate questions to a human. This should
// never happen from an automated test run.
//
// The bug description states that even with existing test isolation for the
// gap store, these HTTP writes are not prevented. This test specifically
// checks for those writes by mocking `fetch` and asserting it's not called.

test("resolveGapToFeature should not post escalations to a live surface from a test process", async () => {
  // We mock the global fetch to intercept any HTTP calls.
  const fetchMock = mock(() => {
    // This mock implementation returns a generic successful response.
    // The key is that it's being called at all, which is the bug.
    return Promise.resolve(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;

  // The bug is in the "pick pass". To trigger this, we call resolveGapToFeature
  // without a specific gap in the pointer, ensuring the 'pick' logic is exercised.
  // The existing test fixtures for the gap store should provide candidates for picking.
  const pointer: GapToFeaturePointer = {} as GapToFeaturePointer;

  try {
    // We expect this call to trigger the defective behavior.
    // It might throw an error for other reasons in a test environment (e.g., missing configs).
    // We catch and ignore them because our focus is solely on whether an outbound HTTP call was made.
    await mod.resolveGapToFeature(pointer);
  } catch (e) {
    // Ignoring errors to ensure the assertion on fetchMock is reached.
  }

  // This is the core assertion of the test.
  // It will fail if the bug is present (i.e., if fetch was called).
  // A failing test is the goal here, to prove the existence of the defect.
  expect(fetchMock).not.toHaveBeenCalled();

  // Restore the original fetch function to not interfere with other tests.
  globalThis.fetch = originalFetch;
});
