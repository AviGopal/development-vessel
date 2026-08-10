// Pins the in-flight classifier.
//
// THE REGRESSION: the previous implementation regex-matched the RAW REQUEST BODY,
// so a gap record that merely NAMED a compose counted as a live compose. Measured
// against an independent census (`ls /workspace/compose-slots/*.slot` = 1) the
// vessel reported in_flight = 9. That number gates the SIGTERM drain and
// substrate-pull-sync's restart deferral, so the inflation caused the very
// compose-killing restarts the counter existed to prevent.
//
// The first case below is the one that failed before the fix.
import { describe, expect, test } from "bun:test";
import { isLongRunningBody } from "../src/long-running";

describe("isLongRunningBody — must not count requests that merely MENTION composing", () => {
  test("a gap record naming feature-compose is NOT a compose (the 9-vs-1 bug)", () => {
    const gapWrite = JSON.stringify({
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap_id: "feature-compose-has-no-concurrency-cap",
          summary: "feature_compose has no concurrency cap; patch_with_tools storms the host",
        },
      },
    });
    expect(isLongRunningBody(gapWrite)).toBe(false);
  });

  test("prose about vessel_mitosis is not a mitosis", () => {
    expect(
      isLongRunningBody(JSON.stringify({ pointer: { type: "memoryNote_write", body: "vessel_mitosis notes" } })),
    ).toBe(false);
  });
});

describe("isLongRunningBody — must still count the real thing", () => {
  test("both envelope spellings are recognised", () => {
    expect(isLongRunningBody(JSON.stringify({ impulse: { pointer: { type: "feature_compose" } } }))).toBe(true);
    expect(isLongRunningBody(JSON.stringify({ pointer: { type: "feature_compose" } }))).toBe(true);
  });

  test("every long-running pointer type counts", () => {
    for (const t of [
      "feature_compose",
      "patch_with_tools",
      "apply_proposal_as_patch",
      "vessel_mitosis",
      "vessel_mitosis_cutover",
    ]) {
      expect(isLongRunningBody(JSON.stringify({ impulse: { pointer: { type: t } } }))).toBe(true);
    }
  });
});

describe("isLongRunningBody — fails closed, never throws", () => {
  test("non-JSON and empty bodies are not counted", () => {
    // A compose pointer is always a JSON envelope, so unparseable is conclusive.
    expect(isLongRunningBody("not json at all")).toBe(false);
    expect(isLongRunningBody("")).toBe(false);
    expect(isLongRunningBody("{broken")).toBe(false);
  });

  test("well-formed JSON with no pointer is not counted", () => {
    expect(isLongRunningBody(JSON.stringify({ hello: "world" }))).toBe(false);
    expect(isLongRunningBody(JSON.stringify({ impulse: {} }))).toBe(false);
  });

  test("a non-string pointer type cannot match", () => {
    expect(isLongRunningBody(JSON.stringify({ pointer: { type: 42 } }))).toBe(false);
  });
});
