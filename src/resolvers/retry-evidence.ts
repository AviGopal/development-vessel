/**
 * RETRY EVIDENCE: what a failed compose attempt leaves on its gap, and the constraints the next
 * attempt is held to (intervention 2, 2026-09-30).
 *
 * The carrier is the gap's existing `classification_metadata.failure_lessons` (no new store, no new
 * shape). Each failed attempt's lesson entry gains structured fields beside its prose:
 *   - `edited_spans`: the BASE-file regions the draft changed ({path, start, end, text_sha, base});
 *   - `own_check.failing`: the gap's OWN check (its test file run alone) as {name, expected, received},
 *     never the full-suite log, whose first (fail) may belong to another gap's check;
 *   - `stage`: where the draft failed (install / resolve / typecheck / shape-dispatch / tests / own_check /
 *     scope), from the verify run's own markers;
 *   - `no_effect_vs_parent`: the own check failed IDENTICALLY on the untouched parent, so the edited
 *     regions are demonstrably not on the path the check exercises.
 *
 * Measured on gap-drain-redispatches (09-30, node 2): 9 drafts, 7 different sites, none at the defect,
 * because each retry was told test NAMES, a lesson from another gap's test, and a class from a regex that
 * matched a PASSING test's name. Prose advice was tried before and ignored ("a unique anchor supplied is
 * not a unique anchor used"), so the record is enforced, not advised: an edit overlapping a no-effect
 * span is refused before it is written (noEffectOverlapRefusal), and the failing Expected/Received lines
 * are placed in the prompt as data (attemptEvidenceBlock).
 *
 * A second constraint rides the same record: `constraints` (must_be_called), imposed when the semantic gate rejects a
 * symbol the draft introduced as uncalled, enforced before the next draft's verify (checkMustBeCalled), lifted by a
 * later `constraints_lifted` entry, and escalated once per symbol on a repeat refusal (see the section at the end).
 *
 * Readers: feature-compose (writer, enforcer, prompt), gap-to-feature (decomposer prompt, grounding line
 * hint), self_fact_reconcile's retry_evidence instrument (the standing measurement).
 */
import { createHash } from "node:crypto";

export type FailStage = "install" | "resolve" | "typecheck" | "shape-dispatch" | "tests" | "own_check" | "scope" | "apply" | "constraint" | "decompose";

export interface EditedSpan {
  path: string;
  /** 1-based inclusive line range in the BASE file (the file as it was before this attempt edited it). */
  start: number;
  end: number;
  /** sha256/16 of the base lines start..end, so the region can be found again after the file moves. */
  text_sha: string;
  /** sha256/16 of the whole base file. */
  base: string;
  /** The span's text occurred exactly once in the base: only then may a lock follow it to a new position. */
  unique?: boolean;
}

export interface OwnCheckFailure {
  name: string;
  error?: string;
  expected?: string;
  received?: string;
  /** Object-diff body (bun's "- expected / + received" lines) when the matcher prints one. */
  diff?: string;
}

export interface AttemptRecord {
  stage: FailStage | null;
  edited_spans: EditedSpan[];
  own_check?: { test_file: string; failing: OwnCheckFailure[] };
  /** true: the check failed identically on the parent. false: it differed. absent: not measured. */
  no_effect_vs_parent?: boolean;
  base_sha?: string;
  /** Whether the parent-tree run of the own check came from the per-(gap, vessel, sha, check) cache. */
  parent_cached?: "hit" | "miss";
  /** Every op this attempt had refused by the no-effect constraint. */
  refusals?: RefusalRecord[];
  /** Set when a refusal repeated on a region already refused on this gap: what the escalation did. */
  escalation?: { at: string; region: string; outcome: string };
  /** Structural constraints the NEXT attempt of this gap (and its lineage) is held to (see checkMustBeCalled). */
  constraints?: MustBeCalledConstraint[];
  /** Constraints this attempt showed to be met or moot; a lift cancels every earlier record of that symbol. */
  constraints_lifted?: ConstraintLift[];
  /** Edit ops the file-scope gate dropped as off-target, and why (a drop is recorded, never silent). */
  dropped_paths?: string[];
  dropped_reason?: string;
}

/**
 * One refused op: where it tried to edit and the locked region (by its text) it hit. A `must_be_called` refusal
 * reuses the record (and so the once-per-region escalation): region_sha is "must_be_called:<symbol>", path is
 * where the symbol was introduced, and the line fields are 0.
 */
export interface RefusalRecord { path: string; start: number; end: number; region_sha: string; region_start: number; region_end: number; kind?: "must_be_called" }

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ─── verify-log stages ──────────────────────────────────────────────────────

/**
 * The typecheck section of a compose verify log ("== typecheck ==" up to the next "== x ==" header), or ""
 * when the typecheck passed (TC_EXIT=0) or the log has no such section. A TS code is evidence of a
 * typecheck failure ONLY here: the tests section prints test NAMES, and a passing test named
 * "…TS2304 baseline stays delta-excused" classed a behaviour failure typecheck_dangling_reference.
 */
export function typecheckSection(raw: string): string {
  const m = /== typecheck ==\n([\s\S]*?)(?=\n== [a-z-]+ ==|$)/.exec(raw);
  if (!m) return "";
  const sec = m[1] ?? "";
  const exit = /TC_EXIT=(\d+)/.exec(sec);
  if (exit && exit[1] === "0") return "";
  return sec;
}

/** The first stage whose marker says it failed, from a compose verify log. */
export function failingStageOfLog(raw: string): FailStage | null {
  const num = (k: string): number | null => { const m = new RegExp(`${k}=(\\d+)`).exec(raw); return m ? Number(m[1]) : null; };
  const inst = num("INSTALL_EXIT"); if (inst !== null && inst !== 0) return "install";
  const dry = num("DRYRUN_EXIT"); if (dry !== null && dry !== 0) return "resolve";
  const tc = num("TC_EXIT");
  if ((tc !== null && tc !== 0) || (tc === null && /== typecheck ==/.test(raw))) return "typecheck";
  const sd = num("SD_EXIT"); if (sd !== null && sd !== 0) return "shape-dispatch";
  return null;
}

/** Classes that assert a typecheck failure; a lesson carrying one must come from the typecheck stage. */
export const TYPECHECK_CLASSES = new Set(["syntax_break", "typecheck_dangling_reference"]);

/** Does a lesson's class agree with the stage its attempt failed at? Unknown stage: not judged (null). */
export function lessonClassMatchesStage(cls: string, stage: FailStage | null | undefined): boolean | null {
  if (!stage) return null;
  if (TYPECHECK_CLASSES.has(cls)) return stage === "typecheck";
  if (stage === "typecheck") return cls === "verify_failed" || /^env_/.test(cls);
  // A scope withhold applied and verified cleanly: the classifier's semantic_reject fallthrough is the known mislabel.
  if (stage === "scope") return cls === "scope_refused" || cls === "no_effect_all_dropped" || cls === "env_policy_unreadable";
  if (stage === "constraint") return cls === "constraint_unmet" || /^env_/.test(cls);
  return true;
}

// ─── the own check ──────────────────────────────────────────────────────────

/**
 * The failing tests of ONE test file's run (the gap's own check), each with the Expected/Received lines
 * bun printed for it. Bun prints a failure's error block BEFORE its "(fail) name" line, so each block is
 * the text since the previous (pass)/(fail) line. `only` restricts to the gap's named tests (substring,
 * as ownCheckStillRed matches them).
 */
export function parseOwnCheckFailures(raw: string, only: string[] = []): OwnCheckFailure[] {
  const out: OwnCheckFailure[] = [];
  let block: string[] = [];
  const cap = (s: string, n = 300): string => (s.length > n ? s.slice(0, n) + "…" : s);
  for (const line of raw.split("\n")) {
    if (/^\s*\(pass\)/.test(line) || /^\s*\(skip\)/.test(line) || /^\s*\(todo\)/.test(line)) { block = []; continue; }
    const f = /^\s*\(fail\)\s*(.*?)\s*(?:\[[\d.]+m?s\])?\s*$/.exec(line);
    if (!f) { block.push(line); continue; }
    const name = f[1] ?? "";
    if (only.length === 0 || only.some((n) => name.includes(n))) {
      const rec: OwnCheckFailure = { name };
      const err = block.find((l) => /^\s*error:/.test(l));
      if (err) rec.error = cap(err.trim());
      const exp = block.filter((l) => /^\s*Expected\b[^:]*:/.test(l)).map((l) => l.trim());
      const rcv = block.filter((l) => /^\s*Received\b[^:]*:/.test(l)).map((l) => l.trim());
      if (exp.length) rec.expected = cap(exp.join(" | "));
      if (rcv.length) rec.received = cap(rcv.join(" | "));
      const diff = block.filter((l) => /^\s*[-+]\s{1,3}\S/.test(l) && !/^\s*[-+]\s+(Expected|Received)\s+[-+]/.test(l)).map((l) => l.trimEnd());
      if (diff.length) rec.diff = cap(diff.join("\n"), 600);
      out.push(rec);
    }
    block = [];
  }
  return out;
}

/** Same failing tests with the same Expected/Received: the draft changed nothing the check can see. */
export function sameOwnCheckFailures(a: OwnCheckFailure[], b: OwnCheckFailure[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const key = (f: OwnCheckFailure): string => JSON.stringify([f.name, f.expected ?? "", f.received ?? "", f.diff ?? "", f.error ?? ""]);
  const sa = a.map(key).sort(), sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

// ─── spans ──────────────────────────────────────────────────────────────────

/** The BASE-file line range an edit op covers, computed the same way for recording and for refusing. */
export function baseSpanOfOp(base: string, op: { kind?: string; old_string?: string; start_line?: number; end_line?: number; expect_first_line?: string }): { start: number; end: number } | null {
  if (op.kind === "replace_lines") {
    const s = Number(op.start_line), e = Number(op.end_line);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) return null;
    return { start: s, end: e };
  }
  const old = op.old_string ?? "";
  if (!old) return null;
  const at = base.indexOf(old);
  if (at < 0) return null;
  const start = base.slice(0, at).split("\n").length;
  return { start, end: start + (old.match(/\n/g)?.length ?? 0) };
}

export function spanRecord(path: string, base: string, start: number, end: number): EditedSpan {
  const lines = base.split("\n");
  const text = lines.slice(start - 1, end).join("\n");
  const first = text ? base.indexOf(text) : -1;
  const unique = first >= 0 && base.indexOf(text, first + 1) < 0;
  return { path: normPath(path), start, end, text_sha: sha16(text), base: sha16(base), unique };
}

const normPath = (p: string): string => p.replace(/:\d+.*$/, "").replace(/^\/+/, "").trim();

/**
 * Where a recorded lock sits in `base` now, or null when it has LIFTED. A lock is scoped to its region's TEXT
 * (text_sha): the same lines when the base is unchanged or those lines still hold that text; otherwise the one
 * place the text moved to, but only when it was unique when recorded (a copy of edited text elsewhere must not
 * inherit the lock). A commit that edits the region changes its text and lifts the lock.
 */
export function locateSpan(span: EditedSpan, base: string): { start: number; end: number } | null {
  if (span.base === sha16(base)) return { start: span.start, end: span.end };
  const lines = base.split("\n");
  const len = span.end - span.start + 1;
  if (len < 1 || len > 400) return null;
  if (sha16(lines.slice(span.start - 1, span.end).join("\n")) === span.text_sha) return { start: span.start, end: span.end };
  if (span.unique !== true) return null;
  let hit: number | null = null;
  for (let i = 0; i + len <= lines.length; i++) {
    if (sha16(lines.slice(i, i + len).join("\n")) !== span.text_sha) continue;
    if (hit !== null) return null;
    hit = i + 1;
  }
  return hit === null ? null : { start: hit, end: hit + len - 1 };
}

/** The no-effect spans recorded on a gap's failure_lessons (records with no_effect_vs_parent === true). */
export function noEffectSpans(lessons: unknown): EditedSpan[] {
  if (!Array.isArray(lessons)) return [];
  const out: EditedSpan[] = [];
  for (const l of lessons as Array<Record<string, unknown>>) {
    if (!l || l.no_effect_vs_parent !== true || !Array.isArray(l.edited_spans)) continue;
    for (const s of l.edited_spans as EditedSpan[]) if (s && typeof s.path === "string" && Number.isInteger(s.start) && Number.isInteger(s.end)) out.push(s);
  }
  return out;
}

/**
 * THE CONSTRAINT: an edit whose base span overlaps a region a prior attempt edited with NO EFFECT on the
 * gap's own check is refused before it is written. Returns the refusal reason (sent back to the drafter as
 * the op's failure detail), or null when the op may proceed.
 */
export function noEffectOverlapRefusal(path: string, base: string, span: { start: number; end: number } | null, lessons: unknown): string | null {
  return noEffectOverlap(path, base, span, lessons)?.detail ?? null;
}

/** The refusal with the locked region it hit (for the refusal record), or null. */
export function noEffectOverlap(path: string, base: string, span: { start: number; end: number } | null, lessons: unknown): (RefusalRecord & { detail: string }) | null {
  if (!span) return null;
  const p = normPath(path);
  for (const s of noEffectSpans(lessons)) {
    if (normPath(s.path) !== p) continue;
    const at = locateSpan(s, base);
    if (!at) continue;
    if (span.start <= at.end && at.start <= span.end) {
      return { path: p, start: span.start, end: span.end, region_sha: s.text_sha, region_start: at.start, region_end: at.end, detail: `NO-EFFECT REGION REFUSED: this edit covers ${p}:${span.start}-${span.end}, which overlaps ${p}:${at.start}-${at.end}. A prior attempt on this gap edited that region and the gap's own check failed IDENTICALLY with and without the edit, so the region is not on the path the check exercises. Edit a different region: the one the failing Expected/Received lines point at.` };
    }
  }
  return null;
}

/**
 * THE ONE PER-OP GATE. Every write site in feature_compose that applies an edit (the op applier's top, the
 * re-derived anchor, both fc-repair writes) calls this with the op it is about to write and the base file, and
 * must not write when it returns a refusal. The retry_evidence row counts these call sites at origin/dev.
 */
export function checkOpNoEffect(
  op: { path: string; kind?: string; old_string?: string; start_line?: number; end_line?: number },
  base: string,
  lessons: unknown,
): (RefusalRecord & { detail: string }) | null {
  return noEffectOverlap(op.path, base, baseSpanOfOp(base, op), lessons);
}

/** The refusal records carried by a gap's lessons (refusal lessons and attempts that recorded refusals). */
export function priorRefusals(lessons: unknown): RefusalRecord[] {
  if (!Array.isArray(lessons)) return [];
  return (lessons as Array<Record<string, unknown>>).flatMap((l) => (l && Array.isArray(l.refusals) ? (l.refusals as RefusalRecord[]) : []));
}

/**
 * A refusal REPEATED on one region of one gap: the lock held and the drafter came back to it. That is the
 * trigger to escalate (decompose / investigate), never to keep retrying silently. Returns the region's text sha.
 */
export function repeatedRefusalRegion(priorLessons: unknown, current: ReadonlyArray<RefusalRecord>): string | null {
  const counts = new Map<string, number>();
  for (const r of [...priorRefusals(priorLessons), ...current]) counts.set(r.region_sha, (counts.get(r.region_sha) ?? 0) + 1);
  for (const r of current) if ((counts.get(r.region_sha) ?? 0) >= 2) return r.region_sha;
  return null;
}

/**
 * On a refusal that repeats on a region of this gap: escalate through the lane's existing decompose/investigate
 * path (`escalate`, gap-to-feature's escalateToDecomposition) and journal it. Returns the escalation record to
 * store on the refusal lesson, or undefined when nothing repeated. Never a silent retry loop.
 */
export async function escalateRepeatedRefusal(
  gap: Record<string, unknown> | null,
  ownLessons: unknown,
  refusals: ReadonlyArray<RefusalRecord>,
  escalate: (gap: Record<string, unknown>, why: string) => Promise<string>,
): Promise<AttemptRecord["escalation"]> {
  const region = repeatedRefusalRegion(ownLessons, refusals);
  if (!region) return undefined;
  // ONCE PER REGION: a region already escalated on this gap is not escalated again; the refusal is still recorded.
  const already = Array.isArray(ownLessons) && (ownLessons as Array<Record<string, unknown>>).some((l) => (l?.escalation as { region?: unknown } | undefined)?.region === region);
  if (already) {
    console.log(`[fc-no-effect] region ${region} on gap ${String(gap?.id ?? "?")} was already escalated; not escalated again`);
    return undefined;
  }
  const gid = String(gap?.id ?? "");
  let outcome: string;
  if (!gap || !gid) outcome = "not dispatched: the gap row could not be read";
  else {
    try { outcome = await escalate(gap, `no-effect region ${region} refused again`); }
    catch (err) { outcome = "not dispatched: " + String(err).slice(0, 200); }
  }
  console.warn(`[fc-no-effect] ESCALATION gap=${gid || "?"} region=${region}: refused on this gap before and again now; ${outcome}`);
  return { at: new Date().toISOString(), region, outcome };
}

// ─── the refusal journal line (one format, written by compose, counted by the row) ──
/** The journal line feature_compose writes for each refusal. */
export function refusalJournalLine(site: string, gapId: string, detail: string): string {
  return `[fc-no-effect] ${site} gap=${gapId || "none"}: ${detail}`;
}
/** Server-side journalctl --grep for those lines (has an upper-case letter, so journalctl matches case-sensitively). */
export const REFUSAL_JOURNAL_GREP = "^\\[fc-no-effect\\] [a-z -]+ gap=[^ ]+: NO-EFFECT REGION REFUSED";
/** Refusal journal lines per gap id. */
export function refusalJournalCounts(lines: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const m = /^\[fc-no-effect\] [a-z -]+ gap=([^ ]+): NO-EFFECT REGION REFUSED/.exec(l);
    if (m && m[1] && m[1] !== "none") out.set(m[1], (out.get(m[1]) ?? 0) + 1);
  }
  return out;
}
/**
 * Stored refusals per gap with lessons written at or after `sinceMs`, and whether the gap's lesson list is full
 * (8): a full list may have evicted refusal lessons, so it cannot be judged against the journal.
 */
export function storedRefusalCounts(rows: Array<Record<string, unknown>>, sinceMs: number): Map<string, { n: number; saturated: boolean }> {
  const out = new Map<string, { n: number; saturated: boolean }>();
  for (const row of rows) {
    const lessons = ((row.classification_metadata as Record<string, unknown> | undefined)?.failure_lessons ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(lessons)) continue;
    // Only no-effect refusals have journal lines to be reconciled against; a constraint refusal is journaled apart.
    const n = priorRefusals(lessons.filter((l) => Date.parse(String(l?.at ?? "")) >= sinceMs)).filter((r) => r.kind !== "must_be_called").length;
    out.set(String(row.id), { n, saturated: lessons.length >= 8 });
  }
  return out;
}
/** Gaps whose journal shows more refusals than their (unsaturated) lessons store: refusals not recorded. */
export function refusalsNotRecorded(journalCounts: Map<string, number>, stored: Map<string, { n: number; saturated: boolean }>): { gaps: string[]; unjudged: number } {
  const gaps: string[] = [];
  let unjudged = 0;
  for (const [gap, j] of journalCounts) {
    const st = stored.get(gap);
    if (st?.saturated) { unjudged++; continue; }
    if (j > (st?.n ?? 0)) gaps.push(gap);
  }
  return { gaps, unjudged };
}

/**
 * The gate's call sites in a source text: every `const X = … checkOpNoEffect(` whose X is then used as a control
 * condition (`if (X` / `X ?`) within the next 6 lines. A call whose result is not branched on enforces nothing.
 */
export function gateCallSites(src: string, fn = "checkOpNoEffect"): { calls: number; consumed: number; unconsumed_lines: number[] } {
  const lines = src.split("\n");
  let calls = 0, consumed = 0;
  const unconsumed_lines: number[] = [];
  const callRe = new RegExp(`\\b${fn}\\(`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (!callRe.test(l) || /^\s*(\/\/|\*|import\b|export function)/.test(l)) continue;
    calls++;
    const m = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/.exec(l.slice(0, l.search(callRe)));
    const v = m?.[1];
    const window = lines.slice(i + 1, i + 7).join("\n");
    if (v && new RegExp(`\\bif\\s*\\(\\s*${v}\\b|\\b${v}\\s*\\?(?![?.])`).test(window)) consumed++;
    else unconsumed_lines.push(i + 1);
  }
  return { calls, consumed, unconsumed_lines };
}

// ─── grounding ──────────────────────────────────────────────────────────────

/** An explicit "~l.NNN" or "~l.NNN-MMM" in gap text: the author's statement of where the defect is. */
export function explicitLineHint(text: string): { start: number; end: number } | null {
  const m = /~\s*l\.?\s*(\d{1,6})(?:\s*[-–]\s*(\d{1,6}))?/i.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!(start >= 1) || end < start) return null;
  return { start, end };
}

// ─── test titles ────────────────────────────────────────────────────────────

const TEMPLATE_LITERAL_RE = /`((?:[^`\\]|\\[\s\S])*)`/g;
const PLACEHOLDER_RE = /\$\{[^}]*\}/;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where in a test file's source the title segment `segment` (one " > " part of a run name) is written, or -1.
 * A literal occurrence wins. Otherwise a template literal whose placeholders, read as wildcards, produce
 * the WHOLE segment (anchored): titles built in a loop (`[${label}] picks a producer`) never appear verbatim,
 * and bun has no list mode that would enumerate run names without running the file. A template that is
 * nothing but placeholders (`${name}`) would admit any title, so it never matches.
 */
export function testTitleSegmentOffset(src: string, segment: string): number {
  const seg = segment.trim();
  if (!seg) return 0;
  const at = src.indexOf(seg);
  if (at >= 0) return at;
  for (const m of src.matchAll(TEMPLATE_LITERAL_RE)) {
    const body = (m[1] ?? "").trim();
    if (!PLACEHOLDER_RE.test(body)) continue;
    const parts = body.split(new RegExp(PLACEHOLDER_RE.source, "g"));
    if (parts.join("").trim().length === 0) continue;
    if (new RegExp(`^${parts.map(escapeRegExp).join("[\\s\\S]*?")}$`).test(seg)) return m.index ?? 0;
  }
  return -1;
}

/** Does every " > " segment of the run name `title` occur in the test source (literally or as a template)? */
export function testTitleInSource(src: string, title: string): boolean {
  return title.split(" > ").every((seg) => testTitleSegmentOffset(src, seg) >= 0);
}

/** A window of at most `window` chars that covers lines start..end (from start when the range is larger). */
export function lineCenteredSlice(content: string, start: number, end: number, window: number): { slice: string; startLine: number } | null {
  const lines = content.split("\n");
  if (start < 1 || start > lines.length) return null;
  const last = Math.min(end, lines.length);
  const offsetOf = (line: number): number => { let o = 0; for (let i = 0; i < line - 1; i++) o += (lines[i] ?? "").length + 1; return o; };
  const a = offsetOf(start), b = offsetOf(last + 1);
  const pad = Math.max(0, Math.floor((window - (b - a)) / 2));
  let from = Math.max(0, a - pad);
  if (b - a >= window) from = a;
  // Start on a line boundary so the numbered window reads whole lines.
  const nl = content.lastIndexOf("\n", from - 1);
  from = from === 0 ? 0 : nl + 1;
  const slice = content.slice(from, from + window);
  return { slice, startLine: content.slice(0, from).split("\n").length };
}

// ─── the prompt block (data, not advice) ────────────────────────────────────

/**
 * The fixed PRIOR ATTEMPT RECORD block: per structured attempt, where it failed, what it edited, whether
 * that edit had any effect on the gap's own check, and the check's failing Expected/Received lines,
 * verbatim. Empty when no lesson carries structured fields.
 */
export function attemptEvidenceBlock(lessons: unknown, max = 3): string {
  if (!Array.isArray(lessons)) return "";
  const recs = (lessons as Array<Record<string, unknown>>).filter((l) => l && (Array.isArray(l.edited_spans) || l.own_check || l.stage)).slice(-max);
  const active = activeMustBeCalled(lessons);
  if (recs.length === 0 && active.length === 0) return "";
  const lines: string[] = ["", "PRIOR ATTEMPT RECORD (measured on the previous drafts of THIS gap; data, not advice):"];
  for (const r of recs) {
    const spans = (Array.isArray(r.edited_spans) ? (r.edited_spans as EditedSpan[]) : []).map((s) => `${s.path}:${s.start}-${s.end}`);
    const eff = r.no_effect_vs_parent === true ? "NO EFFECT (the own check failed identically on the parent)" : r.no_effect_vs_parent === false ? "changed the own check's output" : "not measured";
    lines.push(`- attempt ${String(r.at ?? "?")}: failed at stage ${String(r.stage ?? "unknown")}; class ${String(r.class ?? "?")}; edited ${spans.length ? spans.join(", ") : "(nothing applied)"}; effect vs parent: ${eff}`);
    const allRefs = Array.isArray(r.refusals) ? (r.refusals as RefusalRecord[]) : [];
    const refs = allRefs.filter((x) => x.kind !== "must_be_called");
    const crefs = allRefs.filter((x) => x.kind === "must_be_called");
    if (refs.length) lines.push(`    refused by the no-effect lock: ${refs.map((x) => `${x.path}:${x.start}-${x.end} (locked ${x.region_start}-${x.region_end})`).join(", ")}${r.escalation ? `; escalated: ${String((r.escalation as { outcome?: string }).outcome ?? "")}` : ""}`);
    if (crefs.length) lines.push(`    refused by a constraint: ${crefs.map((x) => x.region_sha.replace(/^must_be_called:/, "must_be_called(") + ")").join(", ")}${!refs.length && r.escalation ? `; escalated: ${String((r.escalation as { outcome?: string }).outcome ?? "")}` : ""}`);
    // The file-scope gate's drops reach the next draft: an edit it planned there was not applied.
    const dropped = Array.isArray(r.dropped_paths) ? (r.dropped_paths as unknown[]).map(String) : [];
    if (dropped.length) lines.push(`    dropped by the file-scope gate (not applied): ${dropped.join(", ")}${r.dropped_reason ? ` — ${String(r.dropped_reason)}` : ""}`);
    const oc = r.own_check as { test_file?: string; failing?: OwnCheckFailure[] } | undefined;
    for (const f of (oc?.failing ?? []).slice(0, 4)) {
      lines.push(`    own check ${String(oc?.test_file ?? "")} (fail) ${f.name}`);
      if (f.error) lines.push(`      ${f.error}`);
      if (f.expected) lines.push(`      ${f.expected}`);
      if (f.received) lines.push(`      ${f.received}`);
      if (f.diff) for (const d of f.diff.split("\n").slice(0, 8)) lines.push(`      ${d}`);
    }
  }
  const refused = noEffectSpans(lessons).map((s) => `${s.path}:${s.start}-${s.end}`);
  if (refused.length) lines.push(`REFUSED REGIONS (an edit op overlapping one of these is refused before it is written): ${[...new Set(refused)].join(", ")}`);
  for (const c of active) lines.push(`CONSTRAINT must_be_called(${c.symbol}) (introduced in ${c.introduced_in || "?"}): a draft that defines ${c.symbol} is refused before verify unless it also calls it on the live path, outside its own definition. A call in a test file, a comment or string, dead code (if (false), after a return) or a call whose result is discarded does not count.`);
  return lines.join("\n");
}

// ─── the store read, before the prompt ──────────────────────────────────────

export type GapRowReader = (id: string) => Promise<Array<Record<string, unknown>> | null>;

export interface HydratedGap {
  meta: Record<string, unknown>;
  source: "store" | "caller" | "store_unreadable";
  status: string;
  summary: string;
  /** For a decomposed step: its parent's check, looked up by parent_gap_id (not copied prose). */
  parent_check: { gap_id: string; check: Record<string, unknown>; failing: OwnCheckFailure[] } | null;
  /**
   * The source/parent row's failure_lessons when this gap re-attempts the SAME defect (a recommit child via
   * source_gap_id, a narrowed child via parent_gap_id). Empty for a decomposed step, whose parent's check is a
   * different check. Without this a recommit child re-edits the region its source proved no-effect.
   */
  lineage_lessons: Array<Record<string, unknown>>;
}

/** The lessons the no-effect constraint enforces for a hydrated gap: its lineage's, then its own. */
export function enforcedLessons(h: Pick<HydratedGap, "meta" | "lineage_lessons">): Array<Record<string, unknown>> {
  const own = Array.isArray(h.meta.failure_lessons) ? (h.meta.failure_lessons as Array<Record<string, unknown>>) : [];
  return [...h.lineage_lessons, ...own];
}

const CHECK_FIELDS = ["evidence_resolve", "verify_shape", "expected_literal", "hardcoded_url"] as const;

/**
 * The gap as the store holds it, merged over the caller's copy (the store wins), plus the parent's check
 * for a decomposed step. goal-host's edit-intent route passes only {edit_site}; reading the store here,
 * before any prompt is built, is what lets that route's drafter see the gap's lessons and check at all.
 */
export async function hydrateComposeGap(gap: { id?: unknown; summary?: unknown; classification_metadata?: unknown } | undefined, readGap: GapRowReader): Promise<HydratedGap> {
  const meta: Record<string, unknown> = { ...((gap?.classification_metadata ?? {}) as Record<string, unknown>) };
  let source: HydratedGap["source"] = "caller";
  let status = "";
  let summary = typeof gap?.summary === "string" ? gap.summary : "";
  const gid = typeof gap?.id === "string" ? gap.id : "";
  if (gid) {
    let rows: Array<Record<string, unknown>> | null = null;
    try { rows = await readGap(gid); } catch { rows = null; }
    if (!Array.isArray(rows)) source = "store_unreadable";
    else {
      const row = rows.find((r) => String(r.id) === gid);
      if (row) {
        Object.assign(meta, (row.classification_metadata ?? {}) as Record<string, unknown>);
        source = "store";
        status = String(row.status ?? "");
        if (!summary && typeof row.summary === "string") summary = row.summary;
      }
    }
  }
  let parent_check: HydratedGap["parent_check"] = null;
  let lineage_lessons: Array<Record<string, unknown>> = [];
  const pid = typeof meta.parent_gap_id === "string" && meta.parent_gap_id ? meta.parent_gap_id : typeof meta.source_gap_id === "string" ? meta.source_gap_id : "";
  const isStep = /-step-\d+$/.test(gid) || meta.predicate_source === "decompose";
  if (pid && pid !== gid) {
    try {
      const prow = ((await readGap(pid)) ?? []).find((r) => String(r.id) === pid);
      const pm = (prow?.classification_metadata ?? {}) as Record<string, unknown>;
      const check: Record<string, unknown> = {};
      for (const k of CHECK_FIELDS) if (pm[k] !== undefined && pm[k] !== null && pm[k] !== "") check[k] = pm[k];
      const lessons = Array.isArray(pm.failure_lessons) ? (pm.failure_lessons as Array<Record<string, unknown>>) : [];
      const last = [...lessons].reverse().find((l) => (l.own_check as { failing?: unknown } | undefined)?.failing);
      const failing = ((last?.own_check as { failing?: OwnCheckFailure[] } | undefined)?.failing ?? []);
      if (prow && Object.keys(check).length > 0) parent_check = { gap_id: pid, check, failing };
      if (prow && !isStep) lineage_lessons = lessons;
    } catch { /* an unreadable parent leaves the step's own fields */ }
  }
  return { meta, source, status, summary, parent_check, lineage_lessons };
}

/** The prompt line(s) for a decomposed step's parent check. */
export function parentCheckBlock(pc: HydratedGap["parent_check"]): string {
  if (!pc) return "";
  const lines = [`- This gap derives from parent gap ${pc.gap_id}. The parent's check (what must turn green for the parent to close): ${JSON.stringify(pc.check).slice(0, 400)}`];
  for (const f of pc.failing.slice(0, 3)) lines.push(`    parent check (fail) ${f.name}${f.expected ? ` | ${f.expected}` : ""}${f.received ? ` | ${f.received}` : ""}`);
  return lines.join("\n");
}

// ─── the standing measurement (self_fact_reconcile instrument retry_evidence) ──

export interface RetryEvidenceMeasure {
  retries_with_spans: number;
  retries_overlapping_no_effect: number;
  lessons_with_stage: number;
  lessons_class_matching_stage: number;
  /** Retries (j>0) whose attempt got past apply (a verify or scope stage), so their ops were written and spans are owed. */
  retries_expecting_spans: number;
  /** Gaps with one region refused twice or more in the window; and those of them with no escalation recorded. */
  gaps_stuck_on_refusals: number;
  gaps_stuck_unescalated: number;
  offenders: Array<{ gap: string; at: string; kind: "overlap" | "class_stage" | "stuck_refusal"; detail: string }>;
}

const SPANS_OWED = new Set(["install", "resolve", "typecheck", "shape-dispatch", "tests", "own_check", "scope", "constraint"]);

/**
 * Over gap rows: retries whose edits overlap an earlier no-effect span, and lessons whose class contradicts
 * their stage. Only lessons written at or after `sinceMs` are counted; earlier ones still serve as priors.
 */
export function measureRetryEvidence(rows: Array<Record<string, unknown>>, sinceMs = 0): RetryEvidenceMeasure {
  const m: RetryEvidenceMeasure = { retries_with_spans: 0, retries_overlapping_no_effect: 0, lessons_with_stage: 0, lessons_class_matching_stage: 0, retries_expecting_spans: 0, gaps_stuck_on_refusals: 0, gaps_stuck_unescalated: 0, offenders: [] };
  for (const row of rows) {
    const lessons = ((row.classification_metadata as Record<string, unknown> | undefined)?.failure_lessons ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(lessons)) continue;
    for (let j = 0; j < lessons.length; j++) {
      const l = lessons[j]!;
      const t = Date.parse(String(l.at ?? ""));
      if (sinceMs > 0 && !(t >= sinceMs)) continue;
      const ok = lessonClassMatchesStage(String(l.class ?? ""), l.stage as FailStage | undefined);
      if (ok !== null) {
        m.lessons_with_stage++;
        if (ok) m.lessons_class_matching_stage++;
        else m.offenders.push({ gap: String(row.id), at: String(l.at ?? ""), kind: "class_stage", detail: `class ${String(l.class)} at stage ${String(l.stage)}` });
      }
      if (j > 0 && SPANS_OWED.has(String(l.stage ?? ""))) m.retries_expecting_spans++;
      const spans = Array.isArray(l.edited_spans) ? (l.edited_spans as EditedSpan[]) : [];
      if (spans.length === 0 || j === 0) continue;
      m.retries_with_spans++;
      const prior = noEffectSpans(lessons.slice(0, j));
      // Same base: the line ranges are comparable. Different base: only an identical region (same text) is known to overlap.
      const hit = spans.find((s) => prior.some((p) => normPath(p.path) === normPath(s.path) && ((p.base === s.base && s.start <= p.end && p.start <= s.end) || p.text_sha === s.text_sha)));
      if (hit) { m.retries_overlapping_no_effect++; m.offenders.push({ gap: String(row.id), at: String(l.at ?? ""), kind: "overlap", detail: `${hit.path}:${hit.start}-${hit.end}` }); }
    }
    const inWindow = lessons.filter((l) => !(sinceMs > 0) || Date.parse(String(l?.at ?? "")) >= sinceMs);
    const byRegion = new Map<string, number>();
    for (const r of priorRefusals(inWindow)) byRegion.set(r.region_sha, (byRegion.get(r.region_sha) ?? 0) + 1);
    const stuck = [...byRegion].filter(([, n]) => n >= 2).map(([sha]) => sha);
    if (stuck.length > 0) {
      m.gaps_stuck_on_refusals++;
      const escalated = new Set(lessons.map((l) => (l?.escalation as { region?: string } | undefined)?.region).filter(Boolean));
      if (stuck.some((sha) => !escalated.has(sha))) { m.gaps_stuck_unescalated++; m.offenders.push({ gap: String(row.id), at: "", kind: "stuck_refusal", detail: `region ${stuck.join(",")} refused repeatedly with no escalation recorded` }); }
    }
  }
  return m;
}

// ─── the must_be_called constraint (a second structural constraint on the same record) ──
//
// A fix that needs two coordinated edits (define a symbol AND wire it in) converged one site per attempt: the
// in-flight gap's drafts either did not define countsTowardInFlight (its own check failed) or defined it with no
// call site, and the semantic gate rejected that as dead code. Prompt advice ("also call it") was ignored, so the
// gate's verdict becomes a constraint on the attempt record, enforced deterministically on the next draft before
// verify: a draft that defines the symbol and does not call it on the live path is refused with a precise reason.

export interface MustBeCalledConstraint {
  kind: "must_be_called";
  symbol: string;
  introduced_in: string;
  /** Derived from a pre-field lesson's prose (legacyMustBeCalled), so whether an attempt introduced it is unproven. */
  derived?: true;
}
export interface ConstraintLift { symbol: string; why: string }

const IDENT = /^[A-Za-z_$][\w$]*$/;
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Paths that are tests: a call there is not a call on the live path. */
export const TEST_PATH_RE = /(^|\/)(test|tests|__tests__|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/** A gate reason that says a symbol is dead (the LLM judge's words for it). */
const UNCALLED_REASON_RE = /\b(not called|never called|uncalled|no call[- ]?sites?|no callers?|not invoked|never invoked|dead code|unreachable|not referenced|never referenced|unused)\b/i;

/** Does this source line DEFINE `sym` (function, const/let/var, or a class/object method)? */
export function definesSymbolLine(line: string, sym: string): boolean {
  const s = escRe(sym);
  return new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${s}\\s*[(<]`).test(line)
    || new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${s}\\s*[:=]`).test(line)
    || new RegExp(`^\\s*(?:(?:public|private|protected|static|async|readonly)\\s+)*${s}\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`).test(line);
}

/** The draft (pre -> post of one file) adds a definition of `sym` that the file did not already have. */
export function introducesDefinition(pre: string, post: string, sym: string): boolean {
  const before = new Map<string, number>();
  for (const l of pre.split("\n")) if (definesSymbolLine(l, sym)) before.set(l.trim(), (before.get(l.trim()) ?? 0) + 1);
  for (const l of post.split("\n")) {
    if (!definesSymbolLine(l, sym)) continue;
    const n = before.get(l.trim()) ?? 0;
    if (n === 0) return true;
    before.set(l.trim(), n - 1);
  }
  return false;
}

/**
 * RECORD: the constraints a semantic-gate REJECTION implies. Every unreachable symbol the draft introduced (a new
 * definition with no live caller), plus any symbol the gate's reason names as uncalled/dead, provided the draft
 * introduced it (`introducedIn` returns where, or null). An accepted draft records nothing.
 */
export function mustBeCalledFromGate(
  gate: { addresses?: boolean; on_live_path?: boolean; reason?: string } | null | undefined,
  facts: ReadonlyArray<{ symbol: string; isNewFunction: boolean; reachable: boolean }>,
  introducedIn: (symbol: string) => string | null,
): MustBeCalledConstraint[] {
  if (!gate || (gate.addresses !== false && gate.on_live_path !== false)) return [];
  // The gate's own facts: isNewFunction is already "defined on an added line of this draft's diff".
  const cands = new Set<string>(facts.filter((f) => !f.reachable && f.isNewFunction).map((f) => f.symbol));
  const reason = String(gate.reason ?? "");
  // The judge's prose backticks existing APIs too: a backticked name is a candidate only if THIS draft newly defined it.
  if (UNCALLED_REASON_RE.test(reason)) for (const m of reason.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)) if (m[1] && introducedIn(m[1]) !== null) cands.add(m[1]);
  return [...cands].filter((symbol) => IDENT.test(symbol)).map((symbol) => ({ kind: "must_be_called" as const, symbol, introduced_in: introducedIn(symbol) ?? "" }));
}

/**
 * The constraints in force over a lesson list (lineage first, then own, as enforcedLessons orders them): each symbol's
 * latest record, unless a LATER lesson lifted it. None when the gap is closed or superseded.
 */
export function activeMustBeCalled(lessons: unknown, gapStatus = ""): MustBeCalledConstraint[] {
  if (!Array.isArray(lessons) || gapStatus === "closed" || gapStatus === "superseded") return [];
  const act = new Map<string, MustBeCalledConstraint>();
  for (const l of lessons as Array<Record<string, unknown>>) {
    if (!l) continue;
    for (const c of legacyMustBeCalled(l)) act.set(c.symbol, c);
    for (const c of (Array.isArray(l.constraints) ? l.constraints : []) as MustBeCalledConstraint[]) {
      if (c && c.kind === "must_be_called" && typeof c.symbol === "string" && IDENT.test(c.symbol)) act.set(c.symbol, { kind: "must_be_called", symbol: c.symbol, introduced_in: String(c.introduced_in ?? ""), ...(c.derived ? { derived: true as const } : {}) });
    }
    for (const x of (Array.isArray(l.constraints_lifted) ? l.constraints_lifted : []) as ConstraintLift[]) if (x && typeof x.symbol === "string") act.delete(x.symbol);
  }
  return [...act.values()];
}

/**
 * MIGRATION for lessons written before `constraints` existed: a semantic_reject lesson whose reason says a backticked
 * symbol is uncalled/dead implies the same constraint (introduced in the attempt's first edited file). The live
 * in-flight gap's 04:30 lesson is one; without this its next draft would run unconstrained.
 */
export function legacyMustBeCalled(l: Record<string, unknown>): MustBeCalledConstraint[] {
  if (Array.isArray(l.constraints) || l.class !== "semantic_reject") return [];
  const reason = String(l.raw_excerpt ?? l.reason ?? "");
  if (!UNCALLED_REASON_RE.test(reason)) return [];
  const at = Array.isArray(l.edited_spans) ? String((l.edited_spans as EditedSpan[])[0]?.path ?? "") : "";
  const syms = new Set([...reason.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)].map((m) => m[1]!).filter((x) => IDENT.test(x)));
  return [...syms].map((symbol) => ({ kind: "must_be_called" as const, symbol, introduced_in: at, derived: true as const }));
}

/** The refusal sentence (the exact header the lane, the journal and the next prompt read). */
export function mustBeCalledReason(symbol: string, detail = ""): string {
  return `constraint must_be_called(${symbol}) unmet: define AND call it on the live path${detail ? ` (${detail})` : ""}`;
}

/** The refusal record a constraint refusal leaves (reuses the no-effect refusal record and its escalation). */
export function mustBeCalledRefusalRecord(c: MustBeCalledConstraint): RefusalRecord {
  return { path: c.introduced_in, start: 0, end: 0, region_sha: `must_be_called:${c.symbol}`, region_start: 0, region_end: 0, kind: "must_be_called" };
}

export interface CallSite { path: string; line: number; why?: string }

// The TypeScript parser (ts-morph is a runtime dependency; loaded only when a constraint is enforced).
type TsApi = typeof import("ts-morph").ts;
let tsApi: TsApi | null = null;
async function loadTs(): Promise<TsApi> {
  if (!tsApi) tsApi = (await import("ts-morph")).ts;
  return tsApi;
}

/**
 * Every reference to `symbol` across `files`, split into LIVE uses and rejected ones with the reason. Parsed, not
 * grepped, so comments and strings never match. A use is live when it is a call (or the function passed as a value:
 * an argument, a property value, an array element) that is not in a test file, not inside the symbol's own
 * definition, not in dead code (the then-branch of `if (false)`/`if (0)`/`while (false)`, or a statement after a
 * return/throw/break/continue in the same block), and, when the symbol returns a value, does not discard it (a bare
 * call statement or `void sym()`).
 */
export async function liveCallSites(
  symbol: string,
  files: ReadonlyArray<{ path: string; content: string }>,
  hop?: { baseDefines: (name: string, inPath: string) => boolean; depth?: number; seen?: ReadonlySet<string> },
): Promise<{ live: CallSite[]; rejected: CallSite[]; returns_value: boolean }> {
  const ts = await loadTs();
  const parsed = files.filter((f) => f.content.includes(symbol)).map((f) => {
    const sf = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/.test(f.path) ? ts.ScriptKind.JS : f.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    // A file the parser cannot read cleanly cannot be judged: the caller fails closed as an environment condition.
    const diags = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    if (diags.length > 0) throw new Error(`constraint check could not parse ${f.path} (${diags.length} parse error(s))`);
    return { path: f.path, sf };
  });
  type N = import("ts-morph").ts.Node;
  const isFnLike = (n: N): boolean => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const declName = (n: N): string | null => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
    return null;
  };
  // Does the definition return a value? (an explicit non-void return type, an expression-bodied arrow, or a
  // `return <expr>` in its own body, not in a nested function)
  let returnsValue = false;
  const bodyReturns = (fn: N): boolean => {
    const f = fn as import("ts-morph").ts.FunctionLikeDeclaration;
    if (f.type) return !/^(void|never|Promise<void>|undefined)$/.test(f.type.getText().replace(/\s+/g, ""));
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return true;
    let found = false;
    const walk = (n: N): void => { if (found) return; if (n !== fn && isFnLike(n)) return; if (ts.isReturnStatement(n) && n.expression) { found = true; return; } ts.forEachChild(n, walk); };
    if (f.body) walk(f.body);
    return found;
  };
  for (const { sf } of parsed) {
    const visit = (n: N): void => {
      if (declName(n) === symbol) {
        if (ts.isVariableDeclaration(n)) { const init = n.initializer; if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && bodyReturns(init)) returnsValue = true; }
        else if (bodyReturns(n)) returnsValue = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const live: CallSite[] = [];
  const rejected: CallSite[] = [];
  const terminates = (s: N): boolean => ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s);
  // The named function a use sits in (anonymous callbacks climb to theirs); undefined = module top level.
  const enclosingName = (n: N): string | undefined => {
    for (let a: N | undefined = n.parent; a; a = a.parent) {
      if (ts.isFunctionDeclaration(a) || ts.isMethodDeclaration(a)) { if (a.name && ts.isIdentifier(a.name)) return a.name.text; continue; }
      if (ts.isConstructorDeclaration(a)) { const c = a.parent; if (ts.isClassDeclaration(c) && c.name) return c.name.text; continue; }
      if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parent && (ts.isVariableDeclaration(a.parent) || ts.isPropertyAssignment(a.parent)) && ts.isIdentifier(a.parent.name)) return a.parent.name.text;
    }
    return undefined;
  };
  const pending: Array<CallSite & { encl?: string }> = [];
  const falsy = (e: N): boolean => e.kind === ts.SyntaxKind.FalseKeyword || (ts.isNumericLiteral(e) && Number(e.text) === 0) || (ts.isParenthesizedExpression(e) && falsy(e.expression));
  for (const { path, sf } of parsed) {
    const isTest = TEST_PATH_RE.test(path);
    const visit = (n: N): void => {
      if (ts.isIdentifier(n) && n.text === symbol) {
        const p = n.parent;
        const isDeclName = !!p && (((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isClassDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && (p as { name?: N }).name === n)
          || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p));
        if (!isDeclName) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          // The use: `sym(...)`, `x.sym(...)`, or the function itself passed as a value.
          const callee = p && ts.isPropertyAccessExpression(p) && p.name === n ? p : n;
          const cp = callee.parent;
          const call = cp && ts.isCallExpression(cp) && cp.expression === callee ? cp : null;
          const asValue = !call && !!cp && ((ts.isCallExpression(cp) && cp.arguments.includes(callee as import("ts-morph").ts.Expression)) || (ts.isNewExpression(cp) && !!cp.arguments?.includes(callee as import("ts-morph").ts.Expression)) || (ts.isPropertyAssignment(cp) && cp.initializer === callee) || ts.isShorthandPropertyAssignment(cp) || ts.isArrayLiteralExpression(cp));
          let why: string | null = null;
          if (!call && !asValue) why = "a reference, not a call";
          else if (isTest) why = "in a test file";
          else {
            for (let a: N | undefined = n, prev: N | undefined; a; prev = a, a = a.parent) {
              if (declName(a) === symbol) { why = "inside its own definition"; break; }
              if (prev && (ts.isIfStatement(a) || ts.isWhileStatement(a)) && prev === (ts.isIfStatement(a) ? a.thenStatement : a.statement) && falsy(a.expression)) { why = "dead code (a branch that never runs)"; break; }
              if (prev && (ts.isBlock(a) || ts.isSourceFile(a) || ts.isCaseClause(a) || ts.isDefaultClause(a) || ts.isModuleBlock(a))) {
                const stmts = a.statements as unknown as N[];
                const i = stmts.indexOf(prev);
                if (i > 0 && stmts.slice(0, i).some(terminates)) { why = "dead code (after a return, throw, break or continue)"; break; }
              }
            }
            if (!why && call && returnsValue) {
              let up: N = call.parent;
              while (up && (ts.isAwaitExpression(up) || ts.isParenthesizedExpression(up))) up = up.parent;
              if (up && (ts.isExpressionStatement(up) || ts.isVoidExpression(up))) why = "its result is discarded";
            }
          }
          if (why) rejected.push({ path, line, why });
          else pending.push({ path, line, encl: enclosingName(n) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // ONE-HOP LIVENESS: a use inside a function this draft added (absent from the base version of the SAME file) is live
  // only if that function is itself live-called by the same rule, at most HOP_DEPTH levels deep. Otherwise "sym called from a new uncalled wrap()" passes, which is the
  // uncalled pattern one level up. A use at module top level, or inside a function the base already has, is live.
  const depth = hop?.depth ?? 1;
  for (const c of pending) {
    const e = c.encl;
    if (!hop || e === undefined || e === symbol || hop.baseDefines(e, c.path)) { live.push({ path: c.path, line: c.line }); continue; }
    if (depth >= HOP_DEPTH || hop.seen?.has(e)) { rejected.push({ path: c.path, line: c.line, why: `called only from ${e}, which this draft adds (no live caller within ${HOP_DEPTH} hops)` }); continue; }
    const up = await liveCallSites(e, files, { baseDefines: hop.baseDefines, depth: depth + 1, seen: new Set([...(hop.seen ?? []), symbol, e]) });
    if (up.live.length > 0) live.push({ path: c.path, line: c.line });
    else rejected.push({ path: c.path, line: c.line, why: `called only from ${e}, which this draft adds and nothing live calls` });
  }
  return { live, rejected, returns_value: returnsValue };
}
/** How many function hops a constrained symbol's call may sit below code that already exists in the base. */
export const HOP_DEPTH = 2;

/**
 * THE CONSTRAINT GATE. For each active must_be_called constraint whose symbol THIS draft newly defines (a new definition
 * in one of `edits`), at least one live use (liveCallSites) must exist. A constraint exists only for a symbol a draft
 * newly defines, so its calls can only be in files the draft added or modified: the parse set is the draft's touched
 * files (post-images), never the whole tree, so an unrelated broken file cannot change the verdict. The hop rule's
 * "function the base already has" is resolved against the BASE VERSION OF THE SAME FILE (`edits[].pre`).
 *
 * `readBase(path)` serves only the legacy exception: a constraint derived from an old lesson's prose (no draft proved it
 * was introduced) is lifted when its DEFINING file's base already defines the symbol (LLM prose backticks existing APIs).
 * A draft that does not newly define the symbol is not constrained by it. Called at one site in feature_compose.
 */
export async function checkMustBeCalled(
  constraints: ReadonlyArray<MustBeCalledConstraint>,
  edits: ReadonlyArray<{ path: string; pre: string; post: string }>,
  readBase: (path: string) => string | null = () => null,
): Promise<{ unmet: Array<MustBeCalledConstraint & { detail: string }>; lifted: ConstraintLift[]; reason: string }> {
  const unmet: Array<MustBeCalledConstraint & { detail: string }> = [];
  const lifted: ConstraintLift[] = [];
  const files = edits.filter((e) => e.post).map((e) => ({ path: e.path, content: e.post }));
  const preOf = new Map(edits.map((e) => [e.path, e.pre]));
  const definesIn = (text: string | null | undefined, name: string): boolean => !!text && text.includes(name) && text.split("\n").some((l) => definesSymbolLine(l, name));
  // name + file: the caller's own file as it was before this draft.
  const baseDefines = (name: string, inPath: string): boolean => definesIn(preOf.get(inPath), name);
  for (const c of constraints) {
    if (c.derived) {
      const at = c.introduced_in;
      const baseText = at ? (preOf.has(at) ? preOf.get(at)! : readBase(at)) : null;
      if (definesIn(baseText, c.symbol)) {
        lifted.push({ symbol: c.symbol, why: `named in the gate's prose but ${at} already defined it, so no attempt introduced it` });
        continue;
      }
    }
    if (!edits.some((e) => introducesDefinition(e.pre, e.post, c.symbol))) continue;
    const sites = await liveCallSites(c.symbol, files, { baseDefines });
    if (sites.live.length > 0) continue;
    const seen = sites.rejected.slice(0, 4).map((x) => `${x.path}:${x.line} ${x.why}`).join("; ");
    unmet.push({ ...c, detail: seen ? `uses found, none live: ${seen}` : "no call site in the files this draft touched" });
  }
  return { unmet, lifted, reason: unmet.map((u) => mustBeCalledReason(u.symbol, u.detail)).join("; ") };
}

/**
 * The refusal records and the (once-per-constraint) escalation a compose attempt's FINAL verify implies. Only an unmet
 * constraint counts: a constraint check that could not run (constraint_unrunnable) is an environment condition, never a
 * refusal of the draft, so it neither repeats nor escalates.
 */
export async function constraintRefusalEvidence(
  verify: ReadonlyArray<{ constraint_unmet?: MustBeCalledConstraint[] }>,
  gap: Record<string, unknown> | null,
  ownLessons: unknown,
  escalate: (gap: Record<string, unknown>, why: string) => Promise<string>,
): Promise<{ refusals: RefusalRecord[]; escalation: AttemptRecord["escalation"] }> {
  const refusals = verify.flatMap((v) => v.constraint_unmet ?? []).map(mustBeCalledRefusalRecord);
  if (refusals.length === 0) return { refusals, escalation: undefined };
  return { refusals, escalation: await escalateRepeatedRefusal(gap, ownLessons, refusals, escalate) };
}

/**
 * PARK GUARD. Consecutive compose attempts of one gap whose constraint check could not run (env_constraint_unrunnable),
 * counted from the gap's own lessons (so the count survives restarts), including this attempt. Separately written
 * no_effect_region lessons are not attempts and are skipped. At 2 or more, returns the journal line the hourly
 * check-in counts; otherwise null.
 */
export const CONSTRAINT_PARK_GREP = "^\\[fc-constraint\\] PARKED gap=";
export function constraintParkLine(gapId: string, priorLessons: unknown, thisClass: string, reason: string): string | null {
  if (thisClass !== "env_constraint_unrunnable") return null;
  let n = 1;
  const prior = Array.isArray(priorLessons) ? (priorLessons as Array<Record<string, unknown>>) : [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const cls = String(prior[i]?.class ?? "");
    if (cls === "no_effect_region") continue;
    if (cls !== "env_constraint_unrunnable") break;
    n++;
  }
  if (n < 2) return null;
  return `[fc-constraint] PARKED gap=${gapId || "none"}: constraint check could not run on ${n} consecutive attempts (${reason.replace(/\s+/g, " ").slice(0, 200)})`;
}
