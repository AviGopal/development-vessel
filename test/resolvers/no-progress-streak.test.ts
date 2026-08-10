// Pins the no-progress streak counter behind the anti-loop guard.
//
// THE DEFECT: the guard counted backwards over tool_result.tool, matching only
// code_search / code_find_function and breaking on anything else. A turn whose
// action verb is unrecognised is pushed with NO tool_result, so `undefined` broke
// the scan on the first such turn and the streak was permanently 0 — the guard
// could never fire on the loop it was written for. Observed 2026-08-10: 24
// consecutive code_read_lines emitted with the tool name in the ACTION slot,
// 30-turn cap reached, nothing staged.

import { describe, expect, it } from "bun:test";
import { noProgressStreak, READ_ONLY_TOOLS } from "../../src/resolvers/no-progress-streak.js";

const t = (tool?: string) => (tool === undefined ? {} : { tool_result: { tool } });

describe("noProgressStreak", () => {
  it("counts turns that never became a tool call — the regression", () => {
    // 24 unrecognised-action turns in a row: the exact observed loop.
    const history = Array.from({ length: 24 }, () => t(undefined));
    expect(noProgressStreak(history)).toBe(24);
  });

  it("fires the >=3 threshold on malformed turns (old code gave 0)", () => {
    const history = [t("fs_edit"), t(undefined), t(undefined), t(undefined)];
    expect(noProgressStreak(history)).toBeGreaterThanOrEqual(3);
  });

  it("counts code_read_lines, which the old matcher omitted entirely", () => {
    const history = [t("fs_edit"), t("code_read_lines"), t("code_read_lines"), t("code_read_lines")];
    expect(noProgressStreak(history)).toBe(3);
  });

  it("still counts the two tools the original guard matched", () => {
    expect(noProgressStreak([t("code_search"), t("code_find_function"), t("code_search")])).toBe(3);
  });

  it("counts a mixed graze — reads interleaved with rejected turns", () => {
    const history = [t("fs_write"), t("code_search"), t(undefined), t("code_read_lines"), t("action_guard")];
    expect(noProgressStreak(history)).toBe(4);
  });

  it("RESETS on a real edit — an edit is progress", () => {
    const history = [t(undefined), t("code_read_lines"), t("fs_edit")];
    expect(noProgressStreak(history)).toBe(0);
  });

  it("resets on code_replace_lines too", () => {
    expect(noProgressStreak([t(undefined), t("code_replace_lines")])).toBe(0);
  });

  it("counts guard turns that recorded a rejection rather than a run", () => {
    expect(noProgressStreak([t("fs_edit"), t("parse_guard"), t("action_guard")])).toBe(2);
  });

  it("is 0 on empty history", () => {
    expect(noProgressStreak([])).toBe(0);
  });

  it("treats every declared read-only tool as non-progress", () => {
    for (const tool of READ_ONLY_TOOLS) {
      expect(noProgressStreak([t("fs_edit"), t(tool)])).toBe(1);
    }
  });
});

describe("control: the ORIGINAL matcher on the observed loop", () => {
  // Verbatim old logic — proves the new test discriminates rather than
  // just agreeing with whatever the code happens to do.
  const original = (history: ReadonlyArray<{ tool_result?: { tool?: string } }>) => {
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const tname = history[i]?.tool_result?.tool;
      if (tname === "code_search" || tname === "code_find_function") streak++;
      else break;
    }
    return streak;
  };

  it("returns 0 on 24 malformed turns, so the guard never fired", () => {
    expect(original(Array.from({ length: 24 }, () => t(undefined)))).toBe(0);
  });

  it("returns 0 on a code_read_lines graze", () => {
    expect(original([t("code_read_lines"), t("code_read_lines"), t("code_read_lines")])).toBe(0);
  });
});
