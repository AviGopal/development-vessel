// Pins the truncated-completion guard (task #12).
//
// THE DEFECT: llm-resolver-vessel has always returned `stop_reason` on BOTH
// provider paths — and even normalises the openai spelling (`finish_reason:
// "length"`) into the anthropic one (`"max_tokens"`) — while EVERY consumer read
// it zero times. feature-compose, patch-with-tools, apply-proposal-as-patch,
// resolver-author, goal-host and local-tools all send `max_tokens` and none
// looked at how generation ended.
//
// So a patch severed mid-token was credited exactly like a complete one, and
// then spent a typecheck, a mitosis slot and a Thompson observation discovering
// what the response body had already said.
import { describe, expect, test } from "bun:test";
import { isTruncatedCompletion } from "../../src/resolvers/feature-compose";

describe("isTruncatedCompletion", () => {
  test("catches the anthropic spelling", () => {
    expect(isTruncatedCompletion("max_tokens")).toBe(true);
  });

  test("catches the raw openai spelling too", () => {
    // The resolver normalises "length" -> "max_tokens" in ONE provider branch.
    // Relying on that would leave this blind the moment a new provider lands its
    // own wire format, so both spellings are accepted here.
    expect(isTruncatedCompletion("length")).toBe(true);
  });

  test("a normal completion is not truncated", () => {
    expect(isTruncatedCompletion("end_turn")).toBe(false);
    expect(isTruncatedCompletion("stop")).toBe(false);
    expect(isTruncatedCompletion("tool_use")).toBe(false);
  });

  test("a resolver that does not report stop_reason keeps working", () => {
    // undefined must NOT read as truncated: a provider without the field would
    // otherwise have every call rejected — turning a safety check into an
    // outage. Absent evidence is not evidence of truncation.
    expect(isTruncatedCompletion(undefined)).toBe(false);
    expect(isTruncatedCompletion(null)).toBe(false);
    expect(isTruncatedCompletion("")).toBe(false);
  });

  test("ignores non-string values rather than coercing them", () => {
    expect(isTruncatedCompletion(0)).toBe(false);
    expect(isTruncatedCompletion({ type: "max_tokens" })).toBe(false);
  });
});
