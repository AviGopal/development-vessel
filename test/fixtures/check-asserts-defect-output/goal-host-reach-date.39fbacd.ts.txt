/**
 * THE CLOCK AT SYNTHESIS AND AT THE JUDGE — one family parse, two readers.
 *
 * MEASURED (output-shapes track 4, 61 end-of-walk verdicts on the current-events family,
 * 09-30 → 10-01): the reach judge has no clock. It got "today" right only when a 2026-dated search
 * result happened to be in view, and both REACHED verdicts in the family were stale fabrications
 * ("Today is October 27, 2023"; "as of mid-2024"). Prose in the judge prompt was tried for this
 * class and did not hold (8a85cfa, 2c26fcb). So the judge half is a DETERMINISTIC COMPARISON in the
 * oracle chain, never prompt text: a dated deliverable whose asserted "today" is off the host clock
 * by more than a day is not a reach. In-date deliverables ABSTAIN — a correct date proves nothing
 * else, so the judge (or a later grounded-report oracle) still decides those.
 *
 * The writer half has no other channel: an LLM writer can only know the date if it is bound into
 * what it reads. The walk already binds the host clock into arg extraction and the producer pick
 * (07-11, `temporalGrounding`); `temporalGroundingBlock` is that same block, lifted so the
 * llm_completion synthesis prompt reads it too, and only for time-relative goals.
 *
 * Authority: the host clock read at use time; the compared date is written into the reason. A
 * served clock shape is the upgrade, not a prerequisite.
 */

export interface DateVerdict {
  reached: false;
  reason: string;
  completion_shapes: string[];
  deterministic: true;
}

const DAY_MS = 86_400_000;

/** Shapes whose content is EVIDENCE (search results, fetched pages), not the deliverable. Their
 *  dates are the world's, and a 2026-dated search result must never vouch for — or condemn — the
 *  writer's own claim. */
export const EVIDENCE_SHAPES: ReadonlySet<string> = new Set([
  "web_search", "webSearchResult", "http_fetch", "httpResponse", "web_resource", "webResource",
]);

/** Shapes whose content IS an answer to a person (LLM writers, the walk's own answer shapes). Only
 *  these — and the unlabelled captured segment — are read as the deliverable's own date claims;
 *  an intermediate's "as of September 15" (a gap row, a file, a shell listing) is data, not a claim
 *  about today. Shared with judge-view.ts, which puts the same shapes first. */
export const ANSWER_SHAPES: ReadonlySet<string> = new Set([
  "llm_completion", "llmCompletion", "llm_completion_result", "llmTextCompletion", "goal_answer", "human_presentation",
]);

/** A goal about a specific DAY relative to now. "current", "currently" and "latest" are NOT in it:
 *  "the current population", "the latest TypeScript", "how the walk currently handles retries" are
 *  answered correctly by a dated fact ("as of 2024 …"), which is not a claim about today (qa probe). */
const TIME_RELATIVE_RE = /\b(today|today'?s|tonight|yesterday|tomorrow|this (?:morning|afternoon|evening)|right now)\b/i;

/** Day offset the goal asks about, or null when the goal is not time-relative. */
export function timeRelativeOffset(goal: string): number | null {
  if (!TIME_RELATIVE_RE.test(goal)) return null;
  if (/\byesterday\b/i.test(goal)) return -1;
  if (/\btomorrow\b/i.test(goal)) return 1;
  return 0;
}

/** The host-clock block the walk already binds into arg extraction and the producer pick (07-11),
 *  shared so every LLM step that reads it gets the same authoritative value. */
export function temporalGroundingBlock(now: Date = new Date()): string {
  const nowIso = now.toISOString();
  return `CURRENT DATE/TIME (authoritative, from the substrate host clock): ${nowIso} (today's date: ${nowIso.slice(0, 10)}). Any relative temporal reference in the goal — "today", "tonight", "yesterday", "this week", a daily-note date, a dated filename — MUST be computed from this value. NEVER guess or invent a date.\n\n`;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIndex = (m: string): number => MONTHS.findIndex((full) => full.startsWith(m.toLowerCase().slice(0, 3)));

export type Asserted = { text: string; year: number; month?: number; day?: number };

/** Parse the date at the head of `s` (after an anchor phrase). Granularity follows what is written. */
function parseDateAt(s: string): Asserted | null {
  const t = s.replace(/^(?:\s|,|:|-|the\s)+/i, "").replace(/^(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s+/i, "");
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { text: m[0], year: +m[1]!, month: +m[2]! - 1, day: +m[3]! };
  m = t.match(new RegExp(`^${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, "i"));
  if (m) return { text: m[0], year: +m[3]!, month: monthIndex(m[1]!), day: +m[2]! };
  m = t.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\.?,?\\s+(\\d{4})`, "i"));
  if (m) return { text: m[0], year: +m[3]!, month: monthIndex(m[2]!), day: +m[1]! };
  m = t.match(new RegExp(`^(?:early|mid|late)?-?\\s*${MON_RE}\\.?\\s+(\\d{4})`, "i"));
  if (m) return { text: m[0], year: +m[2]!, month: monthIndex(m[1]!) };
  m = t.match(/^(?:early|mid|late)?-?\s*(\d{4})\b(?!\s*(?:utc|gmt|z\b|hours?|hrs?|h\b|:))/i);
  if (m && +m[1]! >= 1990 && +m[1]! <= 2100) return { text: m[0], year: +m[1]! };
  return null;
}

/** Phrases by which a deliverable asserts the date it is reporting AS today's / the report's date.
 *  Not bare "date:" (a headline's "published date: …" is the item's date) and not a bare "as of"
 *  mid-text ("began as of June 2025", "as of September 30 the toll was 12" are facts' dates). */
const ANCHOR_RE = /\b(?:today is|today,|today:|(?:current|today'?s) date(?: is)?:?|report date:?|date of (?:this )?report:?|(?:news|headlines|stories|developments|events) (?:for|as of))\s*/gi;
/** "As of <date>" counts only as the deliverable's FRAME: at the very start of the answer (#51
 *  "As of mid-2024, the main developments are …"). */
const FRAME_AS_OF_RE = /^\s*(?:[#*>\-\s]*)as of\s*/i;

/** Split a `- <shape>: <content>` digest into per-shape segments; text before the first marker is
 *  kept as an unlabelled (deliverable) segment. */
export function digestSegments(digest: string): Array<{ shape: string | null; text: string }> {
  const out: Array<{ shape: string | null; text: string }> = [];
  const re = /^- ([A-Za-z0-9_:.\-]+): /gm;
  let last = 0; let shape: string | null = null; let m: RegExpExecArray | null;
  while ((m = re.exec(digest)) !== null) {
    if (m.index > last || shape !== null) out.push({ shape, text: digest.slice(last, m.index) });
    shape = m[1]!; last = m.index + m[0].length;
  }
  out.push({ shape, text: digest.slice(last) });
  return out.filter((s) => s.text.trim().length > 0);
}

/** Dates the DELIVERABLE asserts as today / the report date: labelled answer-bearing segments only.
 *  Evidence, intermediates and UNLABELLED text never count — the floor's digest is one unlabelled
 *  block that mixes the answer with tool outputs (search results carry their own dates), so the
 *  oracle abstains there rather than read a result's date as the answer's claim. */
export function assertedDates(digest: string): Asserted[] {
  const found: Asserted[] = [];
  for (const seg of digestSegments(digest)) {
    if (!seg.shape || !ANSWER_SHAPES.has(seg.shape)) continue;
    found.push(...assertedDatesInText(seg.text));
  }
  return found;
}

/** The current/report dates ONE answer text asserts (the per-segment body of `assertedDates`,
 *  shared with reach-grounding.ts, which picks its own answer texts). */
export function assertedDatesInText(segText: string): Asserted[] {
  const found: Asserted[] = [];
  // JSON-escaped content (a report inside {"content":"…"}) keeps its words; unescape newlines only.
  const text = segText.replace(/\\n/g, "\n");
  // A report inside a JSON envelope: read the frame from the start of its text.
  const body = text.replace(/^\s*\{[^"]*"(?:content|text|body)"\s*:\s*"/, "");
  const fm = body.match(FRAME_AS_OF_RE);
  if (fm) { const d = parseDateAt(body.slice(fm[0].length, fm[0].length + 60)); if (d) found.push(d); }
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(text)) !== null) {
    const d = parseDateAt(text.slice(m.index + m[0].length, m.index + m[0].length + 60));
    if (d) found.push(d);
  }
  return found;
}

/** Off the ±1-day window around `target`, at the granularity the deliverable wrote. Shared with the
 *  grounded-report oracle, which requires the opposite (every asserted date in the window). */
export function isStaleDate(d: Asserted, target: Date): boolean {
  // The ±1 day window, expressed at the granularity the deliverable wrote.
  const window = [-1, 0, 1].map((k) => new Date(target.getTime() + k * DAY_MS));
  if (d.day !== undefined && d.month !== undefined && d.month >= 0) {
    const asserted = Date.UTC(d.year, d.month, d.day);
    return !window.some((w) => Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) === asserted);
  }
  if (d.month !== undefined && d.month >= 0) return !window.some((w) => w.getUTCFullYear() === d.year && w.getUTCMonth() === d.month);
  return !window.some((w) => w.getUTCFullYear() === d.year);
}

/**
 * Oracle-chain entry: `reached:false` when a time-relative goal's deliverable asserts a "today" or
 * report date off the host clock (± 1 day, after the goal's offset); `null` (abstain) otherwise.
 */
export function verifyAssertedDate(goal: string, digest: string, now: Date = new Date()): DateVerdict | null {
  const offset = timeRelativeOffset(goal);
  if (offset === null || !digest) return null;
  const target = new Date(now.getTime() + offset * DAY_MS);
  const stale = assertedDates(digest).filter((d) => isStaleDate(d, target));
  if (stale.length === 0) return null;
  const clock = now.toISOString().slice(0, 10);
  const want = target.toISOString().slice(0, 10);
  return {
    reached: false,
    deterministic: true,
    completion_shapes: [],
    reason: `deterministic:stale-asserted-date — the deliverable asserts "${stale[0]!.text.trim()}" as the current/report date; the host clock reads ${clock}${offset !== 0 ? ` and the goal asks about ${want} (offset ${offset} day)` : ""}, so a time-relative goal is not answered by it (±1 day tolerance)`,
  };
}
