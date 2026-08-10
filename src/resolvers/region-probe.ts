/**
 * Candidate "region" locators extracted from goal / gap / spec prose.
 *
 * WHY THIS EXISTS. `focusedSlice` takes a primary probe and centres the grounding
 * window on it, which is the difference between handing the drafter the ~6KB around
 * the real edit site and handing it an arbitrary slice of a 140KB file. But the only
 * ways to supply that probe were:
 *
 *   - `classification_metadata.region` — carried by **0 of 402** live gaps, and
 *   - a matcher requiring the literal English phrase `in the region "<name>"`.
 *
 * Nothing emits either. Measured 2026-08-10: every `[fc-plan]` ever logged shows
 * `"region":null` beside `grounding_len` around 51,000, and `anchor_not_found` is the
 * single largest recorded failure class (37 lessons) — the drafter reconstructing
 * `old_string` anchors from a blob it cannot hold. A goal dispatched with that exact
 * phrase as its FIRST WORDS still produced `region:null`, because goal text is
 * rewritten before it becomes a gap summary and the phrase is stripped. Dead by both
 * routes.
 *
 * Prose about code names the code. `classifyComposeFailure`, `TC_EXIT`,
 * `goal_execution_paths` — these appear verbatim in both the request and the file.
 * That is the locator the pipeline already has and never used.
 *
 * SAFETY. A wrong candidate cannot mislocalise anything: `focusedSlice` does
 * `content.indexOf(probe)` and falls through to the existing heuristics when the probe
 * is absent. A candidate that does not occur in the file is inert, so this is strictly
 * additive — it can only turn a miss into a hit.
 */

/** Words that look like identifiers but locate nothing useful. */
const STOPWORDS = new Set([
  "because", "therefore", "whenever", "instead", "however", "although", "actually",
  "concatenation", "combined", "reported", "recorded", "successful", "failure",
  "failures", "against", "already", "another", "between", "through", "without",
  "measured", "returns", "returned", "produces", "produced", "requires", "required",
  "contains", "containing", "resolves", "resolved", "including", "structure",
]);

/**
 * Ordered candidate probes, most distinctive first.
 *
 * Accepts three identifier shapes that survive prose intact:
 *   - camelCase / PascalCase with an internal case change (`classifyComposeFailure`)
 *   - snake_case / SCREAMING_SNAKE with an underscore (`TC_EXIT`, `goal_execution_paths`)
 *   - dotted or dashed code-ish tokens (`content.body`, `sub-fleet-elapsed`)
 *
 * A plain lowercase English word is NEVER a candidate — it would match somewhere in
 * every file and centre the window on noise. Requiring an internal case change,
 * underscore, dot or dash is what separates "code being named" from "prose".
 */
export function regionCandidatesFromText(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  // Quoted or backticked spans first: an author who quotes is pointing.
  for (const m of text.matchAll(/[`"']([A-Za-z_$][\w$.\-]{3,80})[`"']/g)) {
    const tok = m[1]!;
    if (!seen.has(tok)) { seen.add(tok); out.push(tok); }
  }

  const CODEISH = /\b([A-Za-z_$][A-Za-z0-9_$]*(?:[._-][A-Za-z0-9_$]+)+|[a-z$_][a-z0-9$_]*[A-Z][A-Za-z0-9_$]*|[A-Z][a-z0-9_$]+[A-Z][A-Za-z0-9_$]*|[A-Z]{2,}(?:_[A-Z0-9]+)+)\b/g;
  for (const m of text.matchAll(CODEISH)) {
    const tok = m[1]!;
    if (tok.length < 5 || tok.length > 80) continue;
    if (STOPWORDS.has(tok.toLowerCase())) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }

  // Longest first: a longer identifier is rarer, so it centres more precisely. (Unlike
  // the generic probe list, where length ordering is wrong because an 80-char prose
  // sentence outranks a short region literal — these are all identifiers, so length
  // really does track specificity here.)
  return out.sort((a, b) => b.length - a.length);
}
