// PROTECTED: the open admission rules (src/judge-rules/routing-admission.ts) are pure, reached by one edge, and clamped
// (DESIGN §2.2-§2.3, the routing addendum A4).
//   PURITY  no I/O, clock, randomness, environment or replay-detection in src/judge-rules/**: no process, globalThis,
//           Bun, Date, Math.random, performance, fetch, require, eval, Function, import.meta, dynamic import(),
//           .stack, any __*ForTests, and no top-level statement with effects. Value imports only from other
//           src/judge-rules files; type imports from anywhere.
//   EDGE    the only src file that imports src/judge-rules/ is src/resolvers/compose-admission-core.ts, taking exactly
//           admitCompose.
//   CLAMP   the rules cannot loosen the closed floor (a floor refusal stands whatever they answer), and a refusal they
//           add is only scope_excluded naming an entry the input's scope port returned; anything else (an extra key,
//           a non-boolean, another stage, a forged entry) is refused and the floor answers.
// Every checker is shown red on a synthetic mutant (a checker that cannot fail is not a check).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { clampAdmission, composeAdmission, floorAdmission, type ComposeAdmissionInput } from "../../src/resolvers/compose-admission-core.js";

const ROOT = join(import.meta.dir, "..", "..");
const RULES_DIR = "src/judge-rules";
const ALLOWED_VALUE_IMPORTS = new Set<string>([]);
const EDGE_FILE = "src/resolvers/compose-admission-core.ts";
const EDGE_NAMES = ["admitCompose"];
const BANNED_IDS = new Set(["process", "globalThis", "Bun", "Date", "performance", "fetch", "require", "eval", "Function", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Worker", "WebAssembly", "XMLHttpRequest", "crypto"]);

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(e)) out.push(relative(ROOT, p)); } };
  walk(join(ROOT, dir));
  return out.sort();
}
const sf = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, v: (n: ts.Node) => void): void { v(n); n.forEachChild((c) => walk(c, v)); }

/** Purity offences in one rules file's text. */
export function purityOffences(name: string, text: string): string[] {
  const bad: string[] = [];
  const src = sf(name, text);
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const typeOnly = !!st.importClause?.isTypeOnly || (!!st.importClause && !st.importClause.name && !!st.importClause.namedBindings && ts.isNamedImports(st.importClause.namedBindings) && st.importClause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!st.importClause) bad.push(`side-effect import ${spec}`);
      else if (!typeOnly && !ALLOWED_VALUE_IMPORTS.has(spec) && !spec.startsWith("./")) bad.push(`value import ${spec}`);
      continue;
    }
    if (ts.isExportDeclaration(st)) { if (st.moduleSpecifier && !st.isTypeOnly && !(st.moduleSpecifier as ts.StringLiteral).text.startsWith("./")) bad.push("re-export from outside the rules"); continue; }
    if (ts.isFunctionDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const i = d.initializer;
        const ok = !i || ts.isRegularExpressionLiteral(i) || ts.isStringLiteral(i) || ts.isNumericLiteral(i) || ts.isNoSubstitutionTemplateLiteral(i) || ts.isArrowFunction(i) || ts.isFunctionExpression(i) || ts.isArrayLiteralExpression(i) || ts.isObjectLiteralExpression(i) || i.kind === ts.SyntaxKind.TrueKeyword || i.kind === ts.SyntaxKind.FalseKeyword || i.kind === ts.SyntaxKind.NullKeyword || (ts.isAsExpression(i) && (ts.isArrayLiteralExpression(i.expression) || ts.isObjectLiteralExpression(i.expression)));
        if (!ok) bad.push(`top-level initializer with possible effects (${ts.SyntaxKind[i!.kind]})`);
      }
      continue;
    }
    bad.push(`top-level statement ${ts.SyntaxKind[st.kind]}`);
  }
  walk(src, (n) => {
    if (ts.isIdentifier(n) && BANNED_IDS.has(n.text)) {
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isPropertySignature(p) || (ts.isMethodDeclaration(p) && p.name === n);
      if (!isPropName) bad.push(`uses ${n.text}`);
    }
    if (ts.isIdentifier(n) && /^__\w*ForTests$/.test(n.text)) bad.push(`uses ${n.text}`);
    if (ts.isPropertyAccessExpression(n) && n.name.text === "random" && ts.isIdentifier(n.expression) && n.expression.text === "Math") bad.push("uses Math.random");
    if (ts.isPropertyAccessExpression(n) && n.name.text === "stack") bad.push("reads .stack");
    if (ts.isMetaProperty(n)) bad.push("uses import.meta");
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) bad.push("dynamic import()");
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && BANNED_IDS.has(n.expression.text)) bad.push(`indexes ${n.expression.text}`);
  });
  return bad;
}

/** Value imports of src/judge-rules/ across src/, as `file: names`. */
export function ruleEdges(sources: Array<[string, string]>): string[] {
  const out: string[] = [];
  for (const [name, text] of sources) {
    if (name.startsWith(`${RULES_DIR}/`)) continue;
    if (!text.includes("judge-rules")) continue; // no specifier can name the rules without the directory name
    walk(sf(name, text), (n) => {
      if (ts.isImportDeclaration(n) && /judge-rules/.test((n.moduleSpecifier as ts.StringLiteral).text)) {
        const c = n.importClause;
        if (c?.isTypeOnly) return;
        const names = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : ["*"];
        if (c?.name) names.push("default");
        out.push(`${name}: ${names.sort().join(",")}`);
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && /judge-rules/.test((n.moduleSpecifier as ts.StringLiteral).text)) out.push(`${name}: re-export`);
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /judge-rules/.test(n.arguments[0].text)) out.push(`${name}: dynamic`);
    });
  }
  return out.sort();
}

const RULE_FILES = files(RULES_DIR);
const SRC = files("src").map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as [string, string]);

describe("PURITY: src/judge-rules/ does no I/O and cannot tell replay from production", () => {
  test("there is at least one rules file", () => { expect(RULE_FILES.length).toBeGreaterThan(0); });
  for (const f of RULE_FILES) test(`${f} is pure`, () => { expect(purityOffences(f, readFileSync(join(ROOT, f), "utf8"))).toEqual([]); });
  const ok = 'import type { ComposeAdmissionInput } from "../resolvers/compose-admission-core.js";\nconst R = /x/;\nexport function f(i: ComposeAdmissionInput): boolean { return R.test(i.gap_id); }\n';
  test("positive control: a type import and a regex constant are pure", () => { expect(purityOffences("ok.ts", ok)).toEqual([]); });
  const mutants: Array<[string, string]> = [
    ["process.env", 'export function f(): boolean { return process.env.X === "1"; }\n'],
    ["globalThis flag", "export function f(): boolean { return (globalThis as any).__replay === true; }\n"],
    ["Date.now", "export function f(): number { return Date.now(); }\n"],
    ["Math.random", "export function f(): number { return Math.random(); }\n"],
    ["stack", "export function f(): string { return new Error().stack ?? ''; }\n"],
    ["fetch", "export async function f(): Promise<unknown> { return fetch('http://x'); }\n"],
    ["node:fs value import", 'import { readFileSync } from "node:fs";\nexport function f(): string { return readFileSync("/x", "utf8"); }\n'],
    ["core value import", 'import { admissionFellBack } from "../resolvers/compose-admission-core.js";\nexport function f(): number { return admissionFellBack.count; }\n'],
    ["dynamic import", 'export async function f(): Promise<unknown> { return import("node:fs"); }\n'],
    ["import.meta", "export function f(): string { return import.meta.dir; }\n"],
    ["top-level call", "const T = Symbol.for('x');\nexport function f(): symbol { return T; }\n"],
    ["Bun", "export function f(): string { return Bun.version; }\n"],
  ];
  for (const [label, text] of mutants) test(`MUTANT ${label} is red`, () => { expect(purityOffences("m.ts", text).length).toBeGreaterThan(0); });
});

describe("EDGE: only the admission core imports the rules, taking exactly admitCompose", () => {
  const want = [`${EDGE_FILE}: admitCompose`];
  test(`the only edge is ${EDGE_FILE}: admitCompose`, () => { expect(ruleEdges(SRC)).toEqual(want); });
  test("MUTANT feature-compose.ts calling the rules directly (off the floor and clamp) is red", () => {
    const m = SRC.map(([f, t]) => [f, f === "src/resolvers/feature-compose.ts" ? `${t}\nimport { admitCompose } from "../judge-rules/routing-admission.js";\n` : t] as [string, string]);
    expect(ruleEdges(m)).not.toEqual(want);
  });
  test("MUTANT a dynamic import of the rules elsewhere is red", () => {
    const m = SRC.map(([f, t]) => [f, f === "src/resolvers/feature-compose.ts" ? `${t}\nexport async function z() { return (await import("../judge-rules/routing-admission.js")).admitCompose; }\n` : t] as [string, string]);
    expect(ruleEdges(m)).not.toEqual(want);
  });
});

describe("CLAMP: the rules can only add a scope refusal the input supports", () => {
  const SITE = "repos/v/src/x.ts";
  const i = (over: Partial<ComposeAdmissionInput> = {}): ComposeAdmissionInput => ({
    schema: 1, entry: "composeAdmission", gap_id: "route-edit-x", lane: "undirected", land: true, supply_marker: false, stored: "absent",
    operator_hold: false, why: null, supply_verdict: null, edit_site: SITE,
    scope: { [SITE]: "repos/v/src/x.ts" }, scope_reason: null, ...over,
  });
  test("positive controls: admit, and a scope refusal naming the recorded entry, pass", () => {
    expect(clampAdmission(i(), { admit: true, refusal: null })).toEqual({ admit: true, refusal: null });
    expect(clampAdmission(i(), { admit: false, refusal: { stage: "scope_excluded", verdict: "REFUSED", excluded_by: "repos/v/src/x.ts" } }))
      .toEqual({ admit: false, refusal: { stage: "scope_excluded", verdict: "REFUSED", excluded_by: "repos/v/src/x.ts" } });
  });
  const bad: Array<[string, unknown, ComposeAdmissionInput]> = [
    ["extra key", { admit: true, refusal: null, compose_mode: "test_writing" }, i()],
    ["non-boolean admit", { admit: "yes", refusal: null }, i()],
    ["admit with a refusal", { admit: true, refusal: { stage: "scope_excluded", verdict: "REFUSED", excluded_by: "repos/v/src/x.ts" } }, i()],
    ["another stage", { admit: false, refusal: { stage: "operator_hold", verdict: "BUSY", excluded_by: null } }, i()],
    ["a forged excluding entry", { admit: false, refusal: { stage: "scope_excluded", verdict: "REFUSED", excluded_by: "repos/v/src/" } }, i()],
    ["a scope refusal with no scope port", { admit: false, refusal: { stage: "scope_excluded", verdict: "REFUSED", excluded_by: "repos/v/src/x.ts" } }, i({ scope: null })],
    ["BUSY instead of REFUSED", { admit: false, refusal: { stage: "scope_excluded", verdict: "BUSY", excluded_by: "repos/v/src/x.ts" } }, i()],
  ];
  for (const [label, out, inp] of bad) test(`MUTANT ${label} is refused`, () => { expect(clampAdmission(inp, out)).toBeNull(); });
  test("the floor's refusals stand whatever the rules answer (the rules are not consulted)", () => {
    for (const inp of [i({ stored: "unreadable" }), i({ stored: "present", operator_hold: true }), i({ stored: "present", why: "unarmed" }), i({ supply_marker: true })]) {
      expect(composeAdmission(inp).admit).toBe(false);
      expect(floorAdmission(inp).admit).toBe(false);
    }
  });
});
