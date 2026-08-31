/**
 * Derive a CLASS-1 CLOSURE PREDICATE from the lines a landing commit REMOVED.
 *
 * WHY THIS SOURCE AND NOT THE GAP SUMMARY. A gap with nothing measurable can never close,
 * even when its fix lands: sweepPendingLandVerifications closes only on a MEASURED 'absent',
 * and a gap with no predicate yields 'pending' and correctly abstains. Measured 2026-08-31:
 * 1366 of 1368 gaps carried no predicate, and the `measured` close-oracle class had been
 * exercised exactly once, ever.
 *
 * A previous attempt derived the literal from the gap SUMMARY (be26a6b) and was reverted as
 * net-negative, for two reasons this source does not share:
 *
 *   1. TIMING. That derivation ran inside substrateGap_write, and the cutover mirrors the fix
 *      into /vessels BEFORE it stamps — so the literal was matched against the POST-FIX file
 *      and read 'present' by construction, permanently. A line the diff REMOVED is
 *      present-in-parent and absent-at-commit by definition; there is no timing window in
 *      which it can be wrong.
 *   2. QUALITY. Of 15 summary-derived literals judged by hand, ~4 named the actual defect.
 *      The rest were inverted (the summary quoted the FIX), insertion anchors the summary
 *      said were retained, or incidental strings. A removed line cannot be any of those: the
 *      patch deleted it, so a correct fix has deleted it.
 *
 * WHAT IT STILL CANNOT GUARANTEE. That the removed line was the DEFECT rather than merely
 * something the drafter chose to remove. This is a real residual, mitigated three ways: the
 * change already passed the semantic gate and a FAVORABLE cutover; a candidate that also
 * appears in the gap summary is preferred, which is the intersection of "provably absent" and
 * "named by the spec"; and a wrong close is RECOVERABLE — detection runs at ~52 gaps/day and
 * the store carries reopen_count, so a still-live defect is re-detected. That is strictly
 * better evidence than the provenance path this replaces, which closed on "a commit exists"
 * and was wrong 599 times.
 */

/** Shorter than this and a line cannot discriminate: `}`, `return;`, `});`. */
export const MIN_REMOVED_LINE_LEN = 16;

/** Lines that are structurally common enough to recur elsewhere in the same file. */
function isTrivial(line: string): boolean {
  const t = line.trim();
  if (t.length < MIN_REMOVED_LINE_LEN) return true;
  if (/^[{}()[\];,]+$/.test(t)) return true;                    // pure punctuation
  if (/^(\/\/|\/\*|\*|#)/.test(t)) return true;                 // comment — reworded, not fixed
  if (/^import\s|^export\s*\{|^from\s/.test(t)) return true;    // import lines churn
  return false;
}

export interface RemovedLine { path: string; line: string }

/**
 * Every `-` line of a unified diff, tagged with the file it came from.
 *
 * Deliberately ignores `---` (the file header) and `+` lines. Reads the path from `+++ b/…`
 * rather than `--- a/…` so a rename reports the destination, which is the file the oracle
 * will later read.
 */
export function removedLinesFromDiff(diff: string): RemovedLine[] {
  if (typeof diff !== "string" || !diff) return [];
  const out: RemovedLine[] = [];
  let path = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      path = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("+")) continue;
    if (raw.startsWith("-") && path) out.push({ path, line: raw.slice(1) });
  }
  return out;
}

/**
 * The removed line to use as a predicate, or null.
 *
 * Prefers a candidate the gap summary also mentions — that intersection is both provably
 * absent after the fix AND named by the thing being fixed, which is the strongest signal
 * available without a detector emitting the literal itself. Falls back to the longest
 * remaining candidate, since length correlates with specificity.
 *
 * Returns null rather than guessing when nothing qualifies: no predicate leaves the gap
 * 'pending', which the sweep handles correctly by abstaining and asking a human.
 */
export function pickRemovedLinePredicate(
  diff: string,
  summary?: string,
): RemovedLine | null {
  const cands = removedLinesFromDiff(diff)
    .map((r) => ({ path: r.path, line: r.line.trim() }))
    .filter((r) => !isTrivial(r.line));
  if (!cands.length) return null;

  const sum = typeof summary === "string" ? summary : "";
  const named = sum ? cands.filter((c) => sum.includes(c.line)) : [];
  const pool = named.length ? named : cands;
  return pool.reduce((a, b) => (b.line.length > a.line.length ? b : a));
}
