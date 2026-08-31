/**
 * Derive a CLASS-1 CLOSURE PREDICATE for a gap at write time.
 *
 * WHY THIS EXISTS. A gap with no measurable predicate can never close, even when its fix
 * lands. Verified end-to-end on the live fleet 2026-08-31:
 *
 *   1. the substrate detects a defect and files a prose-only gap
 *   2. it drafts a fix and LANDS it — 569881d, Substrate Autonomous, mitosis-cutover
 *      verdict=FAVORABLE with cited_checks ["bun run lint","bun test"], deployed
 *   3. vessel-mitosis-cutover stamps classification_metadata.pending_outcome_verification
 *   4. sweepPendingLandVerifications finds it, confirms the sha is an ancestor of a clone
 *      and was not reverted
 *   5. verifyGapConditionAsync returns 'pending' — there is NOTHING TO MEASURE
 *   6. the sweep correctly abstains and the gap stays open, is recomposed, and its
 *      recommit- lineage grows
 *
 * The sweep is not broken and must not be changed to close on provenance: a landed commit
 * does not prove a defect is gone. Same day, reach-history-weekly-counter closed on a
 * class-1 CODE literal while the corrupted rows its broken writer had already written
 * survived untouched. Closing on provenance alone reinstates the inert-diff hole that
 * sweep's own comment names.
 *
 * So the defect is upstream, at CREATION. Measured at the time of writing: 410 open gaps,
 * 164 cite a file, and exactly ONE carries a predicate — hand-written by an operator. The
 * closure machinery demonstrably works when the input has one: the gap
 * investigation-grep-evidence-is-eaten-by-node-modules closed with
 * closed_reason=landed_and_verified_by_class1_predicate once given file_path + hardcoded_url.
 *
 * WHAT THIS DOES NOT DO. It never invents a literal. A wrong predicate is worse than none —
 * it either closes a gap whose defect is still live, or pins a gap open forever against a
 * string that was never in the file. Every rule below exists to make "no predicate" the
 * default outcome and a derived one the exception that had to earn it.
 */

/** Below this, a literal is too generic to discriminate ("return", "const x", "}"). */
export const MIN_LITERAL_LEN = 12;

/**
 * Pull candidate code literals out of a gap summary.
 *
 * Detectors and drafters quote code in backticks; operators sometimes use quotes. Take all
 * three, longest first, so the most specific candidate is tested before a shorter one that
 * might also match.
 */
export function extractCandidateLiterals(summary: string): string[] {
  if (typeof summary !== "string" || !summary) return [];
  const out: string[] = [];
  // Backtick spans first — the convention in this codebase's gap summaries.
  for (const m of summary.matchAll(/`([^`\n]{4,300})`/g)) if (m[1]) out.push(m[1]);
  // Then quoted spans. Excluded from the double-quoted class: strings containing a space
  // AND ending in a period, which are almost always prose sentences, not code.
  for (const m of summary.matchAll(/"([^"\n]{4,300})"/g)) if (m[1] && !/\s.*\.$/.test(m[1])) out.push(m[1]);
  for (const m of summary.matchAll(/'([^'\n]{4,300})'/g)) if (m[1] && !/\s.*\.$/.test(m[1])) out.push(m[1]);
  const seen = new Set<string>();
  return out
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_LITERAL_LEN)
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
    .sort((a, b) => b.length - a.length);
}

/** Occurrences of `needle` in `haystack` — plain substring, the same test the oracle runs. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

/**
 * The literal to use as a class-1 predicate, or null.
 *
 * UNIQUENESS IS THE WHOLE TEST. The oracle closes when the literal goes ABSENT, so a
 * predicate that matches twice cannot tell "the defect was fixed" from "one of two similar
 * sites was fixed", and a predicate that matches zero times is already absent and would
 * close the gap immediately on a defect nobody touched. Exactly one, or nothing.
 */
export function derivePredicateLiteral(summary: string, fileContent: string): string | null {
  if (typeof fileContent !== "string" || !fileContent) return null;
  for (const cand of extractCandidateLiterals(summary)) {
    if (countOccurrences(fileContent, cand) === 1) return cand;
  }
  return null;
}
