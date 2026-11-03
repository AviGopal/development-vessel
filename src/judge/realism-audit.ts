/**
 * REALISM AUDIT (lane core; the user's ruling, the cheapest version, ADVISORY). A drafted check can go
 * red-then-green, and a drafted fix can pass its own check and every landing gate, while exercising an input or a field
 * that production never sends or returns. Three hollow landings in one week did exactly that, each green at landing:
 * - a check posted a request its entry's own parser refuses (it omitted pointer.type);
 * - a fix read a field the callee's declared type does not have, through an `as unknown as {…}` cast;
 * - a fix set a verdict field to a boolean literal.
 * Nothing at landing tested whether the check's inputs or the fix's reads match what production produces.
 *
 * ONE activity, realism_audit, run at landing verify (feature-compose, after the own check is green, before the
 * semantic gate chain). Its output is one realismVerdict {gap_id, verdict: realistic|unrealistic|unknown, signals[]}.
 * ADVISORY: it refuses nothing. The verdict is logged, carried in the compose's verify evidence (the repair prompt
 * names it), and posted as a trace so it is gradable. The judge (self-fact-reconcile) does NOT read it in this build.
 *
 * THREE PROBES, each over the TypeScript syntax tree (no text patterns):
 * - ENTRY KEY (check side). A check that sends a Request into an imported route module is bound to that route's OWN
 *   parser. The probe derives the keys the parser refuses a request without: each `if (<presence test>) return
 *   c.json(…, 4xx)` guard at the top of the handler, on a path rooted at `c.req.json()`, following aliases such as
 *   `body?.impulse?.pointer ?? body?.pointer`. A check request literal that satisfies NONE of a required key's
 *   alternatives is a request production never serves. Where the edit site sits on that path is not a condition:
 *   realism is about the request, not the fix. A route or handler that cannot be located answers unknown, never
 *   unrealistic. This is bound to the parser, not to syntax: a top-level `shape:` literal in a check reads 4/5 false
 *   positives over a week of landed checks.
 * - MASKED CALLEE (fix side). A structural cast through `unknown` (`x as unknown as {…}`, `(x as unknown) as {…}`) on a
 *   line the fix ADDED, whose operand is an imported or dynamically imported module, hides the callee's real type.
 *   The probe blanks the cast text, keeping every other character in place, and typechecks that copy IN MEMORY: the
 *   compiler host serves the copy from a map and nothing is written. That is the throwaway copy, without touching the
 *   draft's tree. Only diagnostics the strip introduces count, for example "Property 'recordId' does not exist on type".
 * - CONSTANT VERDICT (fix side). An added boolean literal on a verdict-named field (the policy's globs: *verified*,
 *   *_ok, passed, reached, valid) in an object that also holds computed members, not under any branch of its own
 *   function, is a verdict that cannot depend on what it claims to judge. `enabled: true` and `dry_run: true` never
 *   match: they are not verdict names.
 *
 * GRADED BY PLANTED CONTROLS (the judge's planted-control pattern). Every run first reproduces five closed fixtures
 * kept here, excerpts of the measured cases:
 * - three must read unrealistic, each by its named probe;
 * - two (an honest real-import fix with its check, and an honest check) must read realistic.
 * A run that does not reproduce every fixture of an enabled probe reads `unknown` (unjudged), whatever it found.
 *
 * RULES ARE SHAPED (law 1). The probe set, the verdict-field globs, the cast types, the counted diagnostic codes and
 * the time budget are read from the realismPolicy policy at use time; the defaults below apply only when it is absent.
 * A present but broken policy decides nothing: the verdict is unknown. The reader is this module's own (the shaped
 * policies directory of the live super clone, located by the closed write-containment zones, with the shared policy
 * rules: unknown keys and out-of-range fields refuse the whole policy). It is not the open signal-window reader: a
 * lane-core module imports only closed files, so the lane cannot loosen how its rules are read.
 *
 * SOAK (the user's ruling): advisory for 20 graded landings or 7 days, whichever is later. Promotion to a refusal goes
 * back to the user. REMOVAL DEBT: the cast and verdict-name rules are lexical in kind. They retire into the dynamic
 * version (replay over recorded real inputs), which judges behaviour, not text.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import type TS from "typescript";
import { containmentZones } from "../resolvers/write-containment.js";

export type RealismProbe = "entry_key" | "masked_callee" | "constant_verdict";
export const REALISM_PROBES: readonly RealismProbe[] = ["entry_key", "masked_callee", "constant_verdict"];
export type RealismSignal = { probe: RealismProbe; detail: string; file: string; line: number };
export type RealismVerdictValue = "realistic" | "unrealistic" | "unknown";
/** A probe's state on one audit: clean, flagged, not_applicable (nothing it reads was present), disabled, or unknown: <why>. */
export type ProbeState = string;
export type RealismVerdict = {
  shape: "realismVerdict";
  gap_id: string | null;
  vessel: string | null;
  verdict: RealismVerdictValue;
  signals: RealismSignal[];
  probes: Record<RealismProbe, ProbeState>;
  planted: { reproduced: number; of: number; failed: string[] };
  policy: "policy" | "default" | "invalid";
  ms: number;
  why?: string;
};
export type RealismFile = { path: string; text: string };
export type RealismFixFile = { path: string; pre: string | null; post: string };
export type RealismInput = {
  gap_id: string | null;
  vessel: string | null;
  /** The check(s) the landing is verified by, vessel-relative. */
  checks: RealismFile[];
  /** The fix's changed non-test files, vessel-relative; pre null for a created file. Empty for a check-only compose. */
  fix: RealismFixFile[];
  /** Reads a vessel-relative file of the audited tree (route modules, callees), or null. */
  read: (rel: string) => string | null;
  /** The audited tree on disk, for typechecking with its tsconfig and node_modules; null = files from `read` only. */
  root: string | null;
};

// ── the policy ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const REALISM_POLICY_NAME = "realismPolicy";
export interface RealismPolicy {
  /** The probes that run: any of entry_key, masked_callee, constant_verdict. */
  enabled_probes: string[];
  /** Field names a verdict lives in, as lowercase token globs, matched against the lowercased property name. */
  verdict_field_globs: string[];
  /** The types a structural cast passes through to hide its operand's type (`x as unknown as T`). */
  cast_through_types: string[];
  /** The TypeScript diagnostic codes that, introduced by stripping a cast, read as a masked read. */
  masked_callee_diagnostics: string[];
  /** Past this many ms a probe that has not started reads unknown (the audit never holds a landing past it). */
  budget_ms: number;
}
/** The documented defaults: what the design measured with (0 false positives over a week of source landings). */
export const DEFAULT_REALISM_POLICY: RealismPolicy = {
  enabled_probes: ["entry_key", "masked_callee", "constant_verdict"],
  verdict_field_globs: ["*verified*", "*_ok", "passed", "reached", "valid"],
  cast_through_types: ["unknown"],
  masked_callee_diagnostics: ["2339", "2551"],
  budget_ms: 60_000,
};
type PolicyField = { kind: "int"; min: number; max: number } | { kind: "globs"; max_items: number } | { kind: "literals"; max_items: number; max_len: number };
export const REALISM_POLICY_SPEC: { [K in keyof RealismPolicy]: PolicyField } = {
  enabled_probes: { kind: "literals", max_items: 8, max_len: 40 },
  verdict_field_globs: { kind: "globs", max_items: 32 },
  cast_through_types: { kind: "literals", max_items: 4, max_len: 16 },
  masked_callee_diagnostics: { kind: "literals", max_items: 16, max_len: 8 },
  budget_ms: { kind: "int", min: 1_000, max: 600_000 },
};
export type RealismPolicyRead = { ok: true; policy: RealismPolicy; source: "policy" | "default"; path: string | null } | { ok: false; why: string; path: string | null };
const GLOB = /^[a-z0-9_*-]{1,64}$/;
const fieldOk = (v: unknown, f: PolicyField): boolean =>
  f.kind === "int" ? typeof v === "number" && Number.isInteger(v) && v >= f.min && v <= f.max
    : Array.isArray(v) && v.length <= f.max_items && v.every((g) => typeof g === "string" && (f.kind === "globs" ? GLOB.test(g) : g.length > 0 && g.length <= f.max_len));
/** A policy object against REALISM_POLICY_SPEC, absent fields from the defaults; fails closed on a non-object, an
 *  unknown key (reason and note are kept for the record) or any present field out of range. */
export function validateRealismPolicy(raw: unknown): { ok: true; policy: RealismPolicy } | { ok: false; why: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "policy is not an object" };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!Object.hasOwn(REALISM_POLICY_SPEC, k) && k !== "reason" && k !== "note") return { ok: false, why: `unknown policy key "${k}"` };
  const out = structuredClone(DEFAULT_REALISM_POLICY) as unknown as Record<string, unknown>;
  for (const k of Object.keys(REALISM_POLICY_SPEC) as Array<keyof RealismPolicy>) {
    if (!Object.hasOwn(o, k)) continue;
    if (!fieldOk(o[k], REALISM_POLICY_SPEC[k])) return { ok: false, why: `policy field "${k}" is out of range or of the wrong type` };
    out[k] = Array.isArray(o[k]) ? [...(o[k] as unknown[])] : o[k];
  }
  return { ok: true, policy: out as unknown as RealismPolicy };
}
/** `<live super clone>/policies/realismPolicy.json`, read now. Absent (or no clone): the documented defaults.
 *  Present but unreadable, unparseable or invalid: not ok, and the audit reads unknown. */
export async function readRealismPolicy(env: Record<string, string | undefined> = process.env): Promise<RealismPolicyRead> {
  const superRepo = containmentZones(env as never).supers[0];
  if (!superRepo) return { ok: true, policy: structuredClone(DEFAULT_REALISM_POLICY), source: "default", path: null };
  const path = join(superRepo, "policies", `${REALISM_POLICY_NAME}.json`);
  let raw: string;
  try { raw = await readFile(path, "utf-8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, policy: structuredClone(DEFAULT_REALISM_POLICY), source: "default", path };
    return { ok: false, why: `${REALISM_POLICY_NAME} unreadable: ${String((e as Error)?.message ?? e).slice(0, 160)}`, path };
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, why: `${REALISM_POLICY_NAME} is not valid JSON`, path }; }
  const v = validateRealismPolicy(value);
  return v.ok ? { ok: true, policy: v.policy, source: "policy", path } : { ok: false, why: `${REALISM_POLICY_NAME}: ${v.why}`, path };
}
/** A lowercase token glob (`*` any run) against a lowercased name, anchored at both ends. */
export function globMatches(glob: string, name: string): boolean {
  const parts = glob.split("*");
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (i === 0) { if (!name.startsWith(p)) return false; at = p.length; continue; }
    if (i === parts.length - 1) return p === "" || (name.length - p.length >= at && name.endsWith(p));
    const k = name.indexOf(p, at);
    if (k < 0) return false;
    at = k + p.length;
  }
  return at === name.length;
}

// ── the parser ─────────────────────────────────────────────────────────────────────────────────────────────────────
type TsModule = typeof import("typescript");
let tsMod: TsModule | null | undefined;
let tsLoader: () => TsModule | null = () => createRequire(import.meta.url)("typescript") as TsModule;
function loadTs(): TsModule | null {
  if (tsMod === undefined) { try { tsMod = tsLoader(); } catch { tsMod = null; } }
  return tsMod;
}
/** Test seam: replace the parser's loader (null restores it). */
export function __setRealismTsLoaderForTests(f: (() => TsModule | null) | null): void {
  tsLoader = f ?? (() => createRequire(import.meta.url)("typescript") as TsModule);
  tsMod = undefined;
}
const parse = (ts: TsModule, path: string, text: string): TS.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (sf: TS.SourceFile, pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
const unwrap = (ts: TsModule, e: TS.Expression): TS.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isAwaitExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return x;
};
const propName = (ts: TsModule, n: TS.PropertyName | TS.MemberName): string | null =>
  ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text : ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;

/** The post lines a change ADDED: each post line not matched by an equal pre line (multiset, trimmed). A created file is all added. */
export function addedLines(pre: string | null, post: string): Set<number> {
  const out = new Set<number>();
  const lines = post.split("\n");
  if (pre === null) { lines.forEach((_, i) => out.add(i + 1)); return out; }
  const left = new Map<string, number>();
  for (const l of pre.split("\n")) { const k = l.trim(); left.set(k, (left.get(k) ?? 0) + 1); }
  lines.forEach((l, i) => {
    const k = l.trim();
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1); else out.add(i + 1);
  });
  return out;
}

// ── probe: entry key ───────────────────────────────────────────────────────────────────────────────────────────────
/** A request literal, as far as the check's text fixes it. "open" = a key may be present that the text does not show. */
type Lit = { kind: "obj"; keys: Map<string, Lit>; open: boolean } | { kind: "leaf" } | { kind: "unknown" };
/** One key the entry's parser refuses a request without: any one alternative path satisfies it. */
type Required = { alts: string[][]; line: number; message: string | null };

function evalLiteral(ts: TsModule, sf: TS.SourceFile, e: TS.Expression, depth = 0): Lit {
  const x = unwrap(ts, e);
  if (depth > 6) return { kind: "unknown" };
  if (ts.isObjectLiteralExpression(x)) {
    const keys = new Map<string, Lit>();
    let open = false;
    for (const p of x.properties) {
      if (ts.isPropertyAssignment(p)) { const k = propName(ts, p.name); if (k === null) open = true; else keys.set(k, evalLiteral(ts, sf, p.initializer, depth + 1)); }
      else if (ts.isShorthandPropertyAssignment(p)) keys.set(p.name.text, resolveIdent(ts, sf, p.name, depth + 1));
      else open = true; // a spread or a computed key: the literal may carry more than it shows
    }
    return { kind: "obj", keys, open };
  }
  if (ts.isIdentifier(x)) return resolveIdent(ts, sf, x, depth + 1);
  if (ts.isStringLiteralLike(x) || ts.isNumericLiteral(x) || ts.isPrefixUnaryExpression(x) || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword || ts.isArrayLiteralExpression(x)) return { kind: "leaf" };
  return { kind: "unknown" };
}
/** The const declaration `ref` reads: the nearest enclosing block (or the file) that declares the name, when that is a
 *  const with an initializer. "other" for a parameter, a destructured or loop binding, or a let/var; null when none. */
function declAt(ts: TsModule, sf: TS.SourceFile, ref: TS.Identifier): TS.VariableDeclaration | "other" | null {
  const name = ref.text;
  const declIn = (stmts: readonly TS.Statement[]): TS.VariableDeclaration | "other" | null => {
    for (const st of stmts) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer && (st.declarationList.flags & ts.NodeFlags.Const) ? d : "other";
        if (!ts.isIdentifier(d.name) && d.name.getText(sf).includes(name)) return "other";
      }
    }
    return null;
  };
  for (let cur: TS.Node | undefined = ref.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters.some((p) => p.name.getText(sf).includes(name))) return "other";
    if ((ts.isForOfStatement(cur) || ts.isForInStatement(cur) || ts.isForStatement(cur)) && cur.initializer && cur.initializer.getText(sf).includes(name)) return "other";
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur)) {
      const d = declIn(cur.statements);
      if (d) return d;
    }
  }
  return null;
}
/** A name's value where `ref` reads it (declAt); anything but a const initializer is unknown. */
function resolveIdent(ts: TsModule, sf: TS.SourceFile, ref: TS.Identifier, depth: number): Lit {
  const d = declAt(ts, sf, ref);
  return d && d !== "other" ? evalLiteral(ts, sf, d.initializer!, depth) : { kind: "unknown" };
}
/** Whether a request literal has a key path: yes, no, or maybe (the text does not fix it). */
function hasPath(lit: Lit, path: readonly string[]): "yes" | "no" | "maybe" {
  let cur: Lit = lit;
  for (const k of path) {
    if (cur.kind === "unknown") return "maybe";
    if (cur.kind === "leaf") return "no";
    const next = cur.keys.get(k);
    if (!next) return cur.open ? "maybe" : "no";
    cur = next;
  }
  return cur.kind === "unknown" ? "maybe" : "yes";
}

type Sent = { method: string; url: string; body: Lit; line: number; module: string; exported: string };
/** The requests a check sends into an IMPORTED route module: `new Request(url, {method, body: JSON.stringify(x)})`
 *  handed to `<import>.<app>.fetch(...)` (or `<app>.fetch`), and `<app>.request(url, {method, body})`. */
function sentRequests(ts: TsModule, sf: TS.SourceFile): Sent[] {
  const imports = new Map<string, { spec: string; ns: boolean; name: string }>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause) continue;
    const spec = s.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const nb = s.importClause.namedBindings;
    if (s.importClause.name) imports.set(s.importClause.name.text, { spec, ns: false, name: "default" });
    if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, { spec, ns: true, name: "" });
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.set(el.name.text, { spec, ns: false, name: (el.propertyName ?? el.name).text });
  }
  /** The `new Request(...)` a name holds where it is read (declAt), or null. */
  const requestAt = (ref: TS.Identifier): TS.NewExpression | null => {
    const d = declAt(ts, sf, ref);
    const ne = d && d !== "other" ? unwrap(ts, d.initializer!) : null;
    return ne && ts.isNewExpression(ne) && ts.isIdentifier(ne.expression) && ne.expression.text === "Request" ? ne : null;
  };
  const fromInit = (url: TS.Expression | undefined, init: TS.Expression | undefined): { method: string; url: string; body: Lit } | null => {
    if (!url || !ts.isStringLiteralLike(unwrap(ts, url))) return null;
    const u = (unwrap(ts, url) as TS.StringLiteralLike).text;
    let method = "GET";
    let body: Lit = { kind: "unknown" };
    const i = init ? unwrap(ts, init) : undefined;
    if (i && ts.isObjectLiteralExpression(i)) {
      for (const p of i.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const k = propName(ts, p.name);
        const v = unwrap(ts, p.initializer);
        if (k === "method" && ts.isStringLiteralLike(v)) method = v.text.toUpperCase();
        if (k === "body" && ts.isCallExpression(v) && ts.isPropertyAccessExpression(v.expression) && v.expression.name.text === "stringify" && v.arguments[0]) body = evalLiteral(ts, sf, v.arguments[0]);
      }
    }
    return { method, url: u.replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0]!, body };
  };
  const target = (callee: TS.Expression): { module: string; exported: string } | null => {
    // <ns>.<app>.fetch | <app>.fetch with <app> a named import
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const obj = unwrap(ts, callee.expression);
    if (ts.isPropertyAccessExpression(obj) && ts.isIdentifier(obj.expression)) { const im = imports.get(obj.expression.text); if (im?.ns) return { module: im.spec, exported: obj.name.text }; }
    if (ts.isIdentifier(obj)) { const im = imports.get(obj.text); if (im && !im.ns) return { module: im.spec, exported: im.name }; }
    return null;
  };
  const out: Sent[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && (n.expression.name.text === "fetch" || n.expression.name.text === "request")) {
      const t = target(n.expression);
      if (t) {
        let req: { method: string; url: string; body: Lit } | null = null;
        const a0 = n.arguments[0] ? unwrap(ts, n.arguments[0]) : undefined;
        if (n.expression.name.text === "request") req = fromInit(n.arguments[0], n.arguments[1]);
        else if (a0 && ts.isNewExpression(a0) && ts.isIdentifier(a0.expression) && a0.expression.text === "Request") req = fromInit(a0.arguments?.[0], a0.arguments?.[1]);
        else if (a0 && ts.isIdentifier(a0)) { const ne = requestAt(a0); if (ne) req = fromInit(ne.arguments?.[0], ne.arguments?.[1]); }
        if (req) out.push({ ...req, line: lineOf(sf, n.getStart(sf)), ...t });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The vessel-relative module a relative import names from `fromRel`, as `read` finds it. */
function resolveModuleRel(fromRel: string, spec: string, read: (rel: string) => string | null): { rel: string; text: string } | null {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  if (base.startsWith("..")) return null;
  for (const c of [base.replace(/\.[cm]?js$/, ".ts"), base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const t = read(c);
    if (t !== null) return { rel: c, text: t };
  }
  return null;
}

/** The handler functions a route registration `<app>.<method>(path, …handlers)` runs for (method, url), with the
 *  functions they call passing the context on (depth-bounded), in the module that holds the app. */
function routeHandlers(ts: TsModule, sf: TS.SourceFile, app: string, method: string, url: string): Array<{ fn: TS.FunctionLikeDeclaration; ctx: string; name: string }> | null {
  const fnDecls = new Map<string, TS.FunctionLikeDeclaration>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) fnDecls.set(s.name.text, s);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) fnDecls.set(d.name.text, d.initializer);
  }
  const handlers: TS.FunctionLikeDeclaration[] = [];
  let matched = false;
  const visit = (n: TS.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === app) {
      const m = n.expression.name.text.toLowerCase();
      const p = n.arguments[0];
      if ((m === method.toLowerCase() || m === "all" || m === "on") && p && ts.isStringLiteralLike(p) && p.text !== "*" && (url === p.text || url.endsWith(p.text.startsWith("/") ? p.text : `/${p.text}`))) {
        matched = true;
        for (const h of n.arguments.slice(1)) {
          if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) handlers.push(h);
          else if (ts.isIdentifier(h) && fnDecls.has(h.text)) handlers.push(fnDecls.get(h.text)!);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!matched || handlers.length === 0) return null;
  const out: Array<{ fn: TS.FunctionLikeDeclaration; ctx: string; name: string }> = [];
  const seen = new Set<TS.Node>();
  const add = (fn: TS.FunctionLikeDeclaration, ctxIndex: number, name: string, depth: number): void => {
    if (seen.has(fn) || depth > 3) return;
    const p = fn.parameters[ctxIndex];
    if (!p || !ts.isIdentifier(p.name)) return;
    seen.add(fn);
    const ctx = p.name.text;
    out.push({ fn, ctx, name });
    const walk = (n: TS.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fnDecls.has(n.expression.text)) {
        const i = n.arguments.findIndex((a) => ts.isIdentifier(a) && a.text === ctx);
        if (i >= 0) add(fnDecls.get(n.expression.text)!, i, n.expression.text, depth + 1);
      }
      ts.forEachChild(n, walk);
    };
    if (fn.body) walk(fn.body);
  };
  for (const h of handlers) add(h, 0, "(route handler)", 0);
  return out;
}

/** The keys a handler refuses a request without (see the header): guards at the top of its body (and of a top-level
 *  try block), on paths rooted at `<ctx>.req.json()`. */
function requiredKeys(ts: TsModule, sf: TS.SourceFile, fn: TS.FunctionLikeDeclaration, ctx: string): Required[] {
  if (!fn.body || !ts.isBlock(fn.body)) return [];
  const tracked = new Map<string, { alts: string[][]; defaulted: boolean }>();
  const isJsonRead = (e: TS.Expression): boolean => {
    const x = unwrap(ts, e);
    return ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "json"
      && ts.isPropertyAccessExpression(x.expression.expression) && x.expression.expression.name.text === "req"
      && ts.isIdentifier(x.expression.expression.expression) && x.expression.expression.expression.text === ctx;
  };
  const pathsOf = (e: TS.Expression): { alts: string[][]; defaulted: boolean } | null => {
    const x = unwrap(ts, e);
    if (ts.isIdentifier(x)) return tracked.get(x.text) ?? null;
    if (ts.isPropertyAccessExpression(x) || (ts.isElementAccessExpression(x) && ts.isStringLiteralLike(x.argumentExpression))) {
      const k = ts.isPropertyAccessExpression(x) ? x.name.text : (x.argumentExpression as TS.StringLiteralLike).text;
      const o = pathsOf(x.expression);
      return o ? { alts: o.alts.map((a) => [...a, k]), defaulted: false } : null;
    }
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const l = pathsOf(x.left); const r = pathsOf(x.right);
      if (!l && !r) return null;
      return { alts: [...(l?.alts ?? []), ...(r?.alts ?? [])], defaulted: !l || !r || l.defaulted || r.defaulted };
    }
    return null;
  };
  const refusal = (s: TS.Statement): { message: string | null } | null => {
    const rets: TS.ReturnStatement[] = ts.isReturnStatement(s) ? [s] : ts.isBlock(s) ? s.statements.filter(ts.isReturnStatement) : [];
    for (const r of rets) {
      if (!r.expression) continue;
      let status = false; let message: string | null = null;
      const look = (n: TS.Node): void => {
        if (ts.isNumericLiteral(n) && Number(n.text) >= 400 && Number(n.text) < 500) status = true;
        if (message === null && ts.isStringLiteralLike(n) && n.text.length > 3) message = n.text;
        ts.forEachChild(n, look);
      };
      look(r.expression);
      if (status) return { message };
    }
    return null;
  };
  /** The sub-expressions whose ABSENCE alone makes the condition true (each a disjunct of a top-level `||`). */
  const presenceTests = (c: TS.Expression): TS.Expression[] => {
    const x = unwrap(ts, c);
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...presenceTests(x.left), ...presenceTests(x.right)];
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) return [x.operand];
    if (ts.isBinaryExpression(x)) {
      const op = x.operatorToken.kind;
      const neq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
      const l = unwrap(ts, x.left); const r = unwrap(ts, x.right);
      if (neq && ts.isTypeOfExpression(l) && ts.isStringLiteralLike(r) && r.text !== "undefined") return [l.expression];
      const nullish = (n: TS.Expression) => n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === "undefined");
      if (eq && nullish(r)) return [l];
      if (eq && nullish(l)) return [r];
    }
    return [];
  };
  const out: Required[] = [];
  const stmts: TS.Statement[] = [];
  for (const s of fn.body.statements) { stmts.push(s); if (ts.isTryStatement(s)) stmts.push(...s.tryBlock.statements); }
  for (const s of stmts) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (isJsonRead(d.initializer)) tracked.set(d.name.text, { alts: [[]], defaulted: false });
        else { const p = pathsOf(d.initializer); if (p) tracked.set(d.name.text, p); }
      }
      continue;
    }
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(s.expression.left)) {
      if (isJsonRead(s.expression.right)) tracked.set(s.expression.left.text, { alts: [[]], defaulted: false });
      continue;
    }
    if (ts.isIfStatement(s)) {
      const r = refusal(s.thenStatement);
      if (!r) continue;
      for (const e of presenceTests(s.expression)) {
        const p = pathsOf(e);
        if (!p || (p.defaulted && ts.isIdentifier(unwrap(ts, e)))) continue;
        const alts = p.alts.filter((a) => a.length > 0);
        if (alts.length === p.alts.length && alts.length > 0) out.push({ alts, line: lineOf(sf, s.getStart(sf)), message: r.message });
      }
    }
  }
  return out;
}

function probeEntryKey(ts: TsModule, input: RealismInput): { state: ProbeState; signals: RealismSignal[] } {
  const signals: RealismSignal[] = [];
  let applicable = false;
  const unknowns: string[] = [];
  for (const chk of input.checks) {
    const sf = parse(ts, chk.path, chk.text);
    for (const req of sentRequests(ts, sf)) {
      applicable = true;
      const mod = resolveModuleRel(chk.path, req.module, input.read);
      if (!mod) { unknowns.push(`the route module ${req.module} is not readable`); continue; }
      const msf = parse(ts, mod.rel, mod.text);
      const hs = routeHandlers(ts, msf, req.exported, req.method, req.url);
      if (!hs) { unknowns.push(`no ${req.method} ${req.url} route on ${req.exported} in ${mod.rel}`); continue; }
      for (const h of hs) {
        for (const k of requiredKeys(ts, msf, h.fn, h.ctx)) {
          if (!k.alts.every((a) => hasPath(req.body, a) === "no")) continue;
          signals.push({
            probe: "entry_key",
            detail: `the entry's parser (${h.name} in ${mod.rel}:${k.line}) refuses a request without ${k.alts.map((a) => a.join(".")).join(" or ")}${k.message ? ` ("${k.message.slice(0, 120)}")` : ""}; the check's ${req.method} ${req.url} request omits it, so production never sends what the check exercises`,
            file: chk.path,
            line: req.line,
          });
        }
      }
    }
  }
  if (signals.length > 0) return { state: "flagged", signals };
  if (unknowns.length > 0) return { state: `unknown: ${unknowns[0]}`, signals };
  return { state: applicable ? "clean" : "not_applicable", signals };
}

// ── probe: masked callee ───────────────────────────────────────────────────────────────────────────────────────────
type Cast = { start: number; end: number; line: number; text: string };
/** Structural casts through a policy type on ADDED lines whose operand is an imported or dynamically imported module. */
function maskedCasts(ts: TsModule, sf: TS.SourceFile, added: Set<number>, through: readonly string[]): Cast[][] {
  const importNames = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || s.importClause.isTypeOnly) continue;
    if (s.importClause.name) importNames.add(s.importClause.name.text);
    const nb = s.importClause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) importNames.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) importNames.add(el.name.text);
  }
  const isDynImport = (e: TS.Expression): boolean => { const x = unwrap(ts, e); return ts.isCallExpression(x) && x.expression.kind === ts.SyntaxKind.ImportKeyword; };
  const visitDyn = (n: TS.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isDynImport(n.initializer)) importNames.add(n.name.text);
    ts.forEachChild(n, visitDyn);
  };
  visitDyn(sf);
  const throughKw = (t: TS.TypeNode): boolean => {
    const k = t.kind === ts.SyntaxKind.UnknownKeyword ? "unknown" : t.kind === ts.SyntaxKind.AnyKeyword ? "any" : null;
    return k !== null && through.includes(k);
  };
  const rootIsModule = (e: TS.Expression): boolean => {
    let x: TS.Expression = e;
    for (;;) {
      if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAwaitExpression(x)) { x = x.expression; continue; }
      if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) { x = x.expression; continue; }
      break;
    }
    return (ts.isIdentifier(x) && importNames.has(x.text)) || isDynImport(x);
  };
  const out: Cast[][] = [];
  const visit = (n: TS.Node): void => {
    // the OUTER cast `<inner> as T` whose inner (through parentheses) is `<operand> as unknown`
    if (ts.isAsExpression(n) && !throughKw(n.type)) {
      let inner: TS.Expression = n.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (ts.isAsExpression(inner) && throughKw(inner.type) && rootIsModule(inner.expression) && added.has(lineOf(sf, n.getStart(sf)))) {
        out.push([
          { start: inner.expression.getEnd(), end: inner.getEnd(), line: lineOf(sf, inner.getStart(sf)), text: inner.getText(sf) },
          { start: n.expression.getEnd(), end: n.getEnd(), line: lineOf(sf, n.getStart(sf)), text: n.getText(sf) },
        ]);
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** `text` with each range blanked to spaces, newlines kept: every other position stays where it was. */
const blank = (text: string, ranges: ReadonlyArray<{ start: number; end: number }>): string => {
  const chars = text.split("");
  for (const r of ranges) for (let i = r.start; i < r.end; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
};

const VIRTUAL_ROOT = "/__realism_virtual__";
/** The diagnostics of ONE file of a program whose host serves `overlay` (vessel-relative path -> text) in memory. */
function fileDiagnostics(ts: TsModule, input: RealismInput, rel: string, text: string): Array<{ code: number; line: number; message: string }> {
  const root = input.root ?? VIRTUAL_ROOT;
  let options: TS.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, lib: ["lib.es2022.d.ts"] };
  if (input.root) {
    const cfg = ts.readConfigFile(join(input.root, "tsconfig.json"), ts.sys.readFile);
    if (!cfg.error) options = ts.parseJsonConfigFileContent(cfg.config, ts.sys, input.root).options;
  }
  options = { ...options, noEmit: true, skipLibCheck: true, incremental: false, composite: false, rootDir: undefined, outDir: undefined, ...(input.root ? {} : { types: [] }) };
  const abs = join(root, rel);
  const host = ts.createCompilerHost(options, true);
  const underRoot = (f: string): string | null => (f.startsWith(root + "/") ? f.slice(root.length + 1) : null);
  const readVirtual = (f: string): string | undefined => {
    if (f === abs) return text;
    const r = underRoot(f);
    if (r !== null && !input.root) return input.read(r) ?? undefined;
    return undefined;
  };
  const baseRead = host.readFile.bind(host);
  const baseExists = host.fileExists.bind(host);
  const baseGet = host.getSourceFile.bind(host);
  host.readFile = (f) => readVirtual(f) ?? baseRead(f);
  host.fileExists = (f) => readVirtual(f) !== undefined || baseExists(f);
  host.getSourceFile = (f, lang, onErr, create) => {
    const v = readVirtual(f);
    return v !== undefined ? ts.createSourceFile(f, v, lang, true) : baseGet(f, lang, onErr, create);
  };
  const baseDir = host.directoryExists?.bind(host);
  host.directoryExists = (d) => (!input.root && (d === root || d.startsWith(root + "/"))) || (baseDir ? baseDir(d) : ts.sys.directoryExists(d));
  host.writeFile = () => { /* never: the copy lives in memory only */ };
  const program = ts.createProgram({ rootNames: [abs], options, host });
  const sf = program.getSourceFile(abs);
  if (!sf) return [];
  return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => ({
    code: d.code,
    line: d.start !== undefined ? lineOf(sf, d.start) : 0,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n")[0]!.slice(0, 240),
  }));
}

function probeMaskedCallee(ts: TsModule, input: RealismInput, policy: RealismPolicy): { state: ProbeState; signals: RealismSignal[] } {
  const signals: RealismSignal[] = [];
  let applicable = false;
  const codes = new Set(policy.masked_callee_diagnostics.map((c) => Number(c)).filter((n) => Number.isInteger(n)));
  for (const f of input.fix) {
    if (!/\.[cm]?tsx?$/.test(f.path)) continue;
    const sf = parse(ts, f.path, f.post);
    const casts = maskedCasts(ts, sf, addedLines(f.pre, f.post), policy.cast_through_types);
    if (casts.length === 0) continue;
    applicable = true;
    let before: Array<{ code: number; line: number; message: string }>;
    let after: Array<{ code: number; line: number; message: string }>;
    try {
      before = fileDiagnostics(ts, input, f.path, f.post);
      after = fileDiagnostics(ts, input, f.path, blank(f.post, casts.flat()));
    } catch (e) {
      return { state: `unknown: typecheck of ${f.path} failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, signals };
    }
    const seen = new Set(before.map((d) => `${d.code}|${d.message}`));
    for (const d of after) {
      if (!codes.has(d.code) || seen.has(`${d.code}|${d.message}`)) continue;
      seen.add(`${d.code}|${d.message}`);
      const cast = casts.find((c) => c[0]!.line <= d.line) ?? casts[0]!;
      signals.push({
        probe: "masked_callee",
        detail: `with the cast \`${cast[1]!.text.replace(/\s+/g, " ").slice(0, 160)}\` (line ${cast[1]!.line}) removed, the callee's real type answers TS${d.code}: ${d.message}; the fix reads what the callee never returns`,
        file: f.path,
        line: d.line,
      });
    }
  }
  return { state: signals.length > 0 ? "flagged" : applicable ? "clean" : "not_applicable", signals };
}

// ── probe: constant verdict ────────────────────────────────────────────────────────────────────────────────────────
function probeConstantVerdict(ts: TsModule, input: RealismInput, policy: RealismPolicy): { state: ProbeState; signals: RealismSignal[] } {
  const signals: RealismSignal[] = [];
  const isVerdictName = (n: string): boolean => policy.verdict_field_globs.some((g) => globMatches(g, n.toLowerCase()));
  const isBool = (e: TS.Expression): boolean => { const x = unwrap(ts, e); return x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword; };
  const isLiteral = (e: TS.Expression): boolean => {
    const x = unwrap(ts, e);
    return ts.isStringLiteralLike(x) || ts.isNumericLiteral(x) || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === "undefined");
  };
  /** Under a branch of its own function: an if arm, a conditional arm, a case, a catch, or the right of && || ??. */
  const branched = (n: TS.Node): boolean => {
    let cur: TS.Node = n;
    while (cur.parent) {
      const p: TS.Node = cur.parent;
      if (ts.isFunctionLike(p)) return false;
      if (ts.isIfStatement(p) && (p.thenStatement === cur || p.elseStatement === cur)) return true;
      if (ts.isConditionalExpression(p) && (p.whenTrue === cur || p.whenFalse === cur)) return true;
      if (ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isCatchClause(p)) return true;
      if (ts.isBinaryExpression(p) && p.right === cur && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return true;
      cur = p;
    }
    return false;
  };
  for (const f of input.fix) {
    if (!/\.[cm]?[jt]sx?$/.test(f.path)) continue;
    const sf = parse(ts, f.path, f.post);
    const added = addedLines(f.pre, f.post);
    const visit = (n: TS.Node): void => {
      if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent) && isBool(n.initializer) && added.has(lineOf(sf, n.getStart(sf)))) {
        const name = propName(ts, n.name);
        const computed = n.parent.properties.some((q) => q !== n && (ts.isShorthandPropertyAssignment(q) || ts.isSpreadAssignment(q) || (ts.isPropertyAssignment(q) && !isLiteral(q.initializer))));
        if (name && isVerdictName(name) && computed && !branched(n.parent)) {
          signals.push({
            probe: "constant_verdict",
            detail: `the verdict field ${name} is the literal ${unwrap(ts, n.initializer).getText(sf)} beside computed members, on no branch of its function: it does not depend on what it claims to verify`,
            file: f.path,
            line: lineOf(sf, n.getStart(sf)),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { state: signals.length > 0 ? "flagged" : input.fix.length > 0 ? "clean" : "not_applicable", signals };
}

// ── the planted controls ───────────────────────────────────────────────────────────────────────────────────────────
/** Five closed fixtures, excerpts of the measured cases (no node, host or key names). Each run reproduces them first. */
export type PlantedFixture = { name: string; expect: "unrealistic" | "realistic"; probe: RealismProbe | null; input: RealismInput };
const files = (m: Record<string, string>) => (rel: string): string | null => m[rel] ?? null;
const ROUTE = `import { Hono } from "hono";
const impulses = new Hono();
impulses.use("*", async (c, next) => {
  const body = await c.req.raw.clone().json();
  const envelope = body as { shape?: unknown; pointer?: { limit?: unknown } };
  if (envelope.shape === "conceptSearch" && typeof envelope.pointer?.limit === "number" && envelope.pointer.limit < 1) return c.json({ error: "pointer.limit must be a positive integer" }, 400);
  await next();
});
impulses.post("/resolve", (c) => runInScope(() => resolveImpulse(c)));
async function resolveImpulse(c: any): Promise<Response> {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const pointer = body?.impulse?.pointer ?? body?.pointer;
  if (!pointer || typeof pointer !== "object") {
    return c.json({ error: "Missing required field: pointer" }, 400);
  }
  const shape = pointer.type;
  if (typeof shape !== "string") {
    return c.json({ error: "Missing or invalid pointer.type" }, 400);
  }
  return c.json({ shape }, 200);
}
function runInScope<T>(f: () => T): T { return f(); }
export { impulses };
`;
const ROUTE_CHECK = `import { it, expect } from "bun:test";
import * as mod from "../../src/routes/impulses";
it("rejects a negative limit", async () => {
  const body = { shape: "conceptSearch", pointer: { query: "q", limit: -1 } };
  const request = new Request("http://localhost/v2/impulses/resolve", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const response = await mod.impulses.fetch(request);
  expect(response.status).toBe(400);
});
`;
const HOLD = `export type HoldDecision = { held: boolean; why: string; record?: { id: string } };
export async function readHold(id: string): Promise<HoldDecision> { return { held: id.length > 0, why: "fixture" }; }
`;
const APPLY_PRE = `export async function applyAnswer(panelId: string, answers: Map<string, { recordId: string }>): Promise<string> {
  const answer = answers.get(panelId);
  return answer ? answer.recordId : "absent";
}
`;
const APPLY_POST = `export async function applyAnswer(panelId: string, answers: Map<string, { recordId: string }>): Promise<string> {
  let answer = answers.get(panelId);
  if (!answer) {
    const mod = await import("../lib/hold.js");
    const fn = ((mod as unknown) as { readHold?: (id: string) => Promise<{ recordId?: string } | undefined> }).readHold;
    if (typeof fn === "function") {
      const alt = await fn(panelId);
      if (alt && typeof alt.recordId === "string") answer = { recordId: alt.recordId };
    }
  }
  return answer ? answer.recordId : "absent";
}
`;
const VERDICT_PRE = `export function verdictBody(reason: string, hash: string): string {
  return JSON.stringify({ reason, hash });
}
`;
const VERDICT_POST = `export function verdictBody(reason: string, hash: string): string {
  const meta = (() => {
    if (!reason.includes("deterministic_wrong_derived_value")) return null;
    const src = hash || "";
    const command = \`printf '%s' '\${src}' | wc -c\`;
    const oracle_value = String(src.length);
    return { deterministic_class: "deterministic_wrong_derived_value", deterministic_command: command, oracle_value, oracle_verified: true };
  })();
  return JSON.stringify({ reason, hash, ...(meta ?? {}) });
}
`;
const CLASS_PRE = `const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/composition chain depth/i, "refused:chain-depth"],
];
export function failureClassOf(detail: string): string | null {
  for (const [re, cls] of RULES) if (re.test(detail)) return cls;
  return null;
}
`;
const CLASS_POST = `const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // A malformed request belongs to the CALLER, so name it before any error rule.
  [/malformed[\\s_-]*request/i, "malformed_request"],
  [/composition chain depth/i, "refused:chain-depth"],
];
export function failureClassOf(detail: string): string | null {
  for (const [re, cls] of RULES) if (re.test(detail)) return cls;
  return null;
}
`;
const CLASS_CHECK = `import { it, expect } from "bun:test";
import { failureClassOf } from "../../src/lib/failure-class";
it("a malformed request is the caller's fault", () => {
  expect(failureClassOf("execution_error, failure_mode=malformed_request")).toBe("malformed_request");
  expect(failureClassOf("composition chain depth (7) exceeded")).toBe("refused:chain-depth");
});
`;
const PATHLESS_CHECK = `import { describe, it, expect } from "bun:test";
import * as mod from "../../src/goal-file-resolution";
describe("isPathlessCodeChangeGoal", () => {
  it("returns false for read-only, classification or measurement goals", () => {
    expect(mod.isPathlessCodeChangeGoal("Audit how a refused run is recorded. This is a read-only analysis; change no code.")).toBe(false);
    expect(mod.isPathlessCodeChangeGoal("Measure the impact of the new caching strategy on endpoint latency.")).toBe(false);
  });
  it("keeps genuine edits", () => {
    expect(mod.isPathlessCodeChangeGoal("make the retry backoff in the trace retention service exponential")).toBe(true);
  });
});
`;
export const PLANTED_FIXTURES: readonly PlantedFixture[] = [
  { name: "planted:entry-key-omitted-pointer-type", expect: "unrealistic", probe: "entry_key",
    input: { gap_id: null, vessel: null, root: null, fix: [], checks: [{ path: "test/checks/limit.check.ts", text: ROUTE_CHECK }], read: files({ "src/routes/impulses.ts": ROUTE }) } },
  { name: "planted:masked-callee-read", expect: "unrealistic", probe: "masked_callee",
    input: { gap_id: null, vessel: null, root: null, checks: [], fix: [{ path: "src/resolvers/apply.ts", pre: APPLY_PRE, post: APPLY_POST }], read: files({ "src/lib/hold.ts": HOLD, "src/resolvers/apply.ts": APPLY_POST }) } },
  { name: "planted:constant-verdict-literal", expect: "unrealistic", probe: "constant_verdict",
    input: { gap_id: null, vessel: null, root: null, checks: [], fix: [{ path: "src/index.ts", pre: VERDICT_PRE, post: VERDICT_POST }], read: files({}) } },
  { name: "planted:honest-real-import-fix-and-check", expect: "realistic", probe: null,
    input: { gap_id: null, vessel: null, root: null, fix: [{ path: "src/lib/failure-class.ts", pre: CLASS_PRE, post: CLASS_POST }], checks: [{ path: "test/checks/malformed.check.ts", text: CLASS_CHECK }], read: files({ "src/lib/failure-class.ts": CLASS_POST }) } },
  { name: "planted:honest-check-only", expect: "realistic", probe: null,
    input: { gap_id: null, vessel: null, root: null, fix: [], checks: [{ path: "test/checks/pathless.check.ts", text: PATHLESS_CHECK }], read: files({}) } },
];

// ── the audit ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The three probes over one input, with no planted gate: what the audit found, per probe. */
export function runRealismProbes(ts: TsModule, input: RealismInput, policy: RealismPolicy, startedAt: number = Date.now(), now: () => number = Date.now): { probes: Record<RealismProbe, ProbeState>; signals: RealismSignal[] } {
  const probes = {} as Record<RealismProbe, ProbeState>;
  const signals: RealismSignal[] = [];
  const run: Record<RealismProbe, () => { state: ProbeState; signals: RealismSignal[] }> = {
    entry_key: () => probeEntryKey(ts, input),
    masked_callee: () => probeMaskedCallee(ts, input, policy),
    constant_verdict: () => probeConstantVerdict(ts, input, policy),
  };
  for (const p of REALISM_PROBES) {
    if (!policy.enabled_probes.includes(p)) { probes[p] = "disabled"; continue; }
    if (now() - startedAt > policy.budget_ms) { probes[p] = `unknown: the audit's ${policy.budget_ms} ms budget was spent before this probe`; continue; }
    try { const r = run[p](); probes[p] = r.state; signals.push(...r.signals); }
    catch (e) { probes[p] = `unknown: ${String((e as Error)?.message ?? e).slice(0, 160)}`; }
  }
  return { probes, signals };
}
/** Reproduce the planted fixtures of the enabled probes: each unrealistic one fires by its named probe, each realistic one fires nothing. */
export function reproducePlanted(ts: TsModule, policy: RealismPolicy, fixtures: readonly PlantedFixture[] = PLANTED_FIXTURES): { reproduced: number; of: number; failed: string[] } {
  const failed: string[] = [];
  let of = 0;
  for (const fx of fixtures) {
    if (fx.probe && !policy.enabled_probes.includes(fx.probe)) continue;
    of++;
    const r = runRealismProbes(ts, fx.input, policy);
    const ok = fx.expect === "unrealistic" ? r.signals.some((s) => s.probe === fx.probe) : r.signals.length === 0 && Object.values(r.probes).every((s) => !s.startsWith("unknown"));
    if (!ok) failed.push(`${fx.name} (expected ${fx.expect}; signals ${r.signals.map((s) => s.probe).join(",") || "none"}; probes ${JSON.stringify(r.probes)})`);
  }
  return { reproduced: of - failed.length, of, failed };
}

export type RealismDeps = { policy?: RealismPolicyRead; now?: () => number; fixtures?: readonly PlantedFixture[] };
/**
 * THE ACTIVITY realism_audit: the planted controls, then the three probes over the landing's check(s) and fix. Never
 * throws; anything it cannot decide reads unknown. Advisory: its caller refuses nothing on it.
 */
export async function realismAudit(input: RealismInput, deps: RealismDeps = {}): Promise<RealismVerdict> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const base = { shape: "realismVerdict" as const, gap_id: input.gap_id, vessel: input.vessel };
  const none = Object.fromEntries(REALISM_PROBES.map((p) => [p, "unknown: not run"])) as Record<RealismProbe, ProbeState>;
  const fail = (why: string, policy: RealismVerdict["policy"], planted = { reproduced: 0, of: 0, failed: [] as string[] }, probes = none, signals: RealismSignal[] = []): RealismVerdict =>
    ({ ...base, verdict: "unknown", signals, probes, planted, policy, ms: now() - t0, why });
  try {
    const pol = deps.policy ?? await readRealismPolicy();
    if (!pol.ok) return fail(`realismPolicy unreadable: ${pol.why}`, "invalid");
    const policy = pol.policy;
    const ts = loadTs();
    if (!ts) return fail("typescript unavailable: no probe can read a check or a fix", pol.source);
    const planted = reproducePlanted(ts, policy, deps.fixtures);
    const r = runRealismProbes(ts, input, policy, t0, now);
    if (planted.failed.length > 0) return fail(`the planted controls did not reproduce (${planted.reproduced}/${planted.of}): ${planted.failed[0]!.slice(0, 300)}`, pol.source, planted, r.probes, r.signals);
    const unknown = Object.entries(r.probes).find(([, s]) => s.startsWith("unknown"));
    const verdict: RealismVerdictValue = r.signals.length > 0 ? "unrealistic" : unknown ? "unknown" : "realistic";
    return { ...base, verdict, signals: r.signals, probes: r.probes, planted, policy: pol.source, ms: now() - t0, ...(verdict === "unknown" && unknown ? { why: `${unknown[0]}: ${unknown[1]}` } : {}) };
  } catch (e) {
    return fail(`the audit threw: ${String((e as Error)?.message ?? e).slice(0, 200)}`, "invalid");
  }
}

// ── the trace ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The activity's id in the trace store: born by its traces (as the own-check-baseline credit is), not a declared template. */
export const REALISM_AUDIT_ACTIVITY = "development-vessel:realism_audit";
/** The gradable trace of one audit. success = its planted controls reproduced (the run is judged); the verdict is a tag
 *  and the output, so an outcome consumer can grade it against what happens to the landing. */
export function realismAuditTrace(v: RealismVerdict, i: { compose_execution_id: string | null; nowIso: string }): Record<string, unknown> {
  const judged = v.planted.of > 0 && v.planted.failed.length === 0;
  const impulse = `realismVerdict:${(v.gap_id ?? "no-gap").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80)}:${v.vessel ?? "-"}@${Date.parse(i.nowIso) || Date.now()}`;
  return {
    execution_id: `realism-audit-${(v.gap_id ?? "no-gap").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}-${(v.vessel ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30)}-${Date.parse(i.nowIso) || Date.now()}`,
    template_id: REALISM_AUDIT_ACTIVITY,
    activity_id: REALISM_AUDIT_ACTIVITY,
    activity_variant_id: REALISM_AUDIT_ACTIVITY,
    status: judged ? "completed" : "failed",
    success: judged,
    ...(judged ? {} : { failure_mode: { type: "verifier_negative", reason: `realism_audit unjudged: ${String(v.why ?? "").slice(0, 300)}` } }),
    started_at: i.nowIso,
    duration_ms: v.ms,
    composition_chain: i.compose_execution_id ? [i.compose_execution_id] : [],
    tasks: REALISM_PROBES.map((p) => ({
      id: p, resolver_id: `realism_probe_${p}`, resolver_tier: "deterministic",
      success: !v.probes[p].startsWith("unknown"),
      input_impulse_ids: [], output_impulse_ids: [impulse],
    })),
    tags: [judged ? "reached:true" : "reached:false", `realism_verdict:${v.verdict}`, `realism_planted:${v.planted.reproduced}/${v.planted.of}`],
    metadata: { gap_id: v.gap_id, vessel: v.vessel, output: { id: impulse, ...v }, advisory: true },
  };
}
/** One line for the log and the repair prompt; null unless the verdict is unrealistic. */
export function realismEvidenceText(v: RealismVerdict | null | undefined): string | null {
  if (!v || v.verdict !== "unrealistic") return null;
  return `REALISM AUDIT (advisory; it refuses nothing, read it as information): this landing exercises what production never sends or returns.\n`
    + v.signals.slice(0, 6).map((s) => `  - [${s.probe}] ${s.file}:${s.line}: ${s.detail.slice(0, 400)}`).join("\n");
}
