// STATIC SWEEP: every HTTP call this vessel makes to ITS OWN resolve route with a write-type pointer
// must carry `Authorization`. The resolve route's write gate (src/lib/caller-credential.ts,
// isWritePointerType) refuses any `*_write` or mutating primitive without an ApiKey, and this vessel
// calls itself over HTTP from its detectors, rhythms and gap filing. A self-call without the header is
// refused 401 and the caller usually swallows it (best-effort fetch), so the failure is silent: this
// sweep is the check that does not depend on a live refusal being noticed.
//
// HOW A SITE IS FOUND (TypeScript AST, per file under src/; identifiers resolve to their nearest
// enclosing declaration, through same-file scopes and relative imports):
//   SELF URL   the URL expression names a self endpoint: a marker (DEV_SELF_ENDPOINT, DEV_VESSEL_ENDPOINT,
//              DEV_VESSEL_SELF_ENDPOINT, DEV_VESSEL_IMPULSES_URL, SELF_ENDPOINT, SELF_RESOLVE_ENDPOINT,
//              127.0.0.1:8090 / localhost:8090, localhost:${…PORT…}), directly or through the
//              declarations it names. METABOB_ENDPOINT alone is NOT self: it defaults to activity-api
//              (:8080) in this repo; where it defaults to :8090 the literal makes it self.
//   TRANSPORT  a call to fetch, or to a same-file wrapper whose inner transport call takes its URL from
//              a parameter. A wrapper that also takes its init from a parameter (rhythm's fetchJson)
//              leaves headers to the CALLER, so the caller is the site; a wrapper that builds its own
//              headers is judged by those.
//   WRITE      the call's arguments (declarations followed two hops) contain a `*_write` string literal
//              or a MUTATING_PRIMITIVES member as a string literal.
//   AUTHED     the init's `headers` (declarations, assignments to them, helper functions and imported
//              helpers followed) mention Authorization in any form.
import ts from "typescript";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { MUTATING_PRIMITIVES } from "../../src/lib/caller-credential.js";

export const SRC_ROOT = resolve(import.meta.dir, "../../src");

const SELF_MARKER =
  /\b(?:DEV_SELF_ENDPOINT|DEV_VESSEL_SELF_ENDPOINT|DEV_VESSEL_ENDPOINT|DEV_VESSEL_IMPULSES_URL|SELF_ENDPOINT|SELF_RESOLVE_ENDPOINT)\b|(?:127\.0\.0\.1|localhost):8090\b|(?:127\.0\.0\.1|localhost):\$\{[^}]*\bPORT\b/;
const WRITE_LITERAL = new RegExp(
  `([A-Za-z0-9_]*(?:[A-Za-z0-9]|\\$\\{[^}]*\\}))_write["'\`]|["'\`](${[...MUTATING_PRIMITIVES].join("|")})["'\`]`,
  "g",
);
const AUTH = /authorization/i;

export type SweepSite = {
  file: string; // relative to src/
  line: number;
  via?: string; // wrapper name@line when the call goes through a same-file wrapper
  writes: string[];
  authed: boolean;
};

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const sfCache = new Map<string, ts.SourceFile>();
function sourceFile(path: string): ts.SourceFile {
  let sf = sfCache.get(path);
  if (!sf) {
    sf = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
    sfCache.set(path, sf);
  }
  return sf;
}

const isScope = (n: ts.Node): boolean =>
  ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ||
  ts.isFunctionLike(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isCatchClause(n);

/** Identifiers that are references (not property names, not object keys). */
function refIds(node: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isName =
        (p && ts.isPropertyAccessExpression(p) && p.name === n) ||
        (p && ts.isPropertyAssignment(p) && p.name === n) ||
        (p && (ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === n);
      if (!isName) out.push(n);
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      out.push(n.name);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

type Decl = { node: ts.Node; kind: "value" | "function" | "param" };

/** The nearest declaration of `id` and, for a variable, every assignment into it in the same scope. */
function declsOf(id: ts.Identifier): Decl[] {
  const name = id.text;
  const sf = id.getSourceFile();
  for (let s: ts.Node | undefined = id.parent; s; s = s.parent) {
    if (!isScope(s)) continue;
    const found: Decl[] = [];
    if (ts.isFunctionLike(s)) {
      for (const p of s.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) found.push({ node: p.initializer ?? p, kind: "param" });
      }
    }
    // Declarations directly in this scope (variable statements, for-initializers, functions).
    const scan = (n: ts.Node): void => {
      if (n !== s && isScope(n) && !ts.isBlock(n)) return;
      if (n !== s && ts.isBlock(n)) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
        const init = n.initializer;
        found.push({ node: init, kind: ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? "function" : "value" });
      }
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) found.push({ node: n, kind: "function" });
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.startsWith(".")) {
        const nb = n.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.name.text !== name) continue;
            const abs = resolve(dirname(sf.fileName), n.moduleSpecifier.text.replace(/\.js$/, ".ts"));
            if (existsSync(abs)) found.push(...topLevelDecls(sourceFile(abs), (el.propertyName ?? el.name).text));
          }
        }
      }
      ts.forEachChild(n, scan);
    };
    // headers["Authorization"] = …, headers.Authorization = … anywhere under the declaring scope
    // (including nested blocks such as `if (key) { … }`).
    const assigns: Decl[] = [];
    const scanAssign = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isElementAccessExpression(n.left) || ts.isPropertyAccessExpression(n.left)) &&
        ts.isIdentifier(n.left.expression) && n.left.expression.text === name
      ) assigns.push({ node: n, kind: "value" });
      ts.forEachChild(n, scanAssign);
    };
    if (ts.isFunctionLike(s)) {
      const body = (s as ts.FunctionLikeDeclarationBase).body;
      if (body) {
        if (ts.isBlock(body)) ts.forEachChild(body, scan);
      }
    } else {
      ts.forEachChild(s, scan);
    }
    if (found.length > 0) {
      ts.forEachChild(s, scanAssign);
      return [...found, ...assigns];
    }
  }
  return [];
}

function topLevelDecls(sf: ts.SourceFile, name: string): Decl[] {
  const out: Decl[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) out.push({ node: st, kind: "function" });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          const init = d.initializer;
          out.push({ node: init, kind: ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? "function" : "value" });
        }
      }
    }
  }
  return out;
}

/** `node` plus the declarations it names, followed `hops` deep. */
function expandedNodes(node: ts.Node, hops: number, opts: { functions: boolean }): ts.Node[] {
  const out: ts.Node[] = [node];
  const seen = new Set<ts.Node>([node]);
  let frontier: ts.Node[] = [node];
  for (let h = 0; h < hops && frontier.length > 0; h++) {
    const next: ts.Node[] = [];
    for (const f of frontier) {
      for (const id of refIds(f)) {
        for (const d of declsOf(id)) {
          if (seen.has(d.node)) continue;
          if (d.kind === "function" && !opts.functions) continue;
          seen.add(d.node);
          out.push(d.node);
          next.push(d.node);
        }
      }
    }
    frontier = next;
  }
  return out;
}
const expanded = (node: ts.Node, hops: number, opts: { functions: boolean }): string =>
  expandedNodes(node, hops, opts).map((n) => n.getText()).join("\n");

const isSelf = (node: ts.Node): boolean => urlMatches(node, SELF_MARKER);

/** The URL expression, or a declaration it names (a function: what it returns), matches `re`. */
function urlMatches(node: ts.Node, re: RegExp, seen = new Set<ts.Node>()): boolean {
  if (re.test(node.getText())) return true;
  for (const id of refIds(node)) {
    for (const d of declsOf(id)) {
      if (seen.has(d.node)) continue;
      seen.add(d.node);
      // For a function, what it RETURNS is the URL; a whole body would match anything it mentions.
      const targets: ts.Node[] = d.kind === "function" ? returnedExprs(d.node) : [d.node];
      if (targets.some((t) => urlMatches(t, re, seen))) return true;
    }
  }
  return false;
}

function returnedExprs(fn: ts.Node): ts.Node[] {
  const body = (fn as ts.ArrowFunction).body;
  if (body && !ts.isBlock(body)) return [body];
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    if (n !== fn && ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return out;
}

function writesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WRITE_LITERAL)) out.add(m[1] !== undefined ? `${m[1]}_write` : m[2]!);
  return [...out];
}

/** An impulse/pointer `type` the code computes at run time: the sweep cannot rule out a write, so it
 *  counts as one (`<dynamic:expr>`). Literal types are judged by writesIn. */
function dynamicTypes(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAssignment(n) && n.name.getText() === "type" &&
      !ts.isStringLiteralLike(n.initializer) &&
      ts.isObjectLiteralExpression(n.parent) && ts.isPropertyAssignment(n.parent.parent) &&
      /^(impulse|pointer)$/.test(n.parent.parent.name.getText())
    ) out.push(`<dynamic:${n.initializer.getText()}>`);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The headers expression(s) an init carries, or the init itself when its shape cannot be read. */
function headerExprs(init: ts.Node, seen = new Set<ts.Node>()): ts.Node[] {
  if (seen.has(init)) return [];
  seen.add(init);
  if (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) return headerExprs(init.expression, seen);
  if (ts.isObjectLiteralExpression(init)) {
    const out: ts.Node[] = [];
    for (const p of init.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === "headers") out.push(p.initializer);
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === "headers") out.push(p.name);
      if (ts.isSpreadAssignment(p)) out.push(...headerExprs(p.expression, seen));
    }
    return out;
  }
  if (ts.isIdentifier(init)) {
    const ds = declsOf(init);
    if (ds.some((d) => d.kind === "param")) return [];
    return ds.flatMap((d) => headerExprs(d.node, seen));
  }
  return [init];
}

const authedInit = (init: ts.Node | undefined): boolean =>
  init !== undefined && headerExprs(init).some((h) => AUTH.test(expanded(h, 5, { functions: true })));

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  // (opts.fetchImpl ?? fetch)(url, init): an injectable fetch is still the transport.
  if (ts.isParenthesizedExpression(e) && /(^|[^.\w])fetch\s*$/.test(e.expression.getText())) return "fetch";
  if (ts.isPropertyAccessExpression(e)) {
    if (e.name.text === "fetch" && /^(globalThis|window|self)$/.test(e.expression.getText())) return "fetch";
    return `.${e.name.text}`; // a method: matches a same-file wrapper defined as an object member
  }
  return "";
}

type Fn = { name: string; node: ts.SignatureDeclaration; params: string[] };
/** urlIdx: the parameter carrying the URL, or "self" when the wrapper always calls a fixed self URL. */
type Wrapper = {
  urlIdx: number | "self";
  initIdx: number | null; // the parameter that carries the headers (null: the wrapper sets its own)
  authedInside: boolean;
  writesInside: string[];
  line: number;
  site?: ts.CallExpression; // for a fixed-self wrapper that sets its own headers: where they belong
};

function namedFunctions(sf: ts.SourceFile): Fn[] {
  const out: Fn[] = [];
  const params = (f: ts.SignatureDeclaration): string[] => f.parameters.map((p) => p.name.getText());
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) out.push({ name: n.name.text, node: n, params: params(n) });
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      out.push({ name: n.name.text, node: n.initializer, params: params(n.initializer) });
    }
    // Object members (injected ports: `postGap: async (url, body) => …`, `async postGap(url, body) {…}`).
    if (ts.isPropertyAssignment(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      out.push({ name: `.${n.name.getText()}`, node: n.initializer, params: params(n.initializer) });
    }
    if (ts.isMethodDeclaration(n)) out.push({ name: `.${n.name.getText()}`, node: n, params: params(n) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function enclosingFn(n: ts.Node, fns: Fn[]): Fn | undefined {
  for (let p = n.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p)) continue;
    return fns.find((x) => x.node === p);
  }
  return undefined;
}

/** Index of the parameter the argument IS (bare identifier) or is built from. */
function paramIndex(arg: ts.Node | undefined, params: string[]): number {
  if (!arg) return -1;
  const ids = new Set(refIds(arg).filter((id) => declsOf(id).some((d) => d.kind === "param")).map((id) => id.text));
  return params.findIndex((p) => ids.has(p));
}

const argWrites = (a: ts.Node): string[] => {
  const ns = expandedNodes(a, 2, { functions: false });
  return [...writesIn(ns.map((n) => n.getText()).join("\n")), ...ns.flatMap(dynamicTypes)];
};
const FETCH: Wrapper = { urlIdx: 0, initIdx: 1, authedInside: false, writesInside: [], line: 0 };

/** Which parameter supplies the headers of `initArg`, if any. */
function headerParam(initArg: ts.Node | undefined, params: string[]): number {
  if (!initArg) return -1;
  const hs = headerExprs(initArg);
  if (hs.length === 0) {
    // Only an init passed through whole (`init`, `{ ...init }`) leaves the headers to the caller; an init
    // literal that merely builds its BODY from a parameter has no headers at all, and is judged here.
    const whole = ts.isIdentifier(initArg) ? [initArg] : ts.isObjectLiteralExpression(initArg)
      ? initArg.properties.filter(ts.isSpreadAssignment).map((p) => p.expression)
      : [];
    for (const w of whole) {
      const i = paramIndex(w, params);
      if (i >= 0) return i;
    }
    return -1;
  }
  for (const h of hs) {
    const i = paramIndex(h, params);
    if (i >= 0) return i;
  }
  return -1;
}

type RawSite = { at: ts.CallExpression; writes: string[]; authed: boolean; via?: string; urlArg: ts.Node | "self"; init?: ts.Node };
type SweepMode = { match: (n: ts.Node) => boolean; needWrites: boolean };

export function sweepFile(path: string): SweepSite[] {
  return sweepCalls(path, { match: isSelf, needWrites: true }).map(({ at: _a, urlArg: _u, init: _i, ...site }) => site);
}

function sweepCalls(path: string, mode: SweepMode): Array<SweepSite & RawSite> {
  const sf = sourceFile(path);
  const fns = namedFunctions(sf);
  const calls: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) calls.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  const transport = (cn: string, wrappers: Map<string, Wrapper>): Wrapper | undefined =>
    cn === "fetch" ? FETCH : wrappers.get(cn);
  const urlArgOf = (call: ts.CallExpression, t: Wrapper): ts.Node | "self" | undefined =>
    t.urlIdx === "self" ? "self" : call.arguments[t.urlIdx];

  // Wrappers, to fixpoint: a named function (or object member) whose transport call takes its URL from
  // one of its parameters, or calls a fixed self URL with something else (body, init) from a parameter.
  const wrappers = new Map<string, Wrapper>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const call of calls) {
      const inner = transport(calleeName(call), wrappers);
      if (!inner) continue;
      const fn = enclosingFn(call, fns);
      if (!fn || wrappers.has(fn.name)) continue;
      const urlArg = urlArgOf(call, inner);
      if (urlArg === undefined) continue;
      // A URL that is self on its own (a self default behind `pointer.x ?? SELF`) is a fixed-self call,
      // never a pass-through: the self default is exactly the case this sweep exists for.
      let urlIdx: number | "self";
      if (urlArg === "self" || mode.match(urlArg)) {
        // A fixed-self wrapper only if the caller supplies something (otherwise the call is its own site).
        if (!call.arguments.some((a) => paramIndex(a, fn.params) >= 0)) continue;
        urlIdx = "self";
      } else {
        urlIdx = paramIndex(urlArg, fn.params);
        if (urlIdx < 0) continue;
      }
      const initArg = inner.initIdx === null ? undefined : call.arguments[inner.initIdx];
      const authedInside = inner.authedInside || authedInit(initArg);
      const initIdx = authedInside ? -1 : headerParam(initArg, fn.params);
      const ownHeaders = initIdx < 0 && inner.initIdx !== null;
      wrappers.set(fn.name, {
        urlIdx,
        initIdx: initIdx >= 0 ? initIdx : inner.initIdx === null ? null : null,
        authedInside,
        writesInside: [...new Set([...inner.writesInside, ...call.arguments.flatMap(argWrites)])],
        line: sf.getLineAndCharacterOfPosition(fn.node.getStart()).line + 1,
        ...(urlIdx === "self" ? { site: inner.site ?? (ownHeaders ? call : undefined) } : inner.site ? { site: inner.site } : {}),
      });
      grew = true;
    }
  }

  const sites: Array<SweepSite & RawSite> = [];
  const bySite = new Map<ts.CallExpression, SweepSite & RawSite>();
  const record = (at: ts.CallExpression, writes: string[], authed: boolean, via: string | undefined, urlArg: ts.Node | "self", init: ts.Node | undefined): void => {
    const prior = bySite.get(at);
    if (prior) {
      prior.writes = [...new Set([...prior.writes, ...writes])].sort();
      return;
    }
    const site: SweepSite & RawSite = {
      at,
      urlArg,
      init,
      file: relative(SRC_ROOT, path),
      line: sf.getLineAndCharacterOfPosition(at.getStart()).line + 1,
      ...(via ? { via } : {}),
      writes: [...writes].sort(),
      authed,
    };
    bySite.set(at, site);
    sites.push(site);
  };
  for (const call of calls) {
    const cn = calleeName(call);
    const t = transport(cn, wrappers);
    if (!t) continue;
    const urlArg = urlArgOf(call, t);
    if (urlArg === undefined) continue;
    const self = urlArg === "self" || mode.match(urlArg);
    // Inside a wrapper, its own transport call is judged at the wrapper's call sites when the caller
    // supplies the URL (pass-through) or the headers.
    const fn = enclosingFn(call, fns);
    const fw = fn ? wrappers.get(fn.name) : undefined;
    if (fw && fn) {
      if (typeof fw.urlIdx === "number" && urlArg !== "self" && !self && paramIndex(urlArg, fn.params) >= 0) continue;
      if (fw.urlIdx === "self" && fw.initIdx !== null) continue;
    }
    if (!self) continue;
    const writes = [...new Set([...call.arguments.flatMap(argWrites), ...t.writesInside])];
    if (t.urlIdx === "self" && t.site) {
      // The headers belong at the wrapper's own transport call: report it once, with every caller's writes.
      if (writes.length > 0 || !mode.needWrites) record(t.site, writes, t.authedInside, undefined, t.site.arguments[0] ?? "self", t.site.arguments[1]);
      continue;
    }
    if (writes.length === 0 && mode.needWrites) continue;
    const init = t.initIdx === null ? undefined : call.arguments[t.initIdx];
    const authed = t.authedInside || authedInit(init);
    record(call, writes, authed, cn !== "fetch" ? `${cn}@${t.line}` : undefined, urlArg, init);
  }
  return sites;
}

export function sweepSrc(): SweepSite[] {
  return listTs(SRC_ROOT)
    .flatMap((p) => sweepFile(p))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

export const describeSite = (s: SweepSite): string =>
  `${s.file}:${s.line}${s.via ? ` via ${s.via}` : ""} writes=${s.writes.join(",")}`;

// ── EVERY RESOLVE CALL (not only self-writes) ────────────────────────────────────────────────────────
// A call to ANY resolve route — this vessel, discovery, or any other vessel: a URL whose LAST piece is
// `/resolve` or `/v2/impulses/resolve` — must carry Authorization. Every vessel validates its caller
// against identity-vessel, and an unauthenticated call is refused (or served as anonymous) the same
// silent way a self-write is. Reads count: the pointer type is often assembled elsewhere, and a
// credential costs nothing.
//
// The node key must not follow a CALLER-SUPPLIED URL: a site whose URL can START with a value read off a
// request (`pointer.x`, `input.x`, `args.x`, `payload.x`, `impulse.x`, `body.x`, `req.x`), and whose
// headers carry a key without the selfAuthHeaders(url, SELF) guard, hands the node credential to whoever
// wrote the pointer. Configured endpoints (env, literals, Config, a discovery answer) may get it.
//
// HOW A URL IS READ. Structurally, not by text: `pieces(expr, "head"|"tail")` returns what the URL can
// start / end with — string text, or a reference it cannot see through. It follows `a + b` (head of a,
// tail of b), template spans, `??` / `||` / `?:` (every branch), parentheses and casts, string methods
// (`.replace`, `.trim`, …: the receiver), String(x), `new URL(path, base)`, identifiers through their
// declarations (same file, relative imports), property reads on a same-file object literal, and calls
// to a local function (what it returns). A reference it cannot see through ends the walk: a tail
// reference counts as a resolve URL only when its NAME says so (`resolveUrl`, `RESOLVE_ENDPOINT`,
// `resolve_endpoint`), and a head reference is caller-supplied only when it reads off a request object.
const RESOLVE_TAIL = /\/(?:v2\/impulses\/)?resolve\/?$/;
// identity-vessel's /v1/auth/resolve VALIDATES a credential carried in its body: it is the authentication
// step itself, so it is not held to "must carry Authorization".
const AUTH_ROUTE_TAIL = /\/auth\/resolve\/?$/;
const RESOLVE_NAME = /^resolve$|resolve_?(?:url|endpoint|path|route)s?$/i;
const CALLER_BASE = /^(?:pointer|input|args|payload|impulse|body|req|request)$/;
const KEY_GUARD = /\bselfAuth(?:Headers)?\b/;
const STRING_METHODS = /^(?:replace|replaceAll|trim|trimEnd|trimStart|toString|toLowerCase|slice)$/;

type Piece = { text: string } | { ref: string; base?: string };

function pieces(node: ts.Node, end: "head" | "tail", depth = 0, seen = new Set<ts.Node>()): Piece[] {
  if (depth > 12 || seen.has(node)) return [];
  seen.add(node);
  const again = (n: ts.Node): Piece[] => pieces(n, end, depth + 1, seen);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node)) return again(node.expression);
  if (ts.isStringLiteralLike(node)) return [{ text: node.text }];
  if (ts.isTemplateExpression(node)) {
    if (end === "head") return node.head.text ? [{ text: node.head.text }] : again(node.templateSpans[0]!.expression);
    const last = node.templateSpans[node.templateSpans.length - 1]!;
    return last.literal.text ? [{ text: last.literal.text }] : again(last.expression);
  }
  if (ts.isBinaryExpression(node)) {
    const k = node.operatorToken.kind;
    if (k === ts.SyntaxKind.PlusToken) return again(end === "head" ? node.left : node.right);
    if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken) return [...again(node.left), ...again(node.right)];
    return [];
  }
  if (ts.isConditionalExpression(node)) return [...again(node.whenTrue), ...again(node.whenFalse)];
  if (ts.isNewExpression(node) && node.expression.getText() === "URL" && node.arguments?.length) {
    return end === "head" && node.arguments[1] ? again(node.arguments[1]) : again(node.arguments[0]!);
  }
  if (ts.isCallExpression(node)) {
    const e = node.expression;
    if (ts.isPropertyAccessExpression(e) && STRING_METHODS.test(e.name.text)) return again(e.expression);
    if (ts.isIdentifier(e) && e.text === "String" && node.arguments[0]) return again(node.arguments[0]);
    if (ts.isIdentifier(e)) {
      const fns = declsOf(e).filter((d) => d.kind === "function");
      if (fns.length) return fns.flatMap((d) => returnedExprs(d.node)).flatMap(again);
    }
    return [{ ref: e.getText() }];
  }
  if (ts.isIdentifier(node)) {
    // (declsOf also returns `name.x = …` assignments, for headers; they are not the name's value)
    const ds = declsOf(node).filter((d) => d.kind === "value" && !(ts.isBinaryExpression(d.node) && d.node.operatorToken.kind === ts.SyntaxKind.EqualsToken));
    if (ds.length) return ds.flatMap((d) => again(d.node));
    return [{ ref: node.text }];
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "";
    let base: ts.Node = node.expression;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base) || ts.isNonNullExpression(base) || ts.isParenthesizedExpression(base)) base = base.expression;
    // A property of a same-file object literal: read the property's value.
    if (ts.isIdentifier(node.expression) && name) {
      for (const d of declsOf(node.expression)) {
        if (d.kind === "value" && ts.isObjectLiteralExpression(d.node)) {
          const p = d.node.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText().replace(/["']/g, "") === name);
          if (p && ts.isPropertyAssignment(p)) return again(p.initializer);
        }
      }
    }
    return [{ ref: name || node.getText(), base: base.getText() }];
  }
  return [{ ref: node.getText().slice(0, 80) }];
}

export function isResolveUrl(node: ts.Node): boolean {
  return pieces(node, "tail").some((p) =>
    "text" in p ? RESOLVE_TAIL.test(p.text) && !AUTH_ROUTE_TAIL.test(p.text) : RESOLVE_NAME.test(p.ref.replace(/^.*\./, "")),
  );
}
export function isCallerUrl(node: ts.Node): boolean {
  return pieces(node, "head").some((p) => "ref" in p && p.base !== undefined && CALLER_BASE.test(p.base));
}

export type ResolveSite = {
  file: string;
  line: number;
  via?: string;
  authed: boolean;
  callerUrl: boolean; // the URL can start with a value read off a request (see CALLER_BASE)
  guarded: boolean; // the key goes through selfAuthHeaders, which attaches it only to the self URL
};

export function sweepResolveFile(path: string): ResolveSite[] {
  return sweepCalls(path, { match: isResolveUrl, needWrites: false }).map((s) => {
    const hdrText = s.init ? headerExprs(s.init).map((h) => expanded(h, 3, { functions: true })).join("\n") : "";
    const guarded = KEY_GUARD.test(hdrText);
    return {
      file: s.file,
      line: s.line,
      ...(s.via ? { via: s.via } : {}),
      // selfAuthHeaders is the credential on the self URL; it is judged as authed even where its module
      // cannot be followed (it lives in lib/self-auth.ts).
      authed: s.authed || guarded,
      callerUrl: s.urlArg !== "self" && isCallerUrl(s.urlArg),
      guarded,
    };
  });
}

export function sweepResolveSrc(): ResolveSite[] {
  return listTs(SRC_ROOT)
    .flatMap((p) => sweepResolveFile(p))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

export const describeResolveSite = (s: ResolveSite): string => `${s.file}:${s.line}${s.via ? ` via ${s.via}` : ""}`;
