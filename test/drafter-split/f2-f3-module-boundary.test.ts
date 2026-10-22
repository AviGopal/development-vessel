// F2 + F3 (MUST-FAILS): THE OPEN DRAFTER MODULE IS PURE, AND ONE CLOSED SITE IMPORTS IT.
//
// F2, purity (static, on the TypeScript AST, so comments and strings never count): every file under src/drafter/
//   - imports only type-only modules, node:path, other src/drafter/ files, and the pure renderers on ALLOWED_OUTSIDE
//     (open -> closed is allowed: the lane cannot change their behaviour);
//   - names none of: fetch, Bun, process, globalThis, require, eval, Function, console, Date, Math.random, setTimeout,
//     setInterval, setImmediate, queueMicrotask, Worker, WebAssembly, import.meta, a dynamic import(), any __*ForTests;
//   - has only declarations at top level (no call or `new` runs when the module loads);
//   - re-exports nothing from outside src/drafter/ (a lane-editable re-export could be swapped for a loosened copy).
// F3, the edge: the only src file that imports src/drafter/ is src/resolvers/feature-compose.ts, by ONE dynamic
//   import() inside resolveFeatureComposeInner that destructures exactly planDrafterReads and assembleDrafterContext;
//   no src/judge file, retry-evidence.ts or any other file imports it, statically, dynamically or type-only.
//   The site's specifier may be computed in ONE form only (drafting-as-activities 1.2, USER RULING 2026-10-22 "One
//   site, computed + allowlist"): `../drafter/variants/${drafterVariantAllowlisted(id)}/index.js`, alone or as one
//   branch of a conditional whose other branch is a literal into src/drafter/; the guard must be declared in
//   feature-compose.ts and test the allowlist /^drafter-v[0-9]+[a-z0-9-]*$/. Every other computed specifier is refused.
// Every checker has a positive control on synthetic source below (the named mutants), so each has been seen red.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const DRAFTER_DIR = "src/drafter/";
const CORE = "src/resolvers/feature-compose.ts";
const ALLOWED_OUTSIDE = ["src/control-bytes.ts", "src/resolvers/region-probe.ts", "src/cross-file-symbols.ts"];
const FORBIDDEN_NAMES = new Set(["fetch", "Bun", "process", "globalThis", "require", "eval", "Function", "console", "Date", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Worker", "WebAssembly", "XMLHttpRequest", "WebSocket"]);
const ENTRY_SYMBOLS = ["assembleDrafterContext", "planDrafterReads"];
const VARIANT_PREFIX = "../drafter/variants/";
const VARIANT_SUFFIX = "/index.js";
const VARIANT_GUARD = "drafterVariantAllowlisted";
const VARIANT_ID_SOURCE = "/^drafter-v[0-9]+[a-z0-9-]*$/";

const sf = (name: string, text: string): ts.SourceFile => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void { visit(n); n.forEachChild((c) => walk(c, visit)); }
function listTs(dirRel: string): string[] {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const e of readdirSync(join(ROOT, d))) {
      const p = `${d}${e}`;
      if (statSync(join(ROOT, p)).isDirectory()) rec(`${p}/`);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
    }
  };
  rec(dirRel);
  return out.sort();
}
function resolveSpec(fromRel: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  const base = join(ROOT, fromRel, "..", spec);
  for (const c of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    try { if (statSync(c).isFile()) return relative(ROOT, c); } catch { /* next */ }
  }
  return relative(ROOT, base.replace(/\.js$/, ".ts"));
}
const isTypeOnlyImport = (n: ts.ImportDeclaration): boolean => !!n.importClause && (n.importClause.isTypeOnly
  || (!n.importClause.name && !!n.importClause.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && n.importClause.namedBindings.elements.length > 0 && n.importClause.namedBindings.elements.every((e) => e.isTypeOnly)));

/** F2: the purity offenders of one open file. */
export function purityOffenders(rel: string, text: string): string[] {
  const bad: string[] = [];
  const src = sf(rel, text);
  const importedOutside = new Set<string>();
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      if (isTypeOnlyImport(st)) continue;
      const r = resolveSpec(rel, spec);
      const ok = spec === "node:path" || r.startsWith(DRAFTER_DIR) || ALLOWED_OUTSIDE.includes(r);
      if (!ok) bad.push(`import ${spec}`);
      if (!r.startsWith(DRAFTER_DIR)) {
        const c = st.importClause;
        if (c?.name) importedOutside.add(c.name.text);
        if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) importedOutside.add(e.name.text);
        if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) importedOutside.add(c.namedBindings.name.text);
      }
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !resolveSpec(rel, st.moduleSpecifier.text).startsWith(DRAFTER_DIR)) bad.push(`re-export from ${st.moduleSpecifier.text}`);
      if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) if (importedOutside.has((e.propertyName ?? e.name).text)) bad.push(`re-export of ${(e.propertyName ?? e.name).text}`);
      continue;
    }
    if (ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st)) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!d.initializer) continue;
        walk(d.initializer, (n) => {
          if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
          let inFn = false;
          for (let p: ts.Node | undefined = n.parent; p && p !== d; p = p.parent) if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) inFn = true;
          if (!inFn && (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n))) bad.push(`top-level effect: ${n.getText(src).slice(0, 60)}`);
        });
      }
      continue;
    }
    bad.push(`top-level statement: ${st.getText(src).slice(0, 60)}`);
  }
  walk(src, (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isMemberName = p && (ts.isPropertyAccessExpression(p) && p.name === n || ts.isPropertyAssignment(p) && p.name === n || ts.isPropertySignature(p) && p.name === n || ts.isMethodDeclaration(p) && p.name === n || ts.isBindingElement(p) && p.propertyName === n || ts.isImportSpecifier(p) || ts.isExportSpecifier(p));
      if (!isMemberName && FORBIDDEN_NAMES.has(n.text)) bad.push(`names ${n.text}`);
      if (/^__\w+ForTests$/.test(n.text)) bad.push(`names ${n.text}`);
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Math" && n.name.text === "random") bad.push("names Math.random");
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) bad.push("dynamic import()");
    if (ts.isMetaProperty(n)) bad.push("import.meta");
  });
  return [...new Set(bad)];
}

const unparen = (e: ts.Expression): ts.Expression => { while (ts.isParenthesizedExpression(e)) e = e.expression; return e; };
/** The guarded variant template: `../drafter/variants/${drafterVariantAllowlisted(<one arg>)}/index.js`, nothing else. */
function guardedVariantTemplate(e: ts.Expression): boolean {
  e = unparen(e);
  if (!ts.isTemplateExpression(e) || e.head.text !== VARIANT_PREFIX || e.templateSpans.length !== 1) return false;
  const span = e.templateSpans[0]!;
  const x = span.expression;
  return span.literal.text === VARIANT_SUFFIX && ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === VARIANT_GUARD && x.arguments.length === 1;
}
/** 1.2: the one computed specifier F3 admits: the guarded template, alone or as a branch of a conditional whose other branch is a literal into src/drafter/. */
function admittedComputedSpecifier(e: ts.Expression, intoDrafter: (spec: string) => boolean): boolean {
  e = unparen(e);
  if (ts.isConditionalExpression(e)) {
    const branch = (b: ts.Expression): boolean => { const u = unparen(b); return (ts.isStringLiteral(u) && intoDrafter(u.text)) || guardedVariantTemplate(u); };
    return branch(e.whenTrue) && branch(e.whenFalse) && (guardedVariantTemplate(e.whenTrue) || guardedVariantTemplate(e.whenFalse));
  }
  return guardedVariantTemplate(e);
}
/** 1.2: the guard a computed site relies on: one top-level declaration in the file, testing exactly the allowlist. */
export function variantGuardOffenders(rel: string, text: string): string[] {
  const src = sf(rel, text);
  const decls = src.statements.filter((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === VARIANT_GUARD);
  if (decls.length !== 1) return [`${rel}: ${decls.length} top-level declaration(s) of ${VARIANT_GUARD} (exactly 1 expected)`];
  let tests = false;
  walk(decls[0]!, (n) => { if (n.kind === ts.SyntaxKind.RegularExpressionLiteral && n.getText(src) === VARIANT_ID_SOURCE) tests = true; });
  return tests ? [] : [`${rel}: ${VARIANT_GUARD} does not test the allowlist ${VARIANT_ID_SOURCE}`];
}

/** F3: every runtime-or-type import of src/drafter/ from one non-drafter file, with where it sits. */
export function drafterEdges(rel: string, text: string): Array<{ kind: "static" | "dynamic" | "type"; fn: string | null; symbols: string[]; computed?: true }> {
  const out: Array<{ kind: "static" | "dynamic" | "type"; fn: string | null; symbols: string[]; computed?: true }> = [];
  const src = sf(rel, text);
  const intoDrafter = (spec: string): boolean => resolveSpec(rel, spec).startsWith(DRAFTER_DIR);
  walk(src, (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && intoDrafter(n.moduleSpecifier.text)) {
      out.push({ kind: ts.isImportDeclaration(n) && isTypeOnlyImport(n) ? "type" : "static", fn: null, symbols: ["*"] });
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal) && intoDrafter(n.argument.literal.text)) out.push({ kind: "type", fn: null, symbols: ["*"] });
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      const computed = !!a && !ts.isStringLiteral(a) && admittedComputedSpecifier(a, intoDrafter);
      if (!a || (!ts.isStringLiteral(a) && !computed)) { out.push({ kind: "dynamic", fn: null, symbols: ["* (non-literal specifier)"] }); return; }
      if (ts.isStringLiteral(a) && !intoDrafter(a.text)) return;
      let fn: string | null = null;
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.name) { fn = p.name.text; break; }
      let e: ts.Node = n;
      while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isAwaitExpression(e.parent))) e = e.parent;
      const p = e.parent;
      const symbols: string[] = [];
      if (p && ts.isVariableDeclaration(p) && p.initializer === e && ts.isObjectBindingPattern(p.name)) {
        for (const b of p.name.elements) { const key = b.propertyName ?? b.name; symbols.push(!b.dotDotDotToken && ts.isIdentifier(key) ? key.text : "*"); }
      } else symbols.push("*");
      out.push({ kind: "dynamic", fn, symbols: symbols.sort(), ...(computed ? { computed: true as const } : {}) });
    }
  });
  return out;
}
/** F3 verdict over a set of files: the offending edges (empty = the pin holds). */
export function edgeOffenders(files: Array<{ rel: string; text: string }>): string[] {
  const bad: string[] = [];
  let sites = 0;
  for (const f of files) {
    for (const e of drafterEdges(f.rel, f.text)) {
      const ok = f.rel === CORE && e.kind === "dynamic" && e.fn === "resolveFeatureComposeInner" && JSON.stringify(e.symbols) === JSON.stringify(ENTRY_SYMBOLS);
      if (ok && e.computed) bad.push(...variantGuardOffenders(f.rel, f.text));
      if (ok) sites++;
      else bad.push(`${f.rel}: ${e.kind} import of src/drafter/${e.fn ? ` in ${e.fn}` : ""} taking [${e.symbols.join(", ")}]`);
    }
  }
  if (sites !== 1) bad.push(`${CORE}: ${sites} dynamic import site(s) of src/drafter/ in resolveFeatureComposeInner (exactly 1 expected)`);
  return bad;
}

const drafterFiles = listTs(DRAFTER_DIR);
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("F2: every src/drafter/ file is pure", () => {
  it("the module has its entry and its parts", () => {
    expect(drafterFiles).toContain("src/drafter/index.ts");
    expect(drafterFiles.length).toBeGreaterThanOrEqual(2);
  });
  for (const rel of drafterFiles) it(`${rel}: no I/O, no ambient authority, declarations only at top level, no re-export of an outside name`, () => {
    expect(purityOffenders(rel, read(rel))).toEqual([]);
  });
  it("index.ts exports exactly the two entry points at runtime", () => {
    const src = sf("src/drafter/index.ts", read("src/drafter/index.ts"));
    const exported: string[] = [];
    for (const st of src.statements) {
      const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : [];
      if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isFunctionDeclaration(st) && st.name) exported.push(st.name.text);
      else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) exported.push(d.name.getText(src));
      else if (ts.isClassDeclaration(st) && st.name) exported.push(st.name.text);
    }
    expect(exported.sort()).toEqual(ENTRY_SYMBOLS);
  });
  describe("positive controls (named mutants, each seen red)", () => {
    const ok = 'import type { DrafterFacts } from "./types.js";\nimport { focusedSlice } from "./windows.js";\nimport { renderWindowForDrafter } from "../control-bytes.js";\nconst N = 4;\nconst RE = /x/g;\nconst T = { a: "b" };\nconst f = (s: string): string => s.trim();\nexport function g(x: DrafterFacts): number { return N + String(x).length + f("").length; }\n';
    it("CONTROL: a pure file passes", () => { expect(purityOffenders("src/drafter/m.ts", ok)).toEqual([]); });
    const mutants: Array<[string, string, RegExp]> = [
      ["MUTANT readFileSync import", 'import { readFileSync } from "node:fs";\n' + ok, /import node:fs/],
      ["MUTANT fetch( inside a function", ok + "export async function h(): Promise<unknown> { return fetch(\"http://x\"); }\n", /names fetch/],
      ["MUTANT re-export of a closed name", ok + 'export { checkOpNoEffect } from "../resolvers/retry-evidence.js";\n', /re-export from/],
      ["MUTANT top-level globalThis write", ok + "globalThis.x = 1;\n", /top-level statement|names globalThis/],
      ["MUTANT process.env read", ok + "export function e(): string { return process.env.X ?? \"\"; }\n", /names process/],
      ["MUTANT dynamic import()", ok + "export async function d(): Promise<unknown> { return import(\"../resolvers/feature-compose.js\"); }\n", /dynamic import/],
      ["MUTANT Bun.spawn", ok + "export function s(): unknown { return Bun.spawn([\"ls\"]); }\n", /names Bun/],
      ["MUTANT top-level call", ok + "const BOOT = f(\"x\");\n", /top-level effect/],
      ["MUTANT Math.random", ok + "export function r(): number { return Math.random(); }\n", /Math.random/],
      ["MUTANT console", ok + "export function c(): void { console.log(1); }\n", /names console/],
      ["MUTANT a test hook", ok + "export function __setForTests(): void {}\n", /__setForTests/],
      ["MUTANT re-export of an imported outside binding", ok + "export { renderWindowForDrafter };\n", /re-export of renderWindowForDrafter/],
    ];
    for (const [name, text, why] of mutants) it(`${name} is red`, () => { expect(purityOffenders("src/drafter/m.ts", text).join("; ")).toMatch(why); });
    it("CONTROL: a comment or string naming fetch / process does not count", () => {
      expect(purityOffenders("src/drafter/m.ts", ok + '// fetch( process.env\nexport const S = "fetch(process.env)";\n')).toEqual([]);
    });
  });
});

describe("F3: only feature-compose.ts imports src/drafter/, dynamically, at one site, taking the two entry points", () => {
  const files = listTs("src/").filter((r) => !r.startsWith(DRAFTER_DIR)).map((rel) => ({ rel, text: read(rel) }));
  it("the live tree holds the pin", () => { expect(edgeOffenders(files)).toEqual([]); });
  it("retry-evidence.ts and every src/judge/ file import nothing from src/drafter/", () => {
    for (const f of files.filter((x) => x.rel === "src/resolvers/retry-evidence.ts" || x.rel.startsWith("src/judge/"))) expect({ file: f.rel, edges: drafterEdges(f.rel, f.text) }).toEqual({ file: f.rel, edges: [] });
  });
  describe("positive controls (named mutants, each seen red)", () => {
    const core = files.find((f) => f.rel === CORE)!;
    const swap = (rel: string, text: string) => files.map((f) => (f.rel === rel ? { rel, text } : f));
    it("MUTANT a static top-level import in feature-compose.ts is red", () => {
      expect(edgeOffenders(swap(CORE, 'import { planDrafterReads } from "../drafter/index.js";\n' + core.text)).join("; ")).toMatch(/static import/);
    });
    it("MUTANT a third destructured symbol is red", () => {
      const t = core.text.replace("const { planDrafterReads, assembleDrafterContext } = await import(", "const { planDrafterReads, assembleDrafterContext, VERSION } = await import(");
      expect(t).not.toBe(core.text);
      expect(edgeOffenders(swap(CORE, t)).join("; ")).toMatch(/VERSION/);
    });
    it("MUTANT gap-admission.ts importing src/drafter/types.js as a value is red", () => {
      const rel = "src/judge/gap-admission.ts";
      const ga = files.find((f) => f.rel === rel)!;
      expect(edgeOffenders(swap(rel, 'import { DrafterFacts } from "../drafter/types.js";\n' + ga.text)).join("; ")).toMatch(/gap-admission\.ts: static import/);
    });
    it("MUTANT retry-evidence.ts importing src/drafter/ (type-only) is red", () => {
      const rel = "src/resolvers/retry-evidence.ts";
      const re = files.find((f) => f.rel === rel)!;
      expect(edgeOffenders(swap(rel, 'import type { DrafterFacts } from "../drafter/types.js";\n' + re.text)).join("; ")).toMatch(/retry-evidence\.ts: type import/);
    });
    it("MUTANT the dynamic import moved out of resolveFeatureComposeInner (a second site) is red", () => {
      expect(edgeOffenders(swap(CORE, core.text + '\nexport async function early() { const { planDrafterReads, assembleDrafterContext } = await import("../drafter/index.js"); return [planDrafterReads, assembleDrafterContext]; }\n')).join("; ")).toMatch(/in early/);
    });
  });
});

// ── drafting-as-activities 1.2: the pins extended over src/drafter/variants/ (NEW cases only) ──────────────────────
describe("F2 over src/drafter/variants/: a variant is held to the same purity", () => {
  const okVariant = 'import type { DrafterFacts } from "../../types.js";\nimport { focusedSlice } from "../../windows.js";\nexport function planDrafterReads(f: DrafterFacts): unknown { return { reads: [], n: String(f).length + String(focusedSlice).length }; }\nexport function assembleDrafterContext(f: DrafterFacts): unknown { return { version: "drafter-v2-x", f }; }\n';
  const VREL = "src/drafter/variants/drafter-v2-x/index.ts";
  it("every file listed under src/drafter/ includes the variants directory (the listing recurses)", () => {
    expect(drafterFiles.filter((r) => r.startsWith("src/drafter/variants/")).every((r) => r.startsWith(DRAFTER_DIR))).toBe(true);
    expect(listTs(DRAFTER_DIR)).toEqual(drafterFiles);
  });
  it("CONTROL: a pure variant importing the module's own parts passes", () => { expect(purityOffenders(VREL, okVariant)).toEqual([]); });
  const mutants: Array<[string, string, RegExp]> = [
    ["MUTANT a variant importing the closed core", 'import { MAX_DRAFT_PROMPT_BYTES } from "../../../resolvers/feature-compose.js";\n' + okVariant, /import \.\.\/\.\.\/\.\.\/resolvers\/feature-compose\.js/],
    ["MUTANT a variant calling fetch", okVariant + "export async function h(): Promise<unknown> { return fetch(\"http://x\"); }\n", /names fetch/],
    ["MUTANT a variant with a dynamic import()", okVariant + "export async function d(): Promise<unknown> { return import(\"../../index.js\"); }\n", /dynamic import/],
    ["MUTANT a variant re-exporting a closed name", okVariant + 'export { checkOpNoEffect } from "../../../resolvers/retry-evidence.js";\n', /re-export from/],
  ];
  for (const [name, text, why] of mutants) it(`${name} is red`, () => { expect(purityOffenders(VREL, text).join("; ")).toMatch(why); });
});

describe("F3 over src/drafter/variants/: one site, computed only through the allowlist guard", () => {
  const files = listTs("src/").filter((r) => !r.startsWith(DRAFTER_DIR)).map((rel) => ({ rel, text: read(rel) }));
  const core = files.find((f) => f.rel === CORE)!;
  const swap = (rel: string, text: string) => files.map((f) => (f.rel === rel ? { rel, text } : f));
  const SITE = "`../drafter/variants/${drafterVariantAllowlisted(named)}/index.js`";
  const mutate = (from: string, to: string): string => { const t = core.text.replace(from, to); expect(t).not.toBe(core.text); return t; };
  it("the live tree's single site is the admitted computed form, guarded, taking the two entry points", () => {
    const edges = drafterEdges(CORE, core.text);
    expect(edges).toEqual([{ kind: "dynamic", fn: "resolveFeatureComposeInner", symbols: ENTRY_SYMBOLS, computed: true }]);
    expect(core.text).toContain(SITE);
    expect(variantGuardOffenders(CORE, core.text)).toEqual([]);
  });
  it("MUTANT a computed path outside the prefix is red", () => {
    expect(edgeOffenders(swap(CORE, mutate("`../drafter/variants/${", "`../resolvers/${"))).join("; ")).toMatch(/non-literal specifier/);
  });
  it("MUTANT a computed suffix that climbs out of the variant directory is red", () => {
    expect(edgeOffenders(swap(CORE, mutate("(named)}/index.js`", "(named)}/../../resolvers/x.js`"))).join("; ")).toMatch(/non-literal specifier/);
  });
  it("MUTANT an id not checked against the allowlist (unguarded) is red", () => {
    expect(edgeOffenders(swap(CORE, mutate("${drafterVariantAllowlisted(named)}", "${named}"))).join("; ")).toMatch(/non-literal specifier/);
  });
  it("MUTANT the guard's allowlist loosened is red", () => {
    expect(edgeOffenders(swap(CORE, mutate("!/^drafter-v[0-9]+[a-z0-9-]*$/.test(id)", "!/^drafter-v/.test(id)"))).join("; ")).toMatch(/does not test the allowlist/);
  });
  it("MUTANT the guard declared twice (or removed) is red", () => {
    expect(edgeOffenders(swap(CORE, mutate("export function drafterVariantAllowlisted(id: string): string {", "export function drafterVariantAllowlistedX(id: string): string {"))).join("; ")).toMatch(/0 top-level declaration\(s\) of drafterVariantAllowlisted/);
  });
  it("MUTANT the conditional's literal branch pointing outside src/drafter/ is red", () => {
    expect(edgeOffenders(swap(CORE, mutate('named === null || named === DRAFTER_DEFAULT_VARIANT ? "../drafter/index.js" :', 'named === null || named === DRAFTER_DEFAULT_VARIANT ? "../resolvers/x.js" :'))).join("; ")).toMatch(/non-literal specifier/);
  });
  it("MUTANT a third destructured symbol on the computed site is red (VERSION visible)", () => {
    expect(edgeOffenders(swap(CORE, mutate("const { planDrafterReads, assembleDrafterContext } = await import(", "const { planDrafterReads, assembleDrafterContext, VERSION } = await import("))).join("; ")).toMatch(/VERSION/);
  });
  it("MUTANT a second, computed site (in another function) is red", () => {
    expect(edgeOffenders(swap(CORE, core.text + "\nexport async function early(named: string) { const { planDrafterReads, assembleDrafterContext } = await import(" + SITE + "); return [planDrafterReads, assembleDrafterContext]; }\n")).join("; ")).toMatch(/in early/);
  });
  it("MUTANT another src file importing src/drafter/variants/ is red", () => {
    const rel = "src/judge/gap-admission.ts";
    const ga = files.find((f) => f.rel === rel)!;
    expect(edgeOffenders(swap(rel, 'import { planDrafterReads } from "../drafter/variants/drafter-v2-x/index.js";\n' + ga.text)).join("; ")).toMatch(/gap-admission\.ts: static import/);
  });
});
