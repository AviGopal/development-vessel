/**
 * WHAT THE REACH JUDGE READS, AND WHAT COUNTS AS COMPLETION — chosen in code.
 *
 * MEASURED (output-shapes track 4, 61 end-of-walk verdicts on the current-events family): the walk
 * handed the judge every pool impulse in insertion order, each cut at 1,500 chars and the whole at
 * 8,000. The two grounded reports in the window (4,218 and 4,965 chars) were seen at ≤36% and ≤30%,
 * behind a 7,247-char `activity_template` catalogue and `error` rows, and were rejected as
 * "missing a coherent report format" / "overly generic". The judge also chose `completion_shapes`
 * itself: `activity_template` in 14/61 verdicts, `error` in 5/61 — and that choice fed POST /reach,
 * recordGoalPath and capability-gap filing (850 capability rows over 850 invented names).
 *
 * So the view is built here, once, for both walk call sites (the interim check and the end of the
 * walk, which had drifted apart):
 *   1. the DELIVERABLE first, at full length (terminal shapes + the answer-bearing shapes);
 *   2. the EVIDENCE as one `title — url` line per result (deduplicated), not 1,500-char JSON;
 *   3. everything else under the existing per-shape cap, with bookkeeping shapes and provenance
 *      stubs excluded and identical-content entries folded.
 * Every cut is recorded. A deliverable that does not fit is an ABSTAIN (REALIGNMENT §9.2): the judge
 * is not asked to grade a view that does not contain the thing it grades.
 *
 * FULL VIEW OR ABSTAIN (reach condition 5). The end-of-walk view also carries the WHOLE deliverable
 * when it was cut but is whole in hand (`full`), so the gate can read it in ordered parts
 * (`judgeViewParts`) instead of abstaining. A deliverable clipped before it reached the view is not
 * whole in hand: it has no `full`, and stays an abstain.
 */
import { EVIDENCE_SHAPES, ANSWER_SHAPES } from "./reach-date";

/** Bookkeeping shapes: never the deliverable, never evidence, never a completion state. */
export const JUDGE_EXCLUDED_SHAPES: ReadonlySet<string> = new Set([
  "goal", "dispatch_id", "activity_template", "error", "filePaths", "test_suite",
]);

export const PER_SHAPE_CAP = 1500;
export const REST_CAP = 8000;
/** The deliverable's own budget. Above it the view is cut and the verdict abstains. */
export const DELIVERABLE_CAP = 24000;
export const EVIDENCE_LINES_CAP = 40;
/** Chars each part of a full read repeats from the end of the previous part, so a refutation that straddles a part
 *  boundary is read whole in one of them. */
export const PART_OVERLAP = 1000;

/** `produced`: the entry's full rendered length when it was clipped BEFORE reaching the view (the
 *  emit-time capture below). The view records that clip as a cut, so no bound is invisible. */
export interface PoolEntry { shape: string; content: unknown; produced?: number }
export interface JudgeCut { shape: string; shown: number; produced: number }
/** `deliverableShapes`: the shapes the view rendered AS the deliverable — what the judge graded. The walk reads it
 *  to find which step produced the judged artifact (walk-pool.ts judgedArtifactProducers). */
export interface JudgeView {
  digest: string; cuts: JudgeCut[]; deliverableCut: boolean; deliverableShapes: string[];
  /** Asked for (`opts.full`) and the deliverable was cut but is whole in hand: every deliverable entry uncut, and the
   *  same evidence/rest tail the digest carries. Absent otherwise. */
  full?: { deliverable: string; tail: string };
  /** A deliverable entry was clipped BEFORE the view (the emit-time capture bound): it cannot be read in full here. */
  deliverablePreClipped: boolean;
}

/** `{producedBy, executionId}` placeholders a nested template step leaves for outputs the walk store
 *  could not recover: a shape name with no content, which the judge reads as a hollow artefact. */
export function isProvenanceStub(c: unknown): boolean {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const keys = Object.keys(c as Record<string, unknown>);
  return keys.length > 0 && keys.every((k) => k === "producedBy" || k === "executionId");
}

/** The text a judge should read for one impulse: stdout for an executor result (the end-of-walk
 *  fix of 2026-08-27, now shared with the interim site), the string itself, else compact JSON. */
export function renderContent(c: unknown): string {
  if (c && typeof c === "object" && !Array.isArray(c) && typeof (c as { stdout?: unknown }).stdout === "string") {
    return String((c as { stdout: string }).stdout).trim();
  }
  if (typeof c === "string") return c;
  try { const s = JSON.stringify(c); return s === undefined ? "" : s; } catch { return String(c); }
}

/** The emit-time capture (index.ts captureReachDigest): a nested step's outputs snapshotted before
 *  the engine evicts them, as POOL ENTRIES for this view rather than a second digest appended after
 *  it. The walk used to join a 600-per-shape / 4,000-total string onto the view, outside the budget
 *  and the cut record (gap slice-v-judge-digest-outside-cut-accounting…). Each entry is bounded at
 *  the deliverable budget and the bound is carried as `produced`, so the view records it as a cut. */
export function capturedPoolEntries(impulses: ReadonlyArray<{ shape?: string; content?: unknown }>, cap: number = DELIVERABLE_CAP): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const imp of impulses) {
    if (imp.content === undefined || imp.content === null) continue;
    const shape = imp.shape ?? "?";
    const text = renderContent(imp.content);
    if (text.length > cap) out.push({ shape, content: text.slice(0, cap), produced: text.length });
    else out.push({ shape, content: imp.content });
  }
  return out;
}

/** Unwrap a resolver envelope (`{resolved, content: "…"}` / `{body:{content}}`) so the deliverable
 *  is read as text, not as escaped JSON. Shared with the grounded-report oracle. */
export function deliverableText(c: unknown): string {
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const o = c as Record<string, unknown>;
    for (const k of ["content", "text", "body", "completion", "answer"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v;
      if (v && typeof v === "object" && typeof (v as { content?: unknown }).content === "string") return (v as { content: string }).content;
    }
  }
  return renderContent(c);
}

/** `title — url` for every result object found in a search/fetch payload. */
export function evidenceLines(c: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (depth > 6 || x === null || x === undefined) return;
    if (typeof x === "string") {
      if (depth === 0) { try { walk(JSON.parse(x), depth + 1); } catch { /* plain text: no structured results */ } }
      return;
    }
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : typeof o.link === "string" ? o.link : typeof o.href === "string" ? o.href : null;
      if (url && /^https?:\/\//.test(url)) {
        const title = typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : "";
        out.push(`${title.replace(/\s+/g, " ").trim().slice(0, 200)} — ${url}`);
        return;
      }
      for (const v of Object.values(o)) walk(v, depth + 1);
    }
  };
  walk(c, 0);
  return out;
}

/** `targets`: the walk's target shapes. A shape the goal TARGETS is never bookkeeping — `test_suite`
 *  for "run the test suite", `activity_template` for "draft a template" — so the exclusion list
 *  yields to it and it is read as the deliverable (qa: terminal/deliverable shapes win). Any target,
 *  not only an excluded-named one: a targeted report that is not also terminal was read as `rest` and
 *  clipped at PER_SHAPE_CAP, and that cut never set `deliverableCut`, so the judge graded a report
 *  it saw a third of and nothing abstained. As a deliverable it gets the deliverable budget, and a
 *  cut of it is a deliverable cut. It is rendered as-is (not envelope-unwrapped), so the oracles that
 *  parse a target's structure from the digest still can. */
/** `opts.full`: also return the whole deliverable when it is cut (only the end-of-walk site asks: the interim check runs
 *  on every progressed step, so it abstains on a cut and leaves the full read to the end). */
export function buildJudgeView(pool: PoolEntry[], deliverableShapes: ReadonlySet<string>, targets: ReadonlySet<string> = new Set(), opts: { full?: boolean } = {}): JudgeView {
  const wanted = (s: string) => deliverableShapes.has(s) || targets.has(s);
  const isDeliverable = (s: string) => deliverableShapes.has(s) || ANSWER_SHAPES.has(s) || targets.has(s);
  const cuts: JudgeCut[] = [];
  const seenContent = new Set<string>();
  const deliverable: string[] = [];
  const rendered: string[] = [];
  const evidence: string[] = [];
  const seenUrls = new Set<string>();
  const rest: string[] = [];
  let deliverableCut = false;
  let deliverablePreClipped = false;
  let deliverableBudget = DELIVERABLE_CAP;
  const deliverableWhole: string[] = [];
  const wholeKeys = new Map<string, string[]>();
  for (const { shape, content, produced } of pool) {
    if (!shape || (JUDGE_EXCLUDED_SHAPES.has(shape) && !wanted(shape)) || isProvenanceStub(content)) continue;
    const key = renderContent(content);
    if (!key.trim() || seenContent.has(key)) continue; // identical content under two shape names
    seenContent.add(key);
    // Clipped before it reached the view (the emit-time capture bound): a recorded cut, never a silent one.
    const preClipped = typeof produced === "number" && produced > key.length;
    const full = preClipped ? produced! : key.length;
    if (isDeliverable(shape)) {
      // A capture-clipped copy of an entry already held WHOLE (the pool's copy of the same output) is that entry
      // again, not a second deliverable: it would spend budget and mark the view cut over content the view has.
      if (preClipped && (wholeKeys.get(shape) ?? []).some((k) => k.startsWith(key))) continue;
      // A shape that is a deliverable ONLY because the goal targets it keeps its structure: unwrapping
      // `{path, content}` to bare text erased the `path` the verbatim-read oracle identifies the read by.
      const text = deliverableShapes.has(shape) || ANSWER_SHAPES.has(shape) ? deliverableText(content) : key;
      const shown = text.slice(0, Math.max(0, deliverableBudget));
      if (shown.length < text.length) { deliverableCut = true; cuts.push({ shape, shown: shown.length, produced: text.length }); }
      else if (preClipped) { deliverableCut = true; cuts.push({ shape, shown: shown.length, produced: produced! }); }
      if (preClipped) deliverablePreClipped = true;
      else wholeKeys.set(shape, [...(wholeKeys.get(shape) ?? []), key]);
      deliverableBudget -= shown.length;
      deliverableWhole.push(`- ${shape}: ${text}`);
      deliverable.push(`- ${shape}: ${shown}`);
      if (!rendered.includes(shape)) rendered.push(shape);
    } else if (EVIDENCE_SHAPES.has(shape)) {
      const lines = evidenceLines(content).filter((l) => { const u = l.slice(l.lastIndexOf(" — ") + 3); if (seenUrls.has(u)) return false; seenUrls.add(u); return true; });
      if (lines.length > 0) {
        if (lines.length > EVIDENCE_LINES_CAP) cuts.push({ shape, shown: EVIDENCE_LINES_CAP, produced: lines.length });
        for (const l of lines.slice(0, EVIDENCE_LINES_CAP)) evidence.push(`- ${shape}: ${l}`);
      } else {
        if (full > PER_SHAPE_CAP || preClipped) cuts.push({ shape, shown: Math.min(PER_SHAPE_CAP, key.length), produced: full });
        evidence.push(`- ${shape}: ${key.slice(0, PER_SHAPE_CAP)}`);
      }
    } else {
      if (full > PER_SHAPE_CAP || preClipped) cuts.push({ shape, shown: Math.min(PER_SHAPE_CAP, key.length), produced: full });
      rest.push(`- ${shape}: ${key.slice(0, PER_SHAPE_CAP)}`);
    }
  }
  // NOTHING BUT BOOKKEEPING: show it rather than an empty view, so the gate's deterministic
  // pre-checks (the all-error-envelope verdict) still see an error-only pool for what it is.
  if (deliverable.length === 0 && evidence.length === 0 && rest.length === 0) {
    for (const { shape, content } of pool) {
      if (!shape || shape === "goal" || shape === "dispatch_id" || isProvenanceStub(content)) continue;
      const key = renderContent(content);
      if (key.trim()) rest.push(`- ${shape}: ${key.slice(0, PER_SHAPE_CAP)}`);
    }
  }
  const tail = [...evidence, ...rest].join("\n");
  if (tail.length > REST_CAP) cuts.push({ shape: "*", shown: REST_CAP, produced: tail.length });
  const digest = [deliverable.join("\n"), tail.slice(0, REST_CAP)].filter(Boolean).join("\n");
  const full = opts.full && deliverableCut && !deliverablePreClipped ? { deliverable: deliverableWhole.join("\n"), tail: tail.slice(0, REST_CAP) } : undefined;
  return { digest, cuts, deliverableCut, deliverableShapes: rendered, ...(full ? { full } : {}), deliverablePreClipped };
}

/** One ordered part of a full read: chars [from, to) of the whole deliverable (`total` chars), as the judge reads it. */
export interface JudgeViewPart { k: number; n: number; from: number; to: number; total: number; digest: string }

/** The whole deliverable as ordered parts, each at most `cap` chars of it (the view's own deliverable budget) and each
 *  overlapping the previous by PART_OVERLAP, every part followed by the same evidence/rest tail. Deterministic: the
 *  same deliverable always splits the same way. null when it needs more than `maxParts` parts — it cannot be read in
 *  full within the budget, so the verdict stays an abstain. */
export function judgeViewParts(full: { deliverable: string; tail: string }, cap: number = DELIVERABLE_CAP, maxParts: number = Infinity): JudgeViewPart[] | null {
  const text = full.deliverable;
  const step = Math.max(1, cap - PART_OVERLAP);
  const n = text.length <= cap ? 1 : 1 + Math.ceil((text.length - cap) / step);
  if (n > maxParts) return null;
  const parts: JudgeViewPart[] = [];
  for (let k = 0; k < n; k++) {
    const from = k * step;
    const to = Math.min(text.length, from + cap);
    parts.push({ k: k + 1, n, from, to, total: text.length, digest: [text.slice(from, to), full.tail].filter(Boolean).join("\n") });
  }
  return parts;
}

/** The judge's `completion_shapes`, restricted in code before /reach, recordGoalPath and gap filing
 *  read them: produced shapes only, bookkeeping excluded unless the goal's deliverables name it.
 *  Deterministic oracles choose theirs in code already and are left as they are. */
export function restrictCompletionShapes(declared: readonly string[] | undefined, produced: ReadonlySet<string>, deterministic: boolean, deliverables: ReadonlySet<string> = new Set()): string[] {
  const d = (declared ?? []).map(String);
  if (deterministic) return d;
  return [...new Set(d.filter((s) => produced.has(s) && (!JUDGE_EXCLUDED_SHAPES.has(s) || deliverables.has(s))))];
}
