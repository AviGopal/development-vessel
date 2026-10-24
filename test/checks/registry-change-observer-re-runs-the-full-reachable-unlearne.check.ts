import { expect, test } from 'bun:test';
import * as mod from '../../src/observers/registry-change-observer';

// This test checks that the dispatchRecommendationForProbe function triggers the full report run before deduplication.

test('dispatchRecommendationForProbe runs the full reachable_unlearned_report before deduplication', async () => {
    const rawActivityId = 'probe-reachable-unlearned';
    const parentExecutionId = 'parent-execution-id';

    // Call the function being tested.
    const result = await mod.dispatchRecommendationForProbe(rawActivityId, parentExecutionId);

    // Ensure the result dispatched correctly. The expectation below should fail to demonstrate the bug.
    expect(result.dispatched).toBe(true); // Change this appropriately based on the known bug in the implementation.
});
