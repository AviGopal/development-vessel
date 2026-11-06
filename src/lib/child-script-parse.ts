/**
 * CHILD SCRIPTS A TEST RUNS, AND WHETHER THEY PARSE (activities development-vessel:test-defect-localization and
 * development-vessel:test-defect-admission). A test that spawns `bun --eval <template literal>` writes the child's source
 * as a template literal in the test file, so an escape in that literal is cooked BEFORE the child parses it: `'active\n'`
 * in the template becomes a real newline inside a single-quoted string, the child dies on "Unterminated string literal",
 * and the parent's JSON.parse of its empty stdout fails. The defect is in the test, but every red the gap's own check
 * prints names the src module the child imports, so the lane drafted src for it, and the only fix (the test) was refused.
 *
 * This module reads one test file's text and nothing else (pure; no fs, no pool): the child scripts passed to
 * `--eval` / `-e` as template literals, cooked the way the runtime cooks them (escapes processed, each `${…}` replaced by
 * one placeholder identifier), each parsed with Bun.Transpiler; which test case each script belongs to; the per-case
 * call a localizer makes from a stored failure; and the certifier an admission gate runs on a parent and a draft text.
 * The certifier is a check DISTINCT from the gap's own check: it runs no test and shares no test name.
 */

export type ChildScript = { offset: number; flag: string; code: string; error: string | null };
export type CaseScripts = { title: string; offset: number; scripts: ChildScript[] };

/** One placeholder per interpolation: an identifier in code position, a plain word inside a string. */
const TPL_PLACEHOLDER = "__tpl__";
const EVAL_FLAG_RE = /(["'])(--eval|-e)\1\s*,\s*`/g;
const CASE_START_RE = /(?<![\w$.])(?:it|test)\s*(?:\.\s*[A-Za-z]+\s*(?:\([^()]*\)\s*)?)?\(\s*(["'`])/g;
const SKIP_MARK_RE = /(?<![\w$.])(?:it|test|describe)\s*\.\s*(?:skip|todo|only|skipIf|todoIf|if)\b/g;

/** The end (index after the closing quote) of a '…' or "…" string starting at `i`. */
function skipQuoted(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === q || src[j] === "\n") return j + 1;
  }
  return src.length;
}
/** The end of a `${` … `}` interpolation whose body starts at `i` (after the `${`). */
function skipInterpolation(src: string, i: number): number {
  let depth = 1;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"') { j = skipQuoted(src, j) - 1; continue; }
    if (c === "`") { j = scanTemplate(src, j + 1).end - 1; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j + 1;
  }
  return src.length;
}
/** A template literal whose body starts at `i` (after the opening backtick): its raw text with each interpolation
 *  replaced by the placeholder, and the index after its closing backtick. */
function scanTemplate(src: string, i: number): { raw: string; end: number } {
  let raw = "";
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { raw += src.slice(j, j + 2); j++; continue; }
    if (c === "`") return { raw, end: j + 1 };
    if (c === "$" && src[j + 1] === "{") { raw += TPL_PLACEHOLDER; j = skipInterpolation(src, j + 2) - 1; continue; }
    raw += c;
  }
  return { raw, end: src.length };
}
/** A template literal's raw text as the runtime cooks it: escapes processed, a line continuation dropped. */
export function cookTemplate(raw: string): string {
  const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") { out += c; continue; }
    const n = raw[i + 1] ?? "";
    i++;
    if (n in simple && !(n === "0" && /[0-9]/.test(raw[i + 1] ?? ""))) { out += simple[n]; continue; }
    if (n === "\r") { if (raw[i + 1] === "\n") i++; continue; }
    if (n === "\n" || n === " " || n === " ") continue;
    if (n === "x" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (n === "u" && raw[i + 1] === "{") {
      const close = raw.indexOf("}", i + 2);
      const hex = close > 0 ? raw.slice(i + 2, close) : "";
      if (/^[0-9a-fA-F]{1,6}$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i = close; continue; }
    }
    if (n === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16)); i += 4; continue; }
    out += n;
  }
  return out;
}
let transpiler: Bun.Transpiler | null = null;
/** Why `code` does not parse as a TS module, or null when it parses. */
export function childScriptParseError(code: string): string | null {
  transpiler ??= new Bun.Transpiler({ loader: "ts" });
  try {
    transpiler.transformSync(code);
    return null;
  } catch (err) {
    const first = String((err as Error)?.message ?? err).split("\n")[0] ?? "";
    return first.trim() || "does not parse";
  }
}
/** The child scripts `src` passes to `--eval` / `-e` as a template literal, each cooked and parsed. */
export function childScripts(src: string): ChildScript[] {
  const out: ChildScript[] = [];
  for (const m of src.matchAll(EVAL_FLAG_RE)) {
    const bodyAt = (m.index ?? 0) + m[0].length;
    const { raw } = scanTemplate(src, bodyAt);
    const code = cookTemplate(raw);
    out.push({ offset: bodyAt, flag: m[2]!, code, error: childScriptParseError(code) });
  }
  return out;
}
/** Each test case (it/test call) in `src` with the child scripts in its body (up to the next case). */
export function caseChildScripts(src: string, scripts: ChildScript[] = childScripts(src)): CaseScripts[] {
  const starts: Array<{ title: string; offset: number }> = [];
  for (const m of src.matchAll(CASE_START_RE)) {
    const q = m[1]!;
    const at = (m.index ?? 0) + m[0].length;
    const end = q === "`" ? scanTemplate(src, at).end - 1 : skipQuoted(src, at - 1) - 1;
    starts.push({ title: src.slice(at, Math.max(at, end)), offset: m.index ?? 0 });
  }
  return starts.map((s, i) => {
    const next = starts[i + 1]?.offset ?? src.length;
    return { title: s.title, offset: s.offset, scripts: scripts.filter((c) => c.offset > s.offset && c.offset < next) };
  });
}

// ── the per-case call (the localizer) ──────────────────────────────────────────────────────────────────────────────
/** A stored failure error that a JS parser raised. A JSON.parse failure is not one: it is what the PARENT prints when
 *  a child died, and also what src that returns bad output causes. */
export const PARSE_ERROR_RE = /\b(?:Unterminated (?:string|template|regular expression)|Unexpected (?:token|end of (?:file|input)|character)|Expected .{1,40} but found|Invalid (?:escape|character|regular expression)|SyntaxError(?!: JSON Parse))/i;
export type TestDefectCaseCall = { name: string; call: "test_defect" | "src" | "unlocated"; parse_error: boolean; unparseable_scripts: number; why: string };
export type TestDefectClassification = { verdict: "test_defect" | "mixed" | "none"; cases: TestDefectCaseCall[] };
/** The case of `src` a failing test's name (" > " path, its leaf the case title) belongs to. */
function caseOf(cases: CaseScripts[], name: string): CaseScripts | null {
  const leaf = name.split(" > ").pop()?.trim() ?? "";
  return cases.find((c) => c.title === leaf) ?? (leaf ? cases.find((c) => leaf.startsWith(c.title.replace(/\$\{[^}]*\}.*$/, "")) && c.title.length > 0) ?? null : null);
}
/**
 * The call for each failing case of a check file, from its stored failures (name, first error line) and the file's
 * text NOW: a case is a test defect only when its stored error is a parse error AND a child script in its own body does
 * not parse. A parse error with every child script of the case parsing came from somewhere else (src, a fixture the
 * text does not show): src. A failure whose case is not in the file: unlocated. The row's verdict is test_defect when
 * EVERY failing case is one, mixed when only some are, none otherwise (no failure: none).
 */
export function classifyTestDefect(src: string, failing: ReadonlyArray<{ name?: unknown; error?: unknown }>): TestDefectClassification {
  const cases = caseChildScripts(src);
  const calls: TestDefectCaseCall[] = [];
  for (const f of failing) {
    const name = String(f?.name ?? "");
    if (!name) continue;
    const parse = PARSE_ERROR_RE.test(String(f?.error ?? ""));
    const c = caseOf(cases, name);
    if (!c) { calls.push({ name, call: "unlocated", parse_error: parse, unparseable_scripts: 0, why: "the case is not in the file" }); continue; }
    const bad = c.scripts.filter((s) => s.error !== null);
    const call = parse && bad.length > 0 ? "test_defect" : "src";
    const why = call === "test_defect" ? `child script does not parse: ${bad[0]!.error}`
      : !parse ? `stored error is not a parse error (${String(f?.error ?? "none").slice(0, 80)})`
      : c.scripts.length === 0 ? "parse error, but the case runs no child script" : "parse error, but every child script of the case parses";
    calls.push({ name, call, parse_error: parse, unparseable_scripts: bad.length, why });
  }
  const n = calls.filter((c) => c.call === "test_defect").length;
  return { verdict: n === 0 ? "none" : n === calls.length ? "test_defect" : "mixed", cases: calls };
}

// ── the certifier (the admission gate) ─────────────────────────────────────────────────────────────────────────────
export type TestFileShape = { cases: number; skip_marks: number; child_scripts: number; unparseable: number };
export function testFileShape(src: string): TestFileShape {
  const scripts = childScripts(src);
  return {
    cases: [...src.matchAll(CASE_START_RE)].length,
    skip_marks: [...src.matchAll(SKIP_MARK_RE)].length,
    child_scripts: scripts.length,
    unparseable: scripts.filter((s) => s.error !== null).length,
  };
}
export const TEST_DEFECT_CERTIFIER_SHAPE = "test_defect_child_parse";
export type TestDefectCertificate = { ok: boolean; reason: string; parent: TestFileShape; draft: TestFileShape };
/**
 * The distinct check for a test_defect row's draft of its test file: red on the parent (a child script does not parse),
 * green on the draft (every child script parses), and nothing the draft could green it by REMOVING: no fewer cases, no
 * added skip/todo/only (or a conditional skip), no fewer child scripts. Expect counts are the compose's own contract
 * check (contractBreach: expect( sites in the check file's source), not repeated here.
 */
export function certifyTestDefectDraft(parentSrc: string, draftSrc: string): TestDefectCertificate {
  const parent = testFileShape(parentSrc), draft = testFileShape(draftSrc);
  const out = (ok: boolean, reason: string): TestDefectCertificate => ({ ok, reason, parent, draft });
  if (parent.unparseable === 0) return out(false, "the parent's child scripts all parse: the certifier is not red on the parent, so it cannot certify this draft");
  if (draft.cases < parent.cases) return out(false, `the draft removes test cases (${parent.cases} -> ${draft.cases})`);
  if (draft.skip_marks > parent.skip_marks) return out(false, `the draft adds skip/todo/only marks (${parent.skip_marks} -> ${draft.skip_marks})`);
  if (draft.child_scripts < parent.child_scripts) return out(false, `the draft removes child scripts (${parent.child_scripts} -> ${draft.child_scripts})`);
  if (draft.unparseable > 0) return out(false, `${draft.unparseable} child script(s) still do not parse on the draft`);
  return out(true, `red on the parent (${parent.unparseable} of ${parent.child_scripts} child scripts do not parse), green on the draft, no case, skip mark or child script removed`);
}
