/**
 * How many turns in a row have produced NO edit.
 *
 * The anti-search-loop guard (2026-06-17) counted backwards over
 * `history[i].tool_result.tool` and incremented only for `code_search` /
 * `code_find_function`, breaking on anything else. That made it unable to fire on
 * the failure it was written for, in two independent ways:
 *
 *  1. A turn whose action verb is unrecognised is appended to history with NO
 *     `tool_result` at all (the `unknown action` / `missing tool name` branches
 *     just `continue`). `tool_result?.tool` is then `undefined`, which is neither
 *     matched name, so the very FIRST such turn hit `else break` and the streak
 *     was zero forever.
 *  2. `code_read_lines` — the read-only action the model actually loops on — was
 *     never in the matched set.
 *
 * Observed 2026-08-10: turns 6–29 were 24 consecutive `code_read_lines` emitted
 * with the tool name in the ACTION slot, so every one of them landed in the
 * unknown-action branch. The guard never fired, the 30-turn cap was reached, and
 * the gap failed with an error unrelated to its patch. Action distribution over
 * one morning: 65 code_search, 40 code_read_lines, 19 fail, 6 UNPARSEABLE, and
 * only 2 done.
 *
 * A turn counts as progress ONLY if it ran a tool that can change the file.
 * Anything else — a read, a rejected action, a parse failure — is grazing.
 */

/** Read-only inspection tools: useful, but they never advance the patch. */
export const READ_ONLY_TOOLS: readonly string[] = [
  "code_search",
  "code_find_function",
  "code_read_lines",
  "code_find_import",
];

/** Guards that record a rejection rather than a tool run — never progress. */
export const NON_PROGRESS_GUARDS: readonly string[] = [
  "parse_guard",
  "action_guard",
  "noop_done_guard",
];

export type StreakTurn = { tool_result?: { tool?: string } | undefined };

/**
 * Count consecutive trailing turns that made no edit.
 *
 * Counts, walking backwards from the newest turn:
 *   - turns with no `tool_result` (unrecognised action, missing tool name, …)
 *   - turns whose tool is read-only
 *   - turns whose tool is a rejection guard
 * and stops at the first turn that ran anything else — i.e. a real edit attempt.
 */
export function noProgressStreak(history: readonly StreakTurn[]): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const tname = history[i]?.tool_result?.tool;
    if (tname === undefined) { streak++; continue; }          // never became a tool call
    if (READ_ONLY_TOOLS.includes(tname)) { streak++; continue; }
    if (NON_PROGRESS_GUARDS.includes(tname)) { streak++; continue; }
    break;                                                     // an edit tool ran
  }
  return streak;
}
