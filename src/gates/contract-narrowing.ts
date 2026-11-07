// The contract-narrowing gate: a diff that narrows a documented parameter contract without a test of the narrowed case. Lifted as-is from feature-compose.ts.


export interface SemanticGateVerdict {
  addresses: boolean;
  reason: string;
  on_live_path: boolean;
  suspected_real_location?: string;
  // provenance for logging/report
  hard_fail?: boolean;        // true when rejected by reachability alone (no LLM call made)
  llm_consulted: boolean;
  // TRUE only when a REAL (non-fail-open) semantic judgment produced this verdict.
  // Code-set at the parse-success return, NEVER read from model JSON — an LLM cannot
  // inject it. The grader (goal-host favorable-compose) requires verified:true before
  // awarding deterministic:true, so a fail-open FAVORABLE can never earn strong credit.
  verified?: boolean;
  // Deterministic diff-substance (grep-derived, no LLM): changed symbols found reachable
  // on a live path. Surfaced so the grader has a non-LLM reachability signal to require.
  reachable_symbols?: string[];
  // INFRA, NOT A VERDICT: the judge could not judge (an outage, or an answer with no parseable verdict). Code-set,
  // never read from model JSON. A refusal carrying it is a NON-ATTEMPT (semanticGateInfraRefusal): it fails closed,
  // yet it says nothing about the draft, so it is neither charged to the gap nor taught to the next drafter.
  judge_unavailable?: boolean;
  // Set when the fix-standard judge did not run because another standard judged the draft (no_touched, test_writing).
  skipped?: string;
  // The test-writing judgement a skipped:"test_writing" verdict stands on (judgeTestWritingCheck, run at verify).
  test_writing?: { check_file: string; edit_site: string | null; runs: number };
}

// ── A CHANGE THAT NARROWS ITS FILE'S DOCUMENTED CONTRACT NEEDS AN OMISSION OR LIMIT TEST ──────────────────────────
// Three autonomous landings narrowed the contract their own file documents and this gate said addresses:true:
// activity-api d4b09d0 made an OMITTED group_by a refusal (`!GROUP_FIELDS.has(String(input.group_by))`) under a
// header documenting `group_by?: … // default activity_id`; ddf9b46 cut the trace list route's limit clamp 500 -> 100
// under a docstring that still says "max: 500"; and that route's documented filters are silently ignored. Each one
// typechecks and reads to a judge as a fix. The contract is written in the file, so read it — deterministically and
// from the PRE-image only, so a draft cannot rewrite what it is held to — and compare the change against it. A
// narrowing stands only when the change carries a test that exercises the omitted input or the boundary.
// No LLM and no tuning: every bound compared here comes from the file itself.

export type DocumentedParam = { name: string; line: number; max?: number; default?: string; optional: boolean };
export type ContractNarrowing = {
  kind: "lowered_max" | "omitted_refused" | "default_changed" | "handling_removed";
  param: string;
  what: string;
  bound?: number;
  documented_max?: number;
  documented_default?: string;
  /** The function the narrowing sits in, when one is named: a test calling it without the key exercises the omission. */
  fn?: string;
};

const CONTRACT_COMMENT_LINE = /^\s*(?:\/\*\*?|\*|\/\/)/;
const CONTRACT_PARAM_HEADS: RegExp[] = [
  /^\s*(?:(?:\/\*\*?|\*|\/\/)\s*)?-\s*`?([A-Za-z_]\w*)`?\??\s*:/,   // ` * - limit: Max records (default: 50, max: 500)`
  /^\s*(?:(?:\/\*\*?|\*|\/\/)\s*)?([A-Za-z_]\w*)\?\s*:/,             // ` *   group_by?: "a" | "b",   // default a`
  /@param\s+(?:\{[^}]*\}\s*)?\[([A-Za-z_]\w*)/,                   // `@param {number} [limit=10]`
];
const CONTRACT_MAX_RES: RegExp[] = [
  /\bmax(?:imum)?\b\s*(?:[:=]\s*)?(\d+)/i,
  /\bat most\s+(\d+)/i,
  /\bclamped\s*(?:to\s*)?\[\s*-?\d+\s*,\s*(\d+)\s*\]/i,
  /\b(?:up to|limited to|capped at)\s+(\d+)/i,
];
const CONTRACT_DEFAULT_RE = /\bdefaults?\b(?:\s+to\b)?\s*(?:[:=]\s*)?[`'"]?([A-Za-z0-9_.-]+)/i;
// Omission words, read only in a test's TITLE beside the parameter: a word anywhere else (a value, a comment) is not a test.
const CONTRACT_OMIT_WORDS = /\b(?:omit\w*|absent|missing|undefined|without|unset)\b/i;

function contractEsc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
/** The code part of a line: a comment line has none, and a trailing `//` comment is dropped. */
export function contractCode(l: string): string {
  return CONTRACT_COMMENT_LINE.test(l) ? "" : l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1");
}
/** A read of the parameter itself (input.p, query('p'), ['p']): what an omitted input reaches. */
function contractAccessRe(p: string): RegExp {
  const e = contractEsc(p);
  return new RegExp(`(?:\\.${e}\\b|\\[\\s*['"\`]${e}['"\`]\\s*\\]|\\(\\s*['"\`]${e}['"\`]\\s*[,)])`);
}
/**
 * A read including destructuring — `const { p } = input`, `{ p: raw } = …`, a parameter `({ p = 10 }: T) =>` or
 * `handle({ p }: T) {` — which handling_removed asks. An object literal ARGUMENT (`f({ p: 1 })`) passes p, it does not
 * read it, so it is not a read: counting it would hide a dropped read behind any call that sets the key, and would
 * make a removed outgoing call look like a dropped one.
 */
function contractReadRe(p: string): RegExp {
  const e = contractEsc(p);
  const pattern = `\\{[^{}]*(?:^|[{,\\s])${e}\\s*(?=[:=,}])[^{}]*\\}`;
  // The annotation is `[^)]*` after its colon: one run, so no two whitespace quantifiers are ever adjacent (a long
  // run of spaces around a `:` backtracked polynomially, and a regex that hangs does not throw, so it would not fail
  // closed — it would block the event loop on every landing of that file).
  return new RegExp(`(?:${contractAccessRe(p).source}|${pattern}\\s*=(?![=>])|${pattern}(?:\\s*:[^)]*|\\s*)\\)\\s*(?::[^=;{]*)?(?:=>|\\{))`);
}
/** Any mention: a read, the bare name, or a local derived from it (limitParam, groupBy). */
function contractMentionRe(p: string): RegExp {
  const camel = p.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const forms = [...new Set([p, camel])].map(contractEsc).join("|");
  return new RegExp(`(?:\\b(?:${forms})(?:[A-Z_]\\w*)?\\b|${contractAccessRe(p).source})`);
}

/**
 * The contract a file documents about its own inputs, read from its comments: each documented parameter (a
 * `- name:` list item, a `name?:` contract line, an `@param [name]`) with the maximum ("max: N", "at most N",
 * "clamped [a, N]", "up to N") and the default ("default X", "defaults to X") written beside it. A listed filter
 * with neither is still documented: dropping its handling narrows the contract too.
 */
export function documentedContract(pre: string): DocumentedParam[] {
  const out: DocumentedParam[] = [];
  const lines = String(pre ?? "").split("\n");
  lines.forEach((l, i) => {
    const isComment = CONTRACT_COMMENT_LINE.test(l);
    const trailing = isComment ? "" : (l.match(/(?:^|[^:"'`\\])\/\/(.*)$/)?.[1] ?? "");
    if (!isComment && !trailing) return;
    const doc = isComment ? l : trailing;
    let name = "";
    for (const re of CONTRACT_PARAM_HEADS) { const m = l.match(re); if (m?.[1]) { name = m[1]; break; } }
    if (!name) return;
    let max: number | undefined;
    for (const re of CONTRACT_MAX_RES) { const m = doc.match(re); if (m?.[1]) { max = Number(m[1]); break; } }
    const def = doc.match(CONTRACT_DEFAULT_RE)?.[1];
    const optional = /\?\s*:/.test(l) || /@param\s+(?:\{[^}]*\}\s*)?\[/.test(l) || /\boptional\b/i.test(doc) || def !== undefined;
    out.push({ name, line: i, ...(max !== undefined ? { max } : {}), ...(def !== undefined ? { default: def } : {}), optional });
  });
  return out;
}

/** Upper bounds a code line imposes: Math.min's literal arguments (Math.max's are lower bounds), clamp's last, SQL LIMIT. */
function contractUpperBounds(code: string): number[] {
  const out: number[] = [];
  // Math.max's arguments are lower bounds, nested calls and all (`Math.max(parseInt(x, 10), 1)`): cut each whole call.
  let noMax = code;
  for (let at = noMax.indexOf("Math.max("); at >= 0; at = noMax.indexOf("Math.max(")) {
    const inner = contractBalanced(noMax, at + "Math.max".length);
    noMax = noMax.slice(0, at) + noMax.slice(at + "Math.max".length + inner.length + 2);
  }
  for (const m of noMax.matchAll(/Math\.min\(([^;]*)\)/g)) for (const n of (m[1] ?? "").matchAll(/(?<![\w.$])(\d+)(?![\w.])/g)) out.push(Number(n[1]));
  for (const m of code.matchAll(/\bclamp\w*\(([^;]*)\)/gi)) {
    const last = (m[1] ?? "").split(",").pop()?.replace(/\).*$/, "").trim() ?? "";
    if (/^\d+$/.test(last)) out.push(Number(last));
  }
  for (const m of code.matchAll(/\bLIMIT\s+(\d+)\b/g)) out.push(Number(m[1]));
  return out;
}

/** Indices of `of`'s lines that `against` does not account for (a multiset difference, so order-independent). */
export function contractUnmatched(of: string[], against: string[]): number[] {
  const count = new Map<string, number>();
  for (const l of against) count.set(l, (count.get(l) ?? 0) + 1);
  const out: number[] = [];
  of.forEach((l, i) => { const n = count.get(l) ?? 0; if (n > 0) count.set(l, n - 1); else out.push(i); });
  return out;
}

/** The text inside the parenthesis opened at `open`, or the rest of the string when it does not close. */
function contractBalanced(s: string, open: number): string {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === "(") depth++;
    else if (s[k] === ")" && --depth === 0) return s.slice(open + 1, k);
  }
  return s.slice(open + 1);
}

/** True when an omitted `p` makes `cond` true: a negated read of it, `=== undefined`, or `typeof … !== '<type>'`. */
function contractTruthyWhenAbsent(cond: string, p: string): boolean {
  const e = contractEsc(p);
  const access = contractAccessRe(p);
  if (new RegExp(`\\.${e}\\s*===?\\s*(?:undefined|null)\\b`).test(cond)) return true;
  if (new RegExp(`typeof\\s+[\\w$.]*\\.${e}\\s*!==?\\s*['"\`](?!undefined)`).test(cond)) return true;
  for (let k = 0; k < cond.length; k++) {
    if (cond[k] !== "!" || cond[k + 1] === "=" || cond[k - 1] === "!" || cond[k + 1] === "!") continue;
    let j = k + 1;
    while (cond[j] === " ") j++;
    let operand: string;
    if (cond[j] === "(") operand = contractBalanced(cond, j);
    else {
      const head = cond.slice(j).match(/^[\w$.]+/)?.[0] ?? "";
      operand = head;
      let at = j + head.length;
      while (cond[at] === "(") { const inner = contractBalanced(cond, at); operand += `(${inner})`; at += inner.length + 2; const tail = cond.slice(at).match(/^\.[\w$.]+/)?.[0] ?? ""; operand += tail; at += tail.length; }
    }
    if (access.test(operand)) return true;
  }
  return false;
}

/** True when `cond` cannot fire for an omitted `p`: it tests presence first, or applies the documented default. */
function contractAbsenceGuarded(cond: string, p: string, def: string | undefined): boolean {
  const e = contractEsc(p);
  if (new RegExp(`\\.${e}\\s*!==?\\s*(?:undefined|null)\\b`).test(cond)) return true;
  if (new RegExp(`typeof\\s+[\\w$.]*\\.${e}\\s*!==?\\s*['"\`]undefined`).test(cond)) return true;
  if (new RegExp(`\\.${e}\\s*&&`).test(cond)) return true;
  if (new RegExp(`['"\`]${e}['"\`]\\s+in\\s`).test(cond)) return true;
  if (def !== undefined && new RegExp(`\\.${e}\\s*(?:\\?\\?|\\|\\|)\\s*['"\`]?${contractEsc(def)}\\b`).test(cond)) return true;
  return false;
}

/** The documented entry for `p` nearest above line `at` that carries `field`, else the tightest one in the file. */
function contractNearest(doc: DocumentedParam[], p: string, at: number | null, field: "max" | "default"): DocumentedParam | undefined {
  const own = doc.filter((d) => d.name === p && d[field] !== undefined);
  if (own.length === 0) return undefined;
  if (at !== null) { const above = own.filter((d) => d.line < at); if (above.length > 0) return above[above.length - 1]; }
  return field === "max" ? own.reduce((a, b) => ((b.max ?? Infinity) < (a.max ?? Infinity) ? b : a)) : own[0];
}

/** The nearest named function at or above line `at` (function NAME / const NAME = (…) => / async NAME(…) {). */
function contractEnclosingFn(lines: string[], at: number): string | undefined {
  for (let i = at; i >= 0; i--) {
    const m = (lines[i] ?? "").match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/);
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

/**
 * Where a change narrows the contract its file documents (the pre-image's comments, documentedContract):
 * a clamp that LOWERS a documented maximum; a new branch that returns or throws when a documented-optional input is
 * omitted; a documented default replaced; a documented parameter no longer read at all. Static, deterministic.
 */
export function contractNarrowings(pre: string, post: string): ContractNarrowing[] {
  const doc = documentedContract(pre);
  if (doc.length === 0) return [];
  const preL = String(pre).split("\n");
  const postL = String(post ?? "").split("\n");
  const added = contractUnmatched(postL, preL);
  const removed = contractUnmatched(preL, postL);
  const names = [...new Set(doc.map((d) => d.name))];
  const out: ContractNarrowing[] = [];
  for (const p of names) {
    const mention = contractMentionRe(p);
    const access = contractAccessRe(p);
    // (1) A clamp that lowers the documented maximum. Only a REPLACED clamp is compared — the same line with its
    // literals changed — and against the maximum documented above the line it replaced (one file can document the
    // same parameter on several routes). A new handler with its own cap narrows nothing it documented.
    if (doc.some((d) => d.name === p && d.max !== undefined)) {
      const shape = (l: string) => contractCode(l).replace(/\d+/g, "#").trim();
      const removedClamps = removed.filter((r) => mention.test(contractCode(preL[r]!)) && contractUpperBounds(contractCode(preL[r]!)).length > 0);
      const used = new Set<number>();
      for (const a of added) {
        const code = contractCode(postL[a]!);
        if (!mention.test(code)) continue;
        const bounds = contractUpperBounds(code);
        if (bounds.length === 0) continue;
        const bound = Math.min(...bounds);
        const r = removedClamps.find((x) => !used.has(x) && shape(preL[x]!) === shape(postL[a]!));
        if (r === undefined) continue;
        used.add(r);
        const documented = contractNearest(doc, p, r, "max")?.max;
        const before = Math.min(...contractUpperBounds(contractCode(preL[r]!)));
        if (documented !== undefined && bound < documented && bound < before) {
          out.push({ kind: "lowered_max", param: p, what: `${p} max ${documented} -> ${bound}`, bound, documented_max: documented });
        }
      }
    }
    // (2) A new early exit taken when a documented-optional input is omitted.
    const optional = doc.find((d) => d.name === p && d.optional);
    if (optional) {
      const def = contractNearest(doc, p, null, "default")?.default;
      for (const a of added) {
        const code = contractCode(postL[a]!);
        const m = code.match(/^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/);
        if (!m) continue;
        const open = code.indexOf("(", m[0].length - 1);
        const cond = contractBalanced(code, open);
        if (!access.test(cond) || contractAbsenceGuarded(cond, p, def) || !contractTruthyWhenAbsent(cond, p)) continue;
        const rest = code.slice(open + cond.length + 2);
        let exits = /\b(?:return|throw)\b/.test(rest);
        if (!exits) {
          const next = postL.slice(a + 1, a + 4).map(contractCode).find((l) => l.trim() !== "");
          exits = !!next && /^\s*(?:return|throw)\b/.test(next);
        }
        const fn = contractEnclosingFn(postL, a);
        if (exits) out.push({ kind: "omitted_refused", param: p, what: `omitted ${p}${def !== undefined ? ` (documented default ${def})` : ""} now returns early`, ...(def !== undefined ? { documented_default: def } : {}), ...(fn ? { fn } : {}) });
      }
    }
    // (3) A documented default replaced: a removed read of p that applied it, and no line left applying it.
    const postMentions = postL.filter((l) => mention.test(contractCode(l)));
    for (const r of removed) {
      const code = contractCode(preL[r]!);
      if (!access.test(code)) continue;
      const def = contractNearest(doc, p, r, "default")?.default;
      if (def === undefined) continue;
      const lit = /^\d+$/.test(def) ? new RegExp(`(?<![\\w.])${contractEsc(def)}(?![\\w.])`) : new RegExp(`['"\`]${contractEsc(def)}['"\`]`);
      if (!lit.test(code)) continue;
      if (postMentions.length > 0 && !postMentions.some((l) => lit.test(contractCode(l)))) {
        out.push({ kind: "default_changed", param: p, what: `${p} default ${def} replaced`, documented_default: def });
        break;
      }
    }
    // (4) A documented parameter the pre-image read (input.p, query('p'), a destructuring) and the post-image never reads.
    const read = contractReadRe(p);
    if (preL.some((l) => read.test(contractCode(l))) && !postL.some((l) => read.test(contractCode(l)))) {
      out.push({ kind: "handling_removed", param: p, what: `documented ${p} no longer handled` });
    }
  }
  return out;
}

/**
 * Does the test text the change ADDED (contractAddedTestText) exercise this narrowing?
 *   - a lowered maximum: a line naming the parameter with a value past the new bound, and the bound itself within
 *     two lines (the probe and the expectation);
 *   - an omitted or defaulted input: a test whose TITLE names the parameter and the omission (omit / absent /
 *     missing / undefined / without / unset), or a call to the narrowed function with an object argument that
 *     lacks the key. A bare value — an explicit `group_by: 'activity_id'`, the default literal — is the opposite of
 *     an omission and is not evidence;
 *   - a dropped parameter: an added line naming it.
 */
export function contractNarrowingTested(n: ContractNarrowing, checkText: string): boolean {
  const text = String(checkText ?? "");
  const lines = text.split("\n").map(contractCode);
  const mention = contractMentionRe(n.param);
  if (n.kind === "handling_removed") return lines.some((l) => mention.test(l));
  if (n.kind === "lowered_max") {
    const bound = n.bound ?? Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (!mention.test(lines[i]!)) continue;
      const nums = (l: string) => [...l.matchAll(/(?<![\w.])(\d+)(?![\w.])/g)].map((m) => Number(m[1]));
      if (!nums(lines[i]!).some((x) => x > bound)) continue;
      const win = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
      if (new RegExp(`(?<![\\w.])${bound}(?![\\w.])`).test(win)) return true;
    }
    return false;
  }
  for (const l of lines) {
    const title = l.match(/\b(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])((?:(?!\1).)*)\1/)?.[2];
    if (title && mention.test(title) && CONTRACT_OMIT_WORDS.test(title)) return true;
  }
  if (n.fn) {
    const code = lines.join("\n");
    const keyRe = new RegExp(`(?:^|[{,\\s])['"\`]?${contractEsc(n.param)}['"\`]?\\s*:`);
    for (let at = code.indexOf(`${n.fn}(`); at >= 0; at = code.indexOf(`${n.fn}(`, at + 1)) {
      if (/[\w$]/.test(code[at - 1] ?? "")) continue;
      // The call's TOP-LEVEL object arguments, string values blanked first (a `${…}` or a brace inside a string is
      // not an object); a quoted key is kept.
      const args = contractBalanced(code, at + n.fn.length).replace(/'(?:[^'\\]|\\.)*'(?!\s*:)|"(?:[^"\\]|\\.)*"(?!\s*:)|`(?:[^`\\]|\\.)*`(?!\s*:)/g, '""');
      const objects: string[] = [];
      for (let k = 0, depth = 0, open = -1; k < args.length; k++) {
        if (args[k] === "{" && depth++ === 0) open = k;
        else if (args[k] === "}" && depth > 0 && --depth === 0) objects.push(args.slice(open, k + 1));
      }
      if (objects.length > 0 && objects.every((o) => !keyRe.test(o))) return true;
    }
  }
  return false;
}

/**
 * The gate's verdict on the documented contract: null when nothing is narrowed or every narrowing carries its test;
 * otherwise addresses:false, deterministic (hard_fail, verified), naming each untested narrowing.
 */
export function contractNarrowingRefusal(files: Array<{ path: string; pre: string; post: string }>, checkText: string): SemanticGateVerdict | null {
  const untested: string[] = [];
  let narrowings = 0;
  for (const f of files) {
    if (!f.pre || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f.path)) continue;
    for (const n of contractNarrowings(f.pre, f.post)) {
      narrowings++;
      if (!contractNarrowingTested(n, checkText)) untested.push(`${n.what} in ${f.path.replace(/^.*\/repos\//, "")}`);
    }
  }
  if (narrowings > 0) console.log(`[fc-contract-narrowing] ${JSON.stringify({ narrowings, untested: untested.length, refused: untested })}`);
  if (untested.length === 0) return null;
  return {
    addresses: false,
    reason: `${untested.map((u) => `narrows_documented_contract:${u} (no omission/limit test)`).join("; ")} — keep the contract the file documents, or carry a test that exercises the omitted input or the boundary`,
    on_live_path: true,
    hard_fail: true,
    llm_consulted: false,
    verified: true,
  };
}
