import { describe, test, expect, mock } from "bun:test";
import * as escalationDispositionApply from "../../src/resolvers/escalation-disposition-apply.js";
import type { EscalationDispositionApplyPointer } from "../../src/resolvers/types.js";

// To isolate the logic in resolveEscalationDispositionApply, we mock its dependencies.
// This prevents network/filesystem access and allows us to provide controlled inputs.

const PENDING_VERIFY_PANEL_ID = "pending_verify:some-gap-id-123";
const UNKNOWN_PANEL_ID = "completely-unknown-panel-id-456";

// Mock the resolver that scans for solicitation outcomes. This provides the panel IDs.
mock.module("../../src/resolvers/solicitation-outcome-scan.js", () => ({
  resolveSolicitationOutcomeScan: async () => ({
    shape: "solicitationOutcomeReport",
    body: {
      outcomes: [
        { solicitation_id: PENDING_VERIFY_PANEL_ID, outcome: "answered" },
        { solicitation_id: UNKNOWN_PANEL_ID, outcome: "answered" },
      ],
    },
  }),
}));

// Mock the helper that reads operator answers from the hold.
// This provides the answer text associated with a panel ID.
// Based on file list, this logic likely resides in lib/operator-hold.ts.
mock.module("../../src/lib/operator-hold.js", () => ({
  readOperatorHold: async (holdId: string) => {
    const answers: Record<string, { recordId: string; value: string }> = {
      [PENDING_VERIFY_PANEL_ID]: { recordId: "rec1", value: "redefine" },
      [UNKNOWN_PANEL_ID]: { recordId: "rec2", value: "redefine" },
    };
    return answers[holdId];
  },
}));

// Mock the substrateGap resolver to avoid DB/network calls.
mock.module("../../src/resolvers/substrate-gap.js", () => ({
  resolveSubstrateGap: async ({ id }: { id: string }) => ({
    shape: "substrateGapResult",
    body: {
      gaps: [{ id, classification_metadata: {} }],
    },
  }),
  resolveSubstrateGapWrite: async () => ({
    shape: "substrateGapWriteResult",
    body: { success: true },
  }),
}));

describe("REALIGNMENT §2.2: escalation-disposition-apply", () => {
  test("an answer for a pending-verify panel is applied, not refused", async () => {
    // This is the failing test that reproduces the bug.
    // The defect is that panel IDs with a 'pending_verify:' prefix are not recognized.
    // This causes an 'unrecognised_panel_id' outcome instead of applying the disposition.
    // The test asserts the expected correct outcome, so it fails until the bug is fixed.

    const pointer: EscalationDispositionApplyPointer = {
      type: "escalation_disposition_apply",
      dry_run: true, // Use dry_run to test logic without triggering writes.
    };

    const result = await escalationDispositionApply.resolveEscalationDispositionApply(pointer);

    const body = (result.body as { dispositions: Array<Record<string, unknown>> });
    const pendingVerifyDisposition = body.dispositions.find((d) => d.panel_id === PENDING_VERIFY_PANEL_ID);

    // This assertion will fail. Expected: "would_apply", Received: "unrecognised_panel_id".
    expect(pendingVerifyDisposition?.outcome).toBe("would_apply");
  });

  test("CONTROL: an answer to a genuinely unknown panel id is still refused as unrecognised_panel_id", async () => {
    // This control test ensures that the fix for pending-verify panels
    // doesn't break the existing, correct behavior of rejecting panel IDs
    // that are truly malformed. This test must pass before and after the fix.

    const pointer: EscalationDispositionApplyPointer = {
      type: "escalation_disposition_apply",
      dry_run: true,
    };

    const result = await escalationDispositionApply.resolveEscalationDispositionApply(pointer);

    const body = (result.body as { dispositions: Array<Record<string, unknown>> });
    const unknownDisposition = body.dispositions.find((d) => d.panel_id === UNKNOWN_PANEL_ID);

    // This behavior is correct and must be preserved.
    expect(unknownDisposition).toEqual({
      panel_id: UNKNOWN_PANEL_ID,
      outcome: "unrecognised_panel_id",
    });
  });
});
