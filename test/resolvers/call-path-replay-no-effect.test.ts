// REPLAY OF A REAL NO-EFFECT ROUND: THE SECOND ROUND'S PROMPT NAMES THE FUNCTION THE CHECK EXERCISES.
//
// The gap's own check (test/checks/a-check-judged-green-at-head-by-a-since-fixed-judging-defect.check.ts, edit site
// src/resolvers/gap-check-supply.ts) is red on the untouched tree by an expect() on a value priorAttemptSentence
// returns, so its stack holds only the check file's frame and a runtime frame. A draft that edited lines the check never
// runs failed identically on the parent (no_effect_vs_parent) and the next round was told only the refused region. The
// fixtures are that check's source and its red run (`bun test ./<check>` on the tree, the run's root renamed); the
// vessel's own src/resolvers/gap-check-supply.ts is read live. Expected: the call path resolves the check's
// `mod.priorAttemptSentence(` call to its declaration, which is the function that walks the settled attempts for a
// JUDGED_NOT_ARMED state (the arm loop in supplyPass, which the check never reaches, is not named); the attempt record
// carries it; and the next round's prior-attempt block prints it beside the refused region.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as RE from "../../src/resolvers/retry-evidence.js";
import * as FC from "../../src/resolvers/feature-compose.js";

const VESSEL_ROOT = join(import.meta.dir, "..", "..");
const FIX = join(import.meta.dir, "..", "fixtures", "call-path");
const CHECK = "test/checks/a-check-judged-green-at-head-by-a-since-fixed-judging-defect.check.ts";
const SITE = "src/resolvers/gap-check-supply.ts";
const RED_RUN = readFileSync(join(FIX, "replay-no-effect-red.txt"), "utf8");
const CHECK_SRC = readFileSync(join(FIX, "replay-check-source.ts.txt"), "utf8");
const SITE_SRC = readFileSync(join(VESSEL_ROOT, SITE), "utf8");
const read = (rel: string): string | null => (rel === CHECK ? CHECK_SRC : (() => { try { return readFileSync(join(VESSEL_ROOT, rel), "utf8"); } catch { return null; } })());
const PREFIX = "repos/development-vessel/";
const lineOf = (re: RegExp): number => SITE_SRC.split("\n").findIndex((l) => re.test(l)) + 1;

describe("replay: a no-effect round on the green_at_head check", () => {
  const failing = RE.parseOwnCheckFailures(RED_RUN);
  const callPath = (): ReturnType<typeof FC.ownCheckCallPath> => FC.ownCheckCallPath({ raw: RED_RUN, test_file: CHECK, only: [], failing, vessel_root: VESSEL_ROOT, prefix: PREFIX, read });

  it("the replayed run is a red by assertion with no src frame (so the path is the static one)", () => {
    expect(failing.map((f) => f.name)).toEqual(["gap-check-supply: green_at_head settlement defect > priorAttemptSentence for green_at_head should return an empty string to allow re-judging"]);
    expect(RE.sameOwnCheckFailures(failing, RE.parseOwnCheckFailures(RED_RUN))).toBe(true);
    expect(RE.checkCallPathFromRun(RED_RUN, CHECK, { roots: [VESSEL_ROOT], prefix: PREFIX, read })).toEqual([]);
  });

  it("POSITIVE CONTROL: the path names priorAttemptSentence, the JUDGED_NOT_ARMED walk the check calls, at its declaration", () => {
    const decl = lineOf(/^export function priorAttemptSentence\b/);
    expect(decl).toBeGreaterThan(0);
    // The declaration found is the function that walks the settled history for a JUDGED_NOT_ARMED state.
    expect(SITE_SRC.split("\n").slice(decl - 1, decl + 12).join("\n")).toContain("JUDGED_NOT_ARMED.has(");
    expect(callPath()).toEqual([{ path: `${PREFIX}${SITE}`, fn: "priorAttemptSentence", line: decl }]);
    // Not the arm loop's settle (supplyPass) or the history builder: the check reaches neither.
    expect(callPath().map((e) => e.fn)).not.toContain("supplyPass");
    expect(callPath().map((e) => e.fn)).not.toContain("settledHistory");
  });

  it("the second round's prompt carries the call path beside the refused region", () => {
    const span = RE.spanRecord(`${PREFIX}${SITE}`, SITE_SRC, 671, 672);
    const verify = { vessel: "development-vessel", errors: "verify", exit_code: 0, ok: false, output: RED_RUN, stage: "own_check", own: { test_file: CHECK, failing, no_effect_vs_parent: true, call_path: callPath() } } as unknown as FC.VerifyResult;
    const { record } = FC.composeAttemptEvidence([{ ok: true, base_span: span }], [], [verify], false, null);
    const lesson = { at: "round-1", class: "own_check_red", reason: "own check still red", ...record };
    const prompt = FC.priorAttemptFeedbackBlock({ failure_lessons: [lesson] });
    const decl = lineOf(/^export function priorAttemptSentence\b/);
    // The excerpt, in the run's output: what the next round reads.
    console.log(prompt.split("\n").filter((l) => /REFUSED REGIONS|call path|effect vs parent/.test(l)).join("\n"));
    expect(prompt).toContain(`REFUSED REGIONS (an edit op overlapping one of these is refused before it is written): ${PREFIX}${SITE}:671-672`);
    expect(prompt).toContain(`the check's call path: ${PREFIX}${SITE}:priorAttemptSentence:${decl}`);
  });
});
