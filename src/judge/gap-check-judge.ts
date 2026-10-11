/**
 * GAP CHECK JUDGE (gap-judge-core, closed). THE ONE JUDGE of a gap's own check, plus the landed-commit provenance it
 * falls back on:
 * - evaluateGapCheck / verifyGapConditionAsync: class 1 literal, class 1b expected literal (in its reader), class 2
 *   resolver behaviour;
 * - verifyGapCondition: the synchronous verdict;
 * - landedCommitVerdict: class-3 provenance, revert-aware.
 *
 * substrate-gap's birth judge (defaultBirthJudge) runs on it, so every birth verdict, every check-supply arm and
 * predicateSuspect's input do. So do the pending-land sweep, closeLandedGap, the pinned landing re-run and
 * decomposition's red-before-write.
 *
 * Moved verbatim out of src/resolvers/gap-to-feature.ts (the gap-to-feature judge split, BOUNDARY.md 1.3): a lane
 * edit to the judge would change what the closed files treat as verified, including the verdict on that very edit.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { selfAuthHeaders } from "../lib/self-auth.js";
import { evaluatorTreePath } from "../lib/evaluator-tree.js";
import { nonEmptyStr } from "./gap-eligibility.js";
import { vesselsCloneRoot } from "./gap-policy.js";

/**
 * Verify whether a gap's condition still holds in the file system.
 * For surgical gaps with edit_site + hardcoded_url in classification_metadata:
 *   returns 'present' if the literal is still in the file, 'absent' if gone, 'unknown' otherwise.
 * For resolver-behaviour gaps with evidence_resolve or verify_shape in classification_metadata:
 *   POSTs to the vessel's own resolve endpoint, inspects the body for the defect signature
 *   (fetch_error field, or zero/empty value where ground truth is nonzero), returns
 *   'present' (defect still there), 'absent' (resolved healthy), 'unknown' on transport failure.
 * 'unknown' preserves today's behaviour — no false closes, no blocked closes.
 */
/**
 * CLASS 1b — INVERSE POLARITY. `expected_literal` PRESENT means FIXED; ABSENT means the
 * defect is still there (or has regressed).
 *
 * WHY THIS HAS TO EXIST. Class 1 can only say "this bad literal is still in the file". It
 * cannot say "this good guard is missing" — and that missing polarity is why automated
 * predicate derivation has failed twice on this fleet (be26a6b, reverted by 8a5223c).
 *
 * The proof is a real autonomous repair. Gap groupbounded-fix-not-propagated was fixed
 * correctly by Substrate Autonomous in local-tools-vessel 4d0c600 (FAVORABLE, pushed), which
 * INSERTED a guard:
 *     ( sleep t;                    __killtree $__cpid; kill -9 -$__cpid )
 *  -> ( sleep t; kill -0 $__cpid && __killtree $__cpid; kill -9 -$__cpid )
 * Measured with grep -c -F on both trees: the defect literal `kill -9 -$__cpid 2>/dev/null`
 * occurs ONCE at 4d0c600^ and ONCE at 4d0c600. The fix was ADDITIVE, so the cited literal
 * SURVIVED it. A Class-1 predicate — even one derived at gap-CREATION time, when the defect
 * genuinely was present — would still read 'present' after the correct fix, bypass the
 * pending->skip-re-compose guard, and manufacture a re-land. Moving derivation earlier does
 * not help: the polarity is what is wrong.
 *
 * Additive fixes are the COMMON case, not an edge case — adding an --exclude-dir, a capacity
 * guard, a transaction retry, a range branch. None remove a literal a detector would cite.
 *
 * STRICTLY ADDITIVE BY CONSTRUCTION: both call sites gate on `!hardcodedUrl`, so no gap
 * carrying a Class-1 predicate today can change verdict. A gap opts in by carrying
 * expected_literal and no hardcoded_url.
 */
/** Comment-stripped text of every body of `reader` in `src`: a definition (function reader( / reader = ( /
 *  reader = async ( / a method reader(…) {) or a call taking a callback (afterAll(() => { … })). Brace-matched from
 *  the first "{" after the name, skipping string and template literals. [] when the reader is not found. */
/** Index of the body "{" that follows a parameter list ending just before `from`, or -1. An optional return-type
 *  annotation (": T") is skipped as ONE balanced type expression, so a "{" inside it (Promise<{ a: number }>, or a
 *  type literal { a: number }) is never mistaken for the body, and a literal that exists only in the return type can
 *  never count as in-body (qa, 2026-09-30). Then "=>" (arrow) or "{" (function) must follow; an expression-bodied
 *  arrow has no braced body and returns -1. */
function bodyAfterParams(src: string, from: number): number {
  let i = from;
  const ws = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  ws();
  if (src[i] === ":") {
    i++;
    let depth = 0, started = false, q: string | null = null;
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (q) { if (ch === "\\") { i++; continue; } if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { q = ch; started = true; continue; }
      if (depth === 0 && ch === "=" && src[i + 1] === ">" && started) break;
      if (depth === 0 && ch === "{" && started) break;
      if (ch === "<" || ch === "(" || ch === "[" || ch === "{") { depth++; started = true; continue; }
      if (ch === ">" || ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
      if (!/\s/.test(ch)) started = true;
    }
  }
  ws();
  if (src[i] === "=" && src[i + 1] === ">") { i += 2; ws(); }
  return src[i] === "{" ? i : -1;
}

export function readerBodies(src: string, reader: string): string[] {
  const esc = reader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:function\\s+" + esc + "\\b|\\b" + esc + "\\s*(?:=\\s*(?:async\\s*)?)?\\()", "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // The body must belong to THIS occurrence: a callback inside the call's own parentheses (afterAll(() => {…})),
    // or a "{" right after the closing ")" (optionally past a return type / "=>") as in a definition. A plain call
    // such as searchTemplates(q) has no body, and the next "{" further down belongs to something else.
    const lp = src.indexOf("(", m.index);
    if (lp < 0) continue;
    let pd = 0, rp = -1;
    for (let j = lp; j < src.length; j++) { const c = src[j]; if (c === "(") pd++; else if (c === ")") { pd--; if (pd === 0) { rp = j; break; } } }
    if (rp < 0) continue;
    // A DEFINITION (function R( / R = ( / R = async () owns only the "{" after its parameters: a "{" inside them is a
    // destructuring pattern, not a body. A CALL (R() may be a method definition (body after ")") or take a callback
    // whose body is the "{" inside its own parentheses (afterAll(() => {…})).
    const isDefinition = /^function\b|=/.test(m[0]);
    let open = bodyAfterParams(src, rp + 1);
    if (open < 0 && !isDefinition) { const inner = src.indexOf("{", lp); if (inner >= 0 && inner < rp) open = inner; }
    if (open < 0) continue;
    let depth = 0, i = open, q: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === "`") { q = c; continue; }
      if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
      if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 1; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    if (depth === 0) out.push(src.slice(open, i + 1).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1"));
  }
  return out;
}

/** A decomposed step's literal counts only in comment-free code INSIDE its literal_reader: anywhere else in the file
 *  (a comment, an unrelated function, a module-level constant) proves nothing about the reader. null = the reader
 *  cannot be located (unknown, never 'fixed'). */
export function literalInReaderBody(src: string, literal: string, reader: string): boolean | null {
  const bodies = readerBodies(src, reader);
  if (bodies.length === 0) return null;
  return bodies.some((b) => b.includes(literal));
}

function evaluateExpectedLiteral(editSite: string, expectedLiteral: string, literalReader?: string): 'present' | 'absent' | 'unknown' {
  const runtimePath = evaluatorTreePath(editSite);
  if (!existsSync(runtimePath)) return 'unknown';
  const contents = readFileSync(runtimePath, 'utf8');
  // A decomposed step names the function that must read its literal; whole-file presence closed steps on a comment,
  // an unrelated constant (a782ec1) or a helper the draft invented (qa + operator, 2026-09-30).
  if (literalReader) {
    const inReader = literalInReaderBody(contents, expectedLiteral, literalReader);
    return inReader === null ? 'unknown' : inReader ? 'absent' : 'present';
  }
  // PRESENT means the fix is in place, so the DEFECT is absent. Inverse of Class 1.
  return contents.includes(expectedLiteral) ? 'absent' : 'present';
}

/** A decomposed step closed ONLY by its literal is not a verification: the literal names new code, so its presence
 *  proves only that the new code exists (0f7e688 closed landed_verified on such a literal and was a regression). It
 *  still closes (so it is not re-landed), recorded as landed_literal_only with falsifier_exercise.passed=false. */
export function isLiteralOnlyStepClose(meta: Record<string, unknown>): boolean {
  return meta["predicate_source"] === "decompose" && typeof meta["expected_literal"] === "string" && (meta["expected_literal"] as string).trim() !== ""
    && !meta["evidence_resolve"] && !meta["verify_shape"];
}

// Exported for unit test only — same reason chooseFirstActionable and requeueAfterNonAttempt
// are: the behaviour is worth pinning without a live pool. No call-site change.
export function verifyGapCondition(gap: Record<string, unknown>): 'present' | 'absent' | 'pending' | 'unknown' {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // MEASUREMENT BEFORE PROVENANCE (§12.6 step 1, 2026-08-14): if this gap declares a Class-2
    // measurement predicate (evidence_resolve / verify_shape), the async sibling must run it —
    // do NOT let the sync landed-commit provenance short-circuit a measurable gap. Defer to async.
    const hasClass2Predicate = meta['evidence_resolve'] !== undefined || meta['verify_shape'] !== undefined;
    // Prefer clean file_path field (surgical-gap-scan writes this without line suffix);
    // fall back to edit_site but strip trailing ':<digits>' line suffix if present.
    const rawEditSite = typeof meta['file_path'] === 'string'
      ? meta['file_path']
      : (typeof meta['edit_site'] === 'string' ? meta['edit_site'] : null);
    const editSite = rawEditSite ? rawEditSite.replace(/:\d+$/, '') : null;
    const hardcodedUrl = typeof meta['hardcoded_url'] === 'string' ? meta['hardcoded_url'] : null;
    if (editSite && hardcodedUrl) {
      // editSite is repo-relative like repos/some-vessel/src/file.ts
      // Map to runtime path using the same pattern as line 21
      const runtimePath = evaluatorTreePath(editSite);
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      // A predicate the LANDING derived from its own diff (a line the commit removed,
      // stamped at cutover as predicate_source=removed_line_of_landing_commit) is a
      // DURABILITY sentinel — "is my change still in place?" — not a resolution
      // predicate. Reading its absence as 'absent' let a landing close a gap with the
      // evidence it manufactured itself (measured 2026-09-22: two gaps closed
      // close_basis=absent, three times, over an operator reopen). Its presence means
      // the change was reverted; its absence means only that the landing persists.
      if (meta['predicate_source'] === 'removed_line_of_landing_commit') {
        return contents.includes(hardcodedUrl) ? 'present' : 'pending';
      }
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // Class 1b: inverse polarity (expected_literal). Only when Class 1 did not apply.
    const expectedLiteral = nonEmptyStr(meta['expected_literal']);
    if (editSite && !hardcodedUrl && expectedLiteral) {
      return evaluateExpectedLiteral(editSite, expectedLiteral, nonEmptyStr(meta['literal_reader']) || undefined);
    }
    // ── Class 3 (sync): landed commit — a substrate-authored commit referencing this gap id already exists ──
    const gapIdForLandedSync = typeof gap['id'] === 'string' ? (gap['id'] as string) : '';
    const behavioralFail = String(gap['summary'] ?? '').includes('BEHAVIORAL VERIFICATION FAILED') || ((gap['classification_metadata'] ?? {}) as Record<string, unknown>)['regressed_by'] !== undefined;
    // THIS IS THE SECOND COPY OF THE SAME CHECK IN THIS FUNCTION, and it runs FIRST.
    //
    // I fixed the copy ~100 lines below (018fd05, 81d8474) and never looked for another.
    // This one kept the original behaviour — every clone, no revert awareness — so it
    // returned 'absent' before the corrected copy was ever reached, and the gap kept
    // closing as already_resolved five seconds after every pick while I verified fix
    // after fix as "deployed and running". Duplicated logic means a fix applied to one
    // site is not a fix.
    //
    // Same two corrections as the other copy: scope to the vessel the gap names, since
    // only that repo's history can show the change landing (a commit elsewhere is
    // discussion — my own fix commit in development-vessel was closing this very gap);
    // and refuse a match that IS a revert or WAS reverted, since git is append-only and
    // undoing a change adds a commit rather than removing one.
    const landedSiteSync = typeof ((gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>)['edit_site'] === 'string'
      ? String(((gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>)['edit_site'])
      : '';
    // Class 3 centralized (2026-08-14): a single non-reverted landing => 'pending' (landed,
    // UNVERIFIED — provenance, not measurement), a RE-LAND (>=2) => 'present'. Only runs when the
    // gap has no measurement predicate (else the async measurer owns the verdict).
    if (gapIdForLandedSync.length >= 8 && !behavioralFail && !hasClass2Predicate) {
      const verdict = landedCommitVerdict(gapIdForLandedSync, landedSiteSync);
      if (verdict !== null) return verdict;
    }
    // Second evidence class: resolver-behaviour gaps.
    // classification_metadata may carry:
    //   evidence_resolve: { shape: string, input?: Record<string,unknown>, defect_field?: string, nonzero_field?: string, zero_field?: string }
    //   nonzero_field is a HEALTH field (0 = defect); zero_field is a DEFECT count (>0 = defect).
    // OR
    //   verify_shape: string  (shorthand — shape name only, defect detected by fetch_error or zero-count heuristic)
    const evidenceResolveRaw = meta['evidence_resolve'];
    const verifyShapeRaw = meta['verify_shape'];
    if (evidenceResolveRaw !== undefined || verifyShapeRaw !== undefined) {
      // This branch must be async; we cannot make verifyGapCondition async without
      // refactoring all callers, so we return a Promise that the caller awaits.
      // We wrap the async logic in an immediately-invoked function and return the
      // Promise cast — callers already await the outer closeLandedGap which in turn
      // calls verifyGapCondition. To keep the sync signature and avoid a full
      // refactor, we use a synchronous Bun-native approach: spawn a sub-call inline
      // with a helper that returns the verdict synchronously via Atomics + SharedArrayBuffer.
      // However, the cleanest zero-refactor approach is to make verifyGapCondition
      // return Promise<...> | 'unknown' and have callers handle it.  Since that would
      // require editing every caller, we instead use a different strategy:
      // return the sentinel 'unknown' here and rely on the async sibling
      // verifyGapConditionAsync which is called from the async closer path below.
      // The sentinel causes fail-open (no false close) — the async path does the real work.
      return 'unknown';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Async variant of verifyGapCondition that also handles the resolver-behaviour
 * evidence class (evidence_resolve / verify_shape in classification_metadata).
 * Called from closeLandedGap so the async fetch does not block the sync path.
 */
export type GapCheckVerdict = 'present' | 'absent' | 'pending' | 'unknown';
export interface GapCheckOpts {
  /** The transport for the class-2 resolve. Injected by tests and by the offline dry estimate; default global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the per-shape budget below. */
  timeoutMs?: number;
  /** Observes the class-2 check's own report (e.g. test_suite's ran/fail/failingTests); never changes the verdict. */
  onReport?: (report: Record<string, unknown>) => void;
}

/**
 * THE CLASS-2 BUDGET IS THE CHECK'S OWN (gap_falsify v2). The judge aborted every class-2 resolve at 10 s,
 * but a test_suite check runs `bun test` with its own budget (input.timeout_ms; the resolver defaults to
 * 240 s and the pull-sync failing-test generator files 180 s). Aborting first read the check as 'unknown'
 * while the suite kept running in the shell, so a failing-test gap could be neither admitted nor closed by
 * its own check. The judge now waits longer than the resolver's own outer bound (its budget + 30 s,
 * test-suite.ts) so the resolver's report, not our abort, decides. Every other shape keeps 10 s.
 */
export function gapCheckTimeoutMs(shape: string, input: Record<string, unknown>): number {
  if (shape !== 'test_suite') return 10_000;
  const t = input['timeout_ms'];
  const budget = typeof t === 'number' && Number.isFinite(t) && t > 0 ? Math.min(t, 840_000) : 240_000;
  return budget + 60_000;
}

/**
 * ONE JUDGE (gap_falsify v2, REALIGNMENT §2.3; contained-self-development 8.5). The verdict a gap's check
 * gives on the tree now: at birth (substrateGap_write stamps predicate_birth_verdict), in the decomposition
 * proposer (a proposed check is written only if it reads 'present' before any fix), and at closure
 * (closeLandedGap and the pending-land sweep). All of them call this, so a fix to the judge is a fix
 * everywhere; there is no second evaluator.
 */
export async function evaluateGapCheck(gap: Record<string, unknown>, opts: GapCheckOpts = {}): Promise<GapCheckVerdict> {
  return verifyGapConditionAsync(gap, opts);
}

async function verifyGapConditionAsync(gap: Record<string, unknown>, opts: GapCheckOpts = {}): Promise<GapCheckVerdict> {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // MEASUREMENT BEFORE PROVENANCE (§12.6 step 1, 2026-08-14): a Class-2 measurement predicate
    // (evidence_resolve / verify_shape) must be RUN before the Class-3 landed-commit provenance is
    // consulted. Previously Class 3 ran first and a gap with a real predicate closed on the commit
    // count without its predicate ever executing. When a predicate exists, skip provenance here and
    // let Class 2 below own the verdict (measured present/absent, or 'unknown'-abstain if unmeasurable).
    const hasClass2Predicate = meta['evidence_resolve'] !== undefined || meta['verify_shape'] !== undefined;
    // ── Class 1: surgical (file + literal) ──────────────────────────────────
    const rawEditSite = typeof meta['file_path'] === 'string'
      ? meta['file_path']
      : (typeof meta['edit_site'] === 'string' ? meta['edit_site'] : null);
    const editSite = rawEditSite ? rawEditSite.replace(/:\d+$/, '') : null;
    const hardcodedUrl = typeof meta['hardcoded_url'] === 'string' ? meta['hardcoded_url'] : null;
    if (editSite && hardcodedUrl) {
      const runtimePath = evaluatorTreePath(editSite);
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      // A predicate the LANDING derived from its own diff (a line the commit removed,
      // stamped at cutover as predicate_source=removed_line_of_landing_commit) is a
      // DURABILITY sentinel — "is my change still in place?" — not a resolution
      // predicate. Reading its absence as 'absent' let a landing close a gap with the
      // evidence it manufactured itself (measured 2026-09-22: two gaps closed
      // close_basis=absent, three times, over an operator reopen). Its presence means
      // the change was reverted; its absence means only that the landing persists.
      if (meta['predicate_source'] === 'removed_line_of_landing_commit') {
        return contents.includes(hardcodedUrl) ? 'present' : 'pending';
      }
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // Class 1b: inverse polarity (expected_literal). Only when Class 1 did not apply.
    const expectedLiteral = nonEmptyStr(meta['expected_literal']);
    if (editSite && !hardcodedUrl && expectedLiteral) {
      return evaluateExpectedLiteral(editSite, expectedLiteral, nonEmptyStr(meta['literal_reader']) || undefined);
    }
    // ── Class 3: landed commit — provenance (single landing => 'pending', NOT measurement) ──
    // Only consulted when no Class-2 predicate exists (measurement-before-provenance, above).
    const gapIdForLanded = typeof gap['id'] === 'string' ? (gap['id'] as string) : '';
    const behavioralFail = String(gap['summary'] ?? '').includes('BEHAVIORAL VERIFICATION FAILED') || ((gap['classification_metadata'] ?? {}) as Record<string, unknown>)['regressed_by'] !== undefined;
    if (gapIdForLanded.length >= 8 && !behavioralFail && !hasClass2Predicate) {
      // EVIDENCE MUST COME FROM THE REPO THE GAP IS ABOUT.
      //
      // This scanned EVERY clone, so a commit in an unrelated vessel that merely
      // MENTIONS the gap id counted as resolving it. The instance that exposed it is
      // hard to improve on: commit 018fd05 in development-vessel — whose message
      // explains that quoting a gap id is not evidence of a fix — became the false
      // evidence closing the very gap it was written about. My documentation resolved
      // the complaint it was documenting.
      //
      // A gap names its target through edit_site. Only that vessel's history can show
      // the change landing; a commit anywhere else is discussion, not resolution.
      const landedMeta = (gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>;
      const landedSiteRaw = typeof landedMeta['edit_site'] === 'string' ? String(landedMeta['edit_site']) : '';
      // Class 3 centralized (2026-08-14): a single non-reverted landing => 'absent'; a RE-LAND
      // (>=2 non-reverted commits) => 'present' — the referent persisted despite landing, so a
      // commit naming the gap is not proof it is fixed. Revert-awareness + vessel scoping live in
      // landedCommitVerdict (the prior inline copies' revert lessons are folded into it).
      const verdict = landedCommitVerdict(gapIdForLanded, landedSiteRaw);
      if (verdict !== null) return verdict;
    }
    // ── Class 2: resolver-behaviour (evidence_resolve / verify_shape) ───────
    const evidenceResolveRaw = meta['evidence_resolve'];
    const verifyShapeRaw = meta['verify_shape'];
    let resolveShape: string | null = null;
    let resolveInput: Record<string, unknown> = {};
    let defectField: string | null = null;
    let nonzeroField: string | null = null;
    let zeroField: string | null = null;
    if (evidenceResolveRaw !== null && typeof evidenceResolveRaw === 'object') {
      const er = evidenceResolveRaw as Record<string, unknown>;
      resolveShape = typeof er['shape'] === 'string' ? er['shape'] : null;
      // ── Fallback A: sample-body-form evidence (no shape field) ──────────
      // Gap-filing paths (defect reports, surgical-gap-scan) write evidence_resolve
      // as a sample response body e.g. {obsidian_vessel_count:0, fetch_error:"..."}.
      // When shape is absent, fall back to classification_metadata.verify_shape,
      // then to a gap-id-derived shape. Also treat fetch_error/error keys as an
      // implied defect_field so the verifier rejects hollow closes on error bodies.
      if (resolveShape === null) {
        if (typeof verifyShapeRaw === 'string' && verifyShapeRaw.length > 0) {
          resolveShape = verifyShapeRaw;
        } else if (typeof meta['verify_shape'] === 'string' && (meta['verify_shape'] as string).length > 0) {
          resolveShape = meta['verify_shape'] as string;
        } else {
          // Derive shape from gap id: e.g. "gap-obsidian-vessel-count" -> "obsidian_vessel_count"
          const gapId = typeof gap['id'] === 'string' ? gap['id'] : '';
          if (gapId.length > 0) {
            const derived = gapId.replace(/^gap-/, '').replace(/-/g, '_');
            if (derived.length > 0) resolveShape = derived;
          }
        }
        // Treat fetch_error or error keys in sample-body-form evidence as implied defect_field
        if (defectField === null) {
          if (typeof er['fetch_error'] === 'string') {
            defectField = 'fetch_error';
          } else if (typeof er['error'] === 'string') {
            defectField = 'error';
          }
        }
      }
      resolveInput = (typeof er['input'] === 'object' && er['input'] !== null)
        ? (er['input'] as Record<string, unknown>)
        : {};
      defectField = typeof er['defect_field'] === 'string' ? er['defect_field'] : null;
      nonzeroField = typeof er['nonzero_field'] === 'string' ? er['nonzero_field'] : null;
      zeroField = typeof er['zero_field'] === 'string' ? er['zero_field'] : null;
    } else if (typeof verifyShapeRaw === 'string') {
      resolveShape = verifyShapeRaw;
    }
    if (!resolveShape) return 'unknown';
    // POST to the vessel's own in-container resolve endpoint.
    // THE ROUTE REQUIRES AN ENVELOPE (2026-09-01). This POSTed a FLAT body,
    // `{type, ...input}`, and src/routes/impulses.ts:1015-1027 requires
    // `{impulse:{pointer:{...}}}`. Measured against the running vessel:
    //
    //   flat {type,...}              -> HTTP 400
    //   {impulse:{pointer:{...}}}    -> HTTP 200
    //
    // and four lines below, `if (!resp.ok) return 'unknown'`. So EVERY Class-2
    // evidence_resolve / verify_shape predicate in the fleet has been silently inert
    // since this path was written — not one has ever been evaluated. The gap store
    // shows the consequence: 703 of 1207 lifetime exits are `expired_not_redetected`,
    // a 30-day timer, against 20 `landed_verified`.
    //
    // Nothing failed loudly because a 400 is indistinguishable from "no defect signal"
    // once it becomes 'unknown'. Fifth producer/consumer envelope mismatch found today;
    // this is the one that disabled a whole predicate class.
    // MEASURE WHERE THE STORE IS HELD (2026-09-28). A node that forwards its gap store answers this
    // check from its OWN filesystem and units, which are not the ones the gap's detector observed:
    // node 2's self_fact_reconcile saw 1 service repo and 0 divergences and closed a divergence node 1
    // still measures, crediting an inert landing (9c86aff). Abstain here; the holder's sweep runs over
    // the same store and measures it where it was observed. Logged, because a silent skip reads as a pass.
    // A CHECK THAT WRITES IS NOT A CHECK (2026-09-29). Decomposed steps were born with class-2
    // checks such as uiPanel_write {id:"test",...} and uiQuestion_write: executing them here
    // performs a live write as 'verification' and reads an unrelated field as a defect count.
    // Never execute a *_write shape; the gap stays unmeasured until it has a read-shaped check.
    if (/_write$/.test(resolveShape)) {
      console.log(`[gap-verify] class2 check for ${String(gap['id'] ?? '')} names a write shape (${resolveShape}) — not executed; unknown`);
      return 'unknown';
    }
    if (process.env['GAP_STORE_ENDPOINT']) {
      console.log(`[gap-verify] class2 check for ${String(gap['id'] ?? '')} (${resolveShape}) abstained on this node: the gap store is held elsewhere, so its sweep measures it`);
      return 'unknown';
    }
    const payload: Record<string, unknown> = { impulse: { pointer: { type: resolveShape, ...resolveInput } } };
    let respBody: Record<string, unknown>;
    try {
      const SELF_RESOLVE_ENDPOINT = process.env['SELF_RESOLVE_ENDPOINT'] ?? `http://localhost:${process.env['PORT'] ?? '8090'}/v2/impulses/resolve`;
      // The check's resolve shape comes from the gap, so it can be a write: carry the node key, or this
      // vessel's own write gate refuses it (lib/self-auth.ts).
      const resp = await (opts.fetchImpl ?? fetch)(SELF_RESOLVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...selfAuthHeaders(SELF_RESOLVE_ENDPOINT, SELF_RESOLVE_ENDPOINT) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs ?? gapCheckTimeoutMs(resolveShape, resolveInput)),
      });
      if (!resp.ok) return 'unknown';
      respBody = (await resp.json()) as Record<string, unknown>;
    } catch {
      // Transport failure — fail open (unknown), no false close.
      return 'unknown';
    }
    // Unwrap nested body if the resolver wraps results in { body: { ... } }
    const inner = (typeof respBody['body'] === 'object' && respBody['body'] !== null)
      ? (respBody['body'] as Record<string, unknown>)
      : respBody;
    try { opts.onReport?.(inner); } catch { /* an observer cannot change or break the verdict */ }
    // AN INSTRUMENT THAT SAYS IT DID NOT OBSERVE IS NOT A MEASUREMENT (2026-09-29, class-wide).
    // A zero from a run that read nothing (no rows, unreadable source, missed canary) would
    // otherwise read as 'absent' and close the gap as verified. Any check whose response says
    // observed:false or measured:false is unknown; instruments that do not report it are unaffected.
    if (inner['observed'] === false || inner['measured'] === false) {
      console.log(`[gap-verify] class2 check for ${String(gap['id'] ?? '')} reported observed/measured false — unknown`);
      return 'unknown';
    }
    // Defect heuristic 1: explicit defect_field present in response
    if (defectField !== null && inner[defectField] !== undefined && inner[defectField] !== null && inner[defectField] !== '') {
      return 'present';
    }
    // Defect heuristic 1b: zero_field is a DEFECT count — >0 the defect stands, exactly 0 it is gone,
    // anything non-numeric is unmeasured. It exists because defect counts were written as
    // nonzero_field (below, a HEALTH field): self_fact_reconcile's divergence_count=1 read as fixed and
    // closed a live divergence landed_verified for a landing that was then reverted. Twice-seen class.
    if (zeroField !== null) {
      const zv = inner[zeroField];
      if (typeof zv === 'number' && zv > 0) return 'present';
      if (zv === 0) return 'absent';
      return 'unknown';
    }
    // Defect heuristic 2: explicit nonzero_field is a HEALTH count — a finite number >0 is absent, 0 is present.
    // null / missing / non-numeric is UNMEASURED and reads unknown. It used to read 'present', which held a gap
    // open (right for closing) but, since the falsified-landing record, also marks a landing FALSIFIED on an
    // outage or an under-volume null (wrong). Unknown does neither: the sweep abstains and the gap stays open.
    if (nonzeroField !== null) {
      const val = inner[nonzeroField];
      if (typeof val === 'number' && Number.isFinite(val)) return val > 0 ? 'absent' : 'present';
      return 'unknown';
    }
    // Defect heuristic 3 (generic): presence of a fetch_error field signals defect
    if (typeof inner['fetch_error'] === 'string' && inner['fetch_error'].length > 0) {
      return 'present';
    }
    // Defect heuristic 4 (generic): zero-count on common count fields
    for (const countKey of ['count', 'obsidian_vessel_count', 'vessel_count']) {
      if (countKey in inner) {
        const v = inner[countKey];
        if (v === 0 || v === null || v === undefined) return 'present';
        return 'absent';
      }
    }
    // NO DEFECT SIGNATURE FOUND — THAT IS 'unknown', NOT 'absent' (2026-09-01).
    //
    // This returned 'absent', which CLOSES the gap. So a predicate naming only a shape —
    // no defect_field, no nonzero_field — closed its gap on any HTTP 200 whose body
    // happened to carry no fetch_error and none of the count keys above. The resolver was
    // never asked a question about the defect, and its silence was read as an answer.
    //
    // Absence of evidence is not evidence of absence, and this is the one path whose whole
    // purpose is refusing to close on anything but measurement — the provenance class it
    // exists to replace sits at 0 closes / 766 false closes for precisely this mistake.
    //
    // MEASURED against the live store by driving the real sweep with three rows copied from
    // it, all carrying `evidence_resolve: {shape: "trace_failure_pattern_report"}` and no
    // field: with the Class-2 envelope armed, checked=8 closed=5 — three of them false,
    // each writing recordCloseVerdict("measured", false) into the calibration whose
    // unblemished 7/0 record is the only reason that class is trusted at all. Three
    // wrongful closes would have carried it to 10/0, crossing CLOSE_ORACLE_MIN_SAMPLES on
    // measurements that measured nothing.
    //
    // 'unknown' is the honest verdict: the sweep abstains, the gap stays open, and a human
    // or a later measurement decides. A predicate that names no field carries no
    // proposition, so there is nothing here that could have been found false.
    return 'unknown';
  } catch {
    // fall through to landed-commit evidence class
  }
  // ── Class 3: landed-commit evidence (centralized 2026-08-14 — now revert- and re-land-aware) ──
  // This copy was previously unscoped and NOT revert-aware; routing it through
  // landedCommitVerdict strengthens it to match the other sites and closes the same hole.
  try {
    const gapId = typeof gap.id === 'string' ? gap.id : '';
    const metadata = (gap.classification_metadata as Record<string, unknown> | undefined) ?? {};
    let editSite = typeof metadata['edit_site'] === 'string' ? String(metadata['edit_site']) : '';
    if (editSite.startsWith('/vessels/human-surface-vessel/')) {
      editSite = editSite.replace('/vessels/human-surface-vessel/', 'repos/human-surface-vessel/');
    }
    const verdict = landedCommitVerdict(gapId, editSite);
    if (verdict !== null) return verdict;
  } catch {
    // fail open
  }
  return 'unknown';
}

/**
 * Has this landed commit been REVERTED since it landed?
 *
 * shaIsAncestorOfAnyClone cannot tell: `git revert` adds a NEW commit that undoes the
 * change and leaves the original in history, so the reverted sha stays an ancestor of
 * HEAD forever. The sweep's own comment claimed the ancestor check covered "the land
 * was reverted" — it never did.
 *
 * Measured 2026-08-07: ad706ce landed a wrong-region UI patch, was reverted in 1812ee7,
 * and the sweep still closed the gap as `landed_verified` on a commit whose change no
 * longer exists. A human's UI complaint was marked resolved with the code containing no
 * trace of it — and a closed gap is never re-routed, so it could never be retried. That
 * is worse than leaving it open: the store asserts a resolution that the tree denies.
 *
 * `git revert` writes "This reverts commit <full-sha>." into the message, so look for a
 * descendant carrying it. Cheap, and it only has to catch the mechanised case; a manual
 * undo that rewrites the change by hand is not detectable here and is not claimed to be.
 */
export function shaWasRevertedInAnyClone(sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return false; }
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const full = Bun.spawnSync(["git", "-C", cloneDir, "rev-parse", sha], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (full.exitCode !== 0) continue;
      const fullSha = new TextDecoder().decode(full.stdout).trim();
      if (!fullSha) continue;
      // Match BOTH forms. `git revert` writes the trailer "This reverts commit <full-sha>."
      // but that message is routinely REWRITTEN — an operator amending the revert to
      // explain WHY drops the trailer entirely. That is not hypothetical: the revert this
      // detector was written for (1812ee7) says "This reverts ad706ce" in prose and
      // carries no trailer, so a trailer-only grep misses the exact case that motivated
      // it. I asserted I had verified against that pair and had not; the query returned
      // empty. Accept "reverts <sha>" with a 7+ hex prefix as well, which survives an
      // amended message, and search the SHORT sha too since prose uses it.
      const shortSha = fullSha.slice(0, 12);
      // Allow arbitrary words between "reverts" and the sha, not only an optional "commit ".
      // An operator amending the revert message ("Reverts substrate-authored commit <sha>")
      // inserts words the fixed `(commit )?` alternative cannot absorb, and the trailer-only
      // form is defeated the same way. Measured 2026-08-23 on route-edit-56849210.
      const pattern = `reverts (\\w+ ){0,4}(commit )?(${fullSha}|${shortSha}|${sha})`;
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "log", "-E", "--grep", pattern, "-i", "--format=%H", `${sha}..HEAD`], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (proc.exitCode === 0 && new TextDecoder().decode(proc.stdout).trim().length > 0) return true;
    } catch { /* per-repo failure — continue */ }
  }
  return false;
}

/**
 * Landed-commit evidence for a gap, with RE-LAND awareness (§12.6, 2026-08-14).
 *
 * Class 3 previously returned 'absent' whenever ONE non-reverted substrate-authored commit
 * referenced the gap id (`git log --grep <gapId> -1`). That certifies closure on a
 * producer-authored string — the commit message names the gap — rather than on a measured
 * condition. Demonstrated hole: gap-env-gated-write-allowlist "closed" on bafd83d, an inert
 * rename (WRITE_ALLOWLIST -> WRITE_ALLOWLIST_ENV) that left process.env["WRITE_ALLOWLIST"]
 * and thus the env-gate intact — and that gap had already been re-detected and re-landed once
 * (69d680b at 05:39, then bafd83d at 07:34: two non-reverted commits reference it).
 *
 * The re-detection is the referent's persistence signal. Count non-reverted commits:
 *   0  -> null      (no landed evidence — caller falls through, unchanged)
 *   1  -> 'pending' (first landing — PROVENANCE, NOT MEASUREMENT. A commit naming the gap is
 *          proof a change LANDED, not proof it DID ANYTHING. This is exactly the inert-diff
 *          (bafd83d) hole: a syntactically-valid no-op typechecks, lands, and — when this
 *          returned 'absent' — closed the gap green while the condition it named still held.
 *          'pending' means "landed, unverified": the close-oracle abstains (out of coverage
 *          for provenance-only evidence), so the caller must NOT close and must NOT re-compose
 *          (a second landing would read as a re-land and manufacture the false-close the oracle
 *          is calibrated against). Only a MEASUREMENT predicate (Class 1 literal / Class 2
 *          resolver-behaviour) can return 'absent' = positively-observed resolved.)
 *   >=2 -> 'present' (landed, re-detected, re-landed => prior landing did not resolve the
 *          condition => refuse close; callers refuse close on 'present')
 *
 * Scoped to the gap's target vessel (from editSite): a mention elsewhere is discussion, not
 * evidence — the same rule the three former inline copies carried. Uses vesselsCloneRoot() so
 * it is testable against a fixture clone tree; the inline copies hardcoded the path and were
 * therefore untested. Replaces the duplicated Class-3 blocks the authors were burned by
 * ("a fix applied to one site is not a fix").
 */
export function landedCommitVerdict(gapId: string, editSite: string): 'pending' | 'present' | null {
  if (typeof gapId !== 'string' || gapId.length < 8) return null;
  const landedVessel = (typeof editSite === 'string' ? editSite : '').match(/^repos\/([^/]+)\//)?.[1] ?? '';
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return null; }
  let nonReverted = 0;
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, '.git'))) continue;
    if (landedVessel && cloneName !== landedVessel) continue;
    try {
      // ALL matching commits (no -1) so re-lands are countable, not just the most recent.
      const gitLog = Bun.spawnSync(['git', '-C', cloneDir, 'log', '--grep', gapId, '--fixed-strings', '--format=%H', '--since=14.days'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
      const shas = gitLog.exitCode === 0 ? new TextDecoder().decode(gitLog.stdout).trim().split(/\s+/).filter(Boolean) : [];
      for (const sha of shas) {
        const subjRaw = Bun.spawnSync(['git', '-C', cloneDir, 'log', '-1', '--format=%s', sha], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
        const subj = subjRaw.exitCode === 0 ? new TextDecoder().decode(subjRaw.stdout).trim() : '';
        // Accept git's default subject `Revert "<subject>"` AND the conventional-commits
        // forms `revert(scope): ...` / `revert: ...`. The default-only test /^Revert[\s"']/i
        // missed a `revert(scope):` subject whose body named the gap id, so that revert was
        // counted as a SECOND landing and flipped the verdict to 'present' — closing the gap it
        // was reverting as already_resolved. Measured 2026-08-23 on route-edit-56849210; pinned
        // by gap-to-feature-reland-verdict.test.ts ("conventional-commits revert(scope):").
        if (/^Revert[\s"']/i.test(subj) || /^revert(\([^)]*\))?:/i.test(subj)) continue;      // the match IS a revert
        if (shaWasRevertedInAnyClone(sha)) continue;     // the match WAS reverted
        nonReverted += 1;
      }
    } catch { /* per-repo failure — continue */ }
  }
  if (nonReverted === 0) return null;
  if (nonReverted >= 2) return 'present';
  return 'pending';
}

export function sweepGitOut(cloneDir: string, args: string[]): string | null {
  let out: string | null = null;
  try {
    const p = Bun.spawnSync(["git", "-C", cloneDir, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (p.exitCode === 0) out = new TextDecoder().decode(p.stdout).trim();
  } catch { /* spawn failed: no output */ }
  return out;
}
