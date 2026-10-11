// THE GAP-JUDGE CORE IS CLOSED, AND THE RESIDUE HOLDS NO JUDGE (gap-to-feature judge split, BOUNDARY.md 5 / 10).
//
// The judging functions of src/resolvers/gap-to-feature.ts moved into src/judge/*: gates, verdicts, credit, and the
// inputs to floors. That is only a claim until something fails when it stops being true. This file fails when:
//   (i)   the residue defines, exports or re-exports a core name, or writes a verdict field itself;
//   (ii)  a core module imports anything but node builtins, other core modules and closed files. The residue is
//         never allowed. The closed->residue edges are pinned exactly, by file AND by the residue symbol each one
//         takes (escalateToDecomposition x2, decomposeGap, resolveGapToFeature): any other symbol reddens;
//   (iii) a core module is not an evaluator file and a judge_trust entry, or is not listed as pending the qa act;
//   (iv)  an open src file references a judge-choice or test hook it does not define (F2's __setBirthJudgeForTests
//         and birthJudge, the harm fix's __mintOperatorDirectGrantForTests, build 3's
//         __setPrecutoverBaselineForTests and CUTOVER_LEASE_TTL_MS, DecomposeDeps.judge (a `deps: { judge }` handed
//         to the arming, which no longer reads it), any __*ForTests).
// Every checker has a positive control run on synthetic source, so each must-fail has been seen red.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const RESIDUE = "src/resolvers/gap-to-feature.ts";
/** The core, by name. A seventh module must be added here on purpose, and so reach the act's lists. */
const CORE = ["src/judge/gap-admission.ts", "src/judge/gap-attempt-credit.ts", "src/judge/gap-check-judge.ts", "src/judge/gap-eligibility.ts", "src/judge/gap-landing-verdict.ts", "src/judge/gap-policy.ts"];
/** qa 10.2: CLOSE rulings whose excluded_paths entries ride the same act. They count as closed only through this
 *  explicit list until the act lands, and then they move to the mirror below and this list empties. */
const PENDING_CLOSED = ["src/resolvers/attempt-ledger.ts", "src/lib/operator-hold.ts", "src/test-child-env.ts", "src/resolvers/patch-with-tools.ts", "src/lib/operator-direct.ts"];
/** The core's own entries, pending the same act (excluded_paths, EVALUATOR_FILES, SCOPE_CLASSIFICATION judge_trust). */
const PENDING_ACT = [...CORE, "test/resolvers/judge-modules-closed.test.ts"];
/** Mirror of the committed autonomy-scope excluded_paths for development-vessel src (as evaluator-grant-scan keeps
 *  one: the record lives in the super-repo, not this tree). */
const EXCLUDED_SRC_MIRROR = [
  "src/resolvers/feature-compose.ts", "src/resolvers/vessel-mitosis-cutover.ts", "src/resolvers/pull-cutover.ts",
  "src/resolvers/push-policy.ts", "src/resolvers/git-push.ts", "src/resolvers/gap-to-feature.ts",
  "src/resolvers/substrate-gap.ts", "src/resolvers/apply-proposal-as-patch.ts", "src/resolvers/pool-impulse.ts",
  "src/resolvers/rhythm-conductor-tick.ts", "src/routes/impulses.ts", "src/index.ts", "src/config.ts",
  "src/resolvers/attempt-register.ts", "src/resolvers/gap-lifecycle-scan.ts", "src/resolvers/self-fact-reconcile.ts",
  "src/resolvers/vessel-mitosis-evaluate.ts", "src/lib/caller-credential.ts", "src/lib/self-auth.ts",
  "src/resolvers/write-containment.ts", "src/resolvers/super-repo-checkout.ts", "src/resolvers/behavioral-verification.ts",
  "src/removed-line-predicate.ts", "src/vacuous-edit.ts", "src/resolvers/staged-mitosis-gate.ts", "src/resolvers/retry-evidence.ts",
  "src/resolvers/scope-earn-in.ts", "src/resolvers/test-suite.ts", "src/lib/apply-mutant.ts", "src/lib/evaluator-tree.ts",
  "src/resolvers/check-supply-admission.ts",
];
/** The closed->residue edges, each by design (BOUNDARY.md 3.1), pinned exactly, by the residue SYMBOL each takes, so a
 *  new edge or a new symbol on an existing edge reddens (qa Q1: all four are routing/entry, none a judge input):
 *  feature-compose hands escalations to the residue's escalateToDecomposition (two callbacks); gap-lifecycle-scan asks
 *  the residue's decomposeGap for a parent check (the arming itself is the closed armDecomposition); routes/impulses
 *  dispatches the resolver entry, resolveGapToFeature. None of them reads a verdict from the residue. */
const KNOWN_RESIDUE_EDGES: Record<string, string[]> = {
  "src/resolvers/feature-compose.ts": ["escalateToDecomposition", "escalateToDecomposition"],
  "src/resolvers/gap-lifecycle-scan.ts": ["decomposeGap"],
  "src/routes/impulses.ts": ["resolveGapToFeature"],
};
const DECOMPOSE_JUDGE = /\bdeps\s*:\s*\{[^}]*?\bjudge\b\s*[:,}]/;
const HOOKS = ["__setBirthJudgeForTests", "birthJudge", "__mintOperatorDirectGrantForTests", "__setPrecutoverBaselineForTests", "CUTOVER_LEASE_TTL_MS"];

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const sourceFile = (name: string, text: string): ts.SourceFile => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void { visit(n); n.forEachChild((c) => walk(c, visit)); }
function evaluatorFiles(): string[] {
  const m = read("src/resolvers/scope-earn-in.ts").match(/export const EVALUATOR_FILES[^=]*=\s*\[([\s\S]*?)\];/);
  return m ? [...m[1]!.matchAll(/"repos\/development-vessel\/([^"]+)"/g)].map((x) => x[1]!) : [];
}
const CLOSED = (): Set<string> => new Set([...EXCLUDED_SRC_MIRROR, ...evaluatorFiles(), ...PENDING_CLOSED, ...CORE]);

/** Runtime import specifiers (static, export-from, dynamic), type-only erased. */
export function importsOf(name: string, text: string): string[] {
  const out: string[] = [];
  walk(sourceFile(name, text), (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(n) ? !!n.importClause?.isTypeOnly || (!!n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && !n.importClause.name && n.importClause.namedBindings.elements.length > 0 && n.importClause.namedBindings.elements.every((e) => e.isTypeOnly)) : n.isTypeOnly;
      if (!typeOnly) out.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
  });
  return out;
}
/** The residue symbols one file takes, one entry per binding: named imports by their imported name; a dynamic import
 *  by the property read off it or the names destructured from it. Anything not reducible to names (a namespace, a
 *  default, an import result passed on whole) is "*", which no pin allows. */
export function residueSymbols(fromRel: string, text: string): string[] {
  const out: string[] = [];
  const isResidue = (spec: string): boolean => resolveSpec(fromRel, spec) === RESIDUE;
  walk(sourceFile(fromRel, text), (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && isResidue(n.moduleSpecifier.text)) {
      if (ts.isImportDeclaration(n)) {
        const c = n.importClause;
        if (!c || c.isTypeOnly) { if (!c) out.push("*"); return; }
        if (c.name) out.push("*");
        const nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) out.push("*");
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) out.push((e.propertyName ?? e.name).text);
      } else {
        if (n.isTypeOnly) return;
        if (n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) out.push((e.propertyName ?? e.name).text);
        else out.push("*");
      }
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && isResidue(n.arguments[0].text)) {
      let e: ts.Node = n;
      while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isAwaitExpression(e.parent))) e = e.parent;
      const p = e.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.expression === e) out.push(p.name.text);
      else if (p && ts.isVariableDeclaration(p) && p.initializer === e && ts.isObjectBindingPattern(p.name)) {
        for (const b of p.name.elements) {
          const key = b.propertyName ?? b.name;
          out.push(!b.dotDotDotToken && ts.isIdentifier(key) ? key.text : "*");
        }
      } else out.push("*");
    }
  });
  return out.sort();
}
function resolveSpec(fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(ROOT, fromRel, "..", spec);
  for (const c of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    try { if (statSync(c).isFile()) return relative(ROOT, c); } catch { /* next */ }
  }
  return `unresolved:${spec}`;
}
/** (ii) offenders: imports that are neither node builtins nor closed. */
export function openImports(fromRel: string, text: string, closed: Set<string>): string[] {
  const bad: string[] = [];
  for (const spec of importsOf(fromRel, text)) {
    if (spec.startsWith("node:")) continue;
    const r = resolveSpec(fromRel, spec);
    if (r === null) { if (!/^(typescript|@avigopal\/)/.test(spec)) bad.push(spec); continue; }
    if (r === RESIDUE || !closed.has(r)) bad.push(`${spec} -> ${r}`);
  }
  return bad;
}
/** (i) offenders: residue declarations or exports of core names. */
export function residueJudges(text: string, names: Set<string>): string[] {
  const bad: string[] = [];
  walk(sourceFile("residue.ts", text), (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name && names.has(n.name.text) && n.parent && ts.isSourceFile(n.parent)) bad.push(`declares ${n.name.text}`);
    if (ts.isVariableStatement(n) && ts.isSourceFile(n.parent)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && names.has(d.name.text)) bad.push(`declares ${d.name.text}`);
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) if (names.has(e.name.text)) bad.push(`re-exports ${e.name.text}`);
    if (ts.isExportDeclaration(n) && !n.exportClause && n.moduleSpecifier) bad.push(`export * from ${n.moduleSpecifier.getText()}`);
  });
  return bad;
}
/** (i) verdict-field writes the residue must not make itself. */
const WRITE_MARKERS: Array<[string, RegExp]> = [["status closed", /status:\s*"closed"/], ["failed_attempts write", /\bfailed_attempts\s*:/], ["birthVerdict", /\bbirthVerdict\b/], ["pending_outcome_verification write", /\bpending_outcome_verification\s*:/], ["disposition write", /\bdisposition\s*:/]];
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
/** (iv) offenders: hook references in an open file that does not define the hook. */
export function hookUses(text: string): string[] {
  const code = stripComments(text);
  const defined = new Set([...code.matchAll(/\b(?:function|const|let)\s+(__\w+ForTests)\b/g)].map((m) => m[1]!));
  const used = new Set([...code.matchAll(/\b(__\w+ForTests)\b/g)].map((m) => m[1]!).filter((h) => !defined.has(h)));
  for (const h of HOOKS) if (new RegExp(`\\b${h}\\b`).test(code) && !defined.has(h)) used.add(h);
  // DecomposeDeps.judge: a judge handed to the arming inside its deps (the field is gone and the arming ignores
  // it; a caller writing one is choosing the judge). The name alone is too common to match, so the deps literal is.
  if (DECOMPOSE_JUDGE.test(code)) used.add("DecomposeDeps.judge");
  return [...used].sort();
}

describe("positive controls: each checker flags what it exists to flag", () => {
  it("(i) a declared core name, a re-export and an export-star are flagged; a residue name is not", () => {
    const names = new Set(["closeLandedGap", "landabilityScore"]);
    expect(residueJudges(`export { closeLandedGap } from "../judge/gap-landing-verdict.js";\nfunction landabilityScore() { return 1; }\nexport * from "../judge/gap-policy.js";\nfunction specFromGap() {}`, names))
      .toEqual(["re-exports closeLandedGap", "declares landabilityScore", 'export * from "../judge/gap-policy.js"']);
    // (3) each write marker, alone, is flagged: the positive control of every marker the residue must not contain.
    const samples: Record<string, string> = {
      "status closed": `gap: { id, status: "closed" }`,
      "failed_attempts write": `classification_metadata: { ...meta, failed_attempts: fa }`,
      "birthVerdict": `resolveSubstrateGapWrite(w, { birthVerdict: stamp })`,
      "pending_outcome_verification write": `{ ...meta, pending_outcome_verification: sha }`,
      "disposition write": `{ ...meta, disposition: "pending_verification" }`,
    };
    for (const [k, text] of Object.entries(samples)) expect(WRITE_MARKERS.filter(([, re]) => re.test(stripComments(text))).map(([m]) => m), k).toEqual([k]);
    // ...and a comment or a read is not a write.
    expect(WRITE_MARKERS.filter(([, re]) => re.test(stripComments(`// status: "closed" in a comment\nconst fa = meta.failed_attempts;`))).map(([m]) => m)).toEqual([]);
  });
  it("(ii) an import of the residue (static or dynamic) and of an open module are flagged; builtins and closed files pass", () => {
    const closed = new Set(["src/resolvers/substrate-gap.ts"]);
    expect(openImports("src/judge/x.ts", `import { a } from "../resolvers/substrate-gap.js";\nimport { b } from "node:fs";\nconst m = await import("../resolvers/gap-to-feature.js");\nimport { c } from "../resolvers/dispatch-goal.js";`, closed))
      .toEqual(["../resolvers/gap-to-feature.js -> src/resolvers/gap-to-feature.ts", "../resolvers/dispatch-goal.js -> src/resolvers/dispatch-goal.ts"]);
    // The symbol pin: each form an edge can take, reduced to the residue names it takes, or "*" when it cannot be.
    const R = "../resolvers/gap-to-feature.js";
    expect(residueSymbols("src/lib/x.ts", `import { resolveGapToFeature, decomposeGap as d } from "${R}";\nimport type { T } from "${R}";\nconst a = (await import("${R}")).escalateToDecomposition;\nconst { localizeGap, specFromGap: s } = await import("${R}");\nimport * as all from "${R}";\nconst m = await import("${R}");\nexport { capacitySlices } from "${R}";`))
      .toEqual(["*", "*", "capacitySlices", "decomposeGap", "escalateToDecomposition", "localizeGap", "resolveGapToFeature", "specFromGap"].sort());
    expect(residueSymbols("src/lib/x.ts", `import { a } from "../resolvers/substrate-gap.js";`)).toEqual([]);
    expect(importsOf("x.ts", `import type { T } from "./t.js";\nimport { type U } from "./u.js";\nexport { v } from "./v.js";`)).toEqual(["./v.js"]);
  });
  it("(iv) a foreign hook and a named hook are flagged; a file's own hook is not", () => {
    expect(hookUses(`import { __setBirthJudgeForTests } from "./substrate-gap.js";\nresolveSubstrateGapWrite(x, { birthJudge: async () => "present" });\nexport function __setMineForTests() {}\n__setMineForTests();`))
      .toEqual(["__setBirthJudgeForTests", "birthJudge"]);
    expect(hookUses(`return decomposeGap(row, { ...opts, deps: { ...opts.deps, judge: async () => "present" } });`)).toEqual(["DecomposeDeps.judge"]);
    expect(hookUses(`armDecomposition(p, parsed, { deps: { llm, judge } });`)).toEqual(["DecomposeDeps.judge"]);
    expect(hookUses(`const verdict = { judge: { addresses: true, reason: null } };\nconst d = { deps: { llm: stub } };`)).toEqual([]);
  });
});

describe("the gap-judge core is closed and the residue holds no judge", () => {
  it("MUST-FAIL: src/judge holds exactly the declared core", () => {
    expect(readdirSync(join(ROOT, "src", "judge")).filter((f) => f.endsWith(".ts")).map((f) => `src/judge/${f}`).sort()).toEqual([...CORE].sort());
  });

  it("MUST-FAIL (i): the residue declares, exports and re-exports no core name, and writes no verdict field", async () => {
    const names = new Set<string>();
    for (const m of CORE) for (const k of Object.keys(await import(join(ROOT, m)))) names.add(k);
    expect(names.size).toBeGreaterThan(100);
    const residue = read(RESIDUE);
    expect(residueJudges(residue, names)).toEqual([]);
    const exported = Object.keys(await import(join(ROOT, RESIDUE))).filter((k) => names.has(k));
    expect(exported).toEqual([]);
    const code = stripComments(residue);
    expect(WRITE_MARKERS.filter(([, re]) => re.test(code)).map(([k]) => k)).toEqual([]);
  });

  it("MUST-FAIL (ii): a core module imports only node builtins, other core modules and closed files, never the residue", () => {
    const closed = CLOSED();
    const offenders: string[] = [];
    for (const m of CORE) for (const o of openImports(m, read(m), closed)) offenders.push(`${m}: ${o}`);
    expect(offenders).toEqual([]);
  });

  it("MUST-FAIL (ii): the only closed->residue edges are the pinned ones, each taking only its pinned residue symbols", () => {
    const edges: Record<string, string[]> = {};
    for (const f of [...CLOSED()]) {
      if (f === RESIDUE || CORE.includes(f) || !f.startsWith("src/")) continue;
      let text = "";
      try { text = read(f); } catch { continue; }
      const n = importsOf(f, text).filter((s) => resolveSpec(f, s) === RESIDUE).length;
      const syms = residueSymbols(f, text);
      if (n > 0 || syms.length > 0) edges[f] = syms.length > 0 ? syms : ["*"];
    }
    for (const m of CORE) expect(importsOf(m, read(m)).filter((s) => resolveSpec(m, s) === RESIDUE)).toEqual([]);
    expect(edges).toEqual(KNOWN_RESIDUE_EDGES);
  });

  it("MUST-FAIL (iii): every core module is an evaluator file and a judge_trust entry, or explicitly pending the act", async () => {
    const ev = new Set(evaluatorFiles());
    const earn = (await import(join(ROOT, "src/resolvers/scope-earn-in.ts"))) as { SCOPE_CLASSIFICATION?: Record<string, { class: string }> };
    for (const m of [...CORE, "test/resolvers/judge-modules-closed.test.ts"]) {
      const key = `repos/development-vessel/${m}`;
      const listed = ev.has(m) && earn.SCOPE_CLASSIFICATION?.[key]?.class === "judge_trust";
      if (PENDING_ACT.includes(m)) expect(ev.has(m), `${m} is in EVALUATOR_FILES: remove it from PENDING_ACT`).toBe(false);
      else expect(listed, `${m} must be in EVALUATOR_FILES and judge_trust`).toBe(true);
    }
    for (const p of PENDING_CLOSED) expect(EXCLUDED_SRC_MIRROR.includes(p), `${p} is excluded now: move it out of PENDING_CLOSED`).toBe(false);
  });

  it("MUST-FAIL (iv): no open src file uses a judge-choice or test hook it does not define", () => {
    const closed = CLOSED();
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { scan(rel); continue; }
        if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
        if (closed.has(rel) && rel !== RESIDUE) continue; // the residue is checked although closed today: it is the file to be opened
        const uses = hookUses(read(rel));
        if (uses.length) offenders.push(`${rel}: ${uses.join(", ")}`);
      }
    };
    scan("src");
    expect(offenders).toEqual([]);
  });
});
