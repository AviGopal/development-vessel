// THE ESCALATE CALLBACK IS WIRED AT EVERY BUMP (gap-to-feature judge split, BOUNDARY.md 4.3 / 10 (a)).
//
// bumpFailedAttempts moved to the closed src/judge/gap-attempt-credit.ts. At the chronic threshold it used to call
// gap-to-feature's escalateToDecomposition directly, but a closed module may not import the residue, so it now
// calls `opts.escalate` at the same statement. A residue call site that forgot to pass the callback would silently
// stop escalating chronic gaps (no decomposition, no investigation walk), with every test of the bump itself still
// green. This pins the wiring:
//   (1) every bumpFailedAttempts call in the residue passes `escalate: escalateToDecomposition`;
//   (2) the default pwt-escalation deps (the main compose path's grader) wrap bump with the same callback;
//   (3) the closed bump calls the callback exactly where it used to call escalateToDecomposition: after the
//       narrowed-child block, inside the same try whose catch logs "child gap emit failed".
// The behaviour with the callback (a chronic bump dispatches the decomposition walk) is pinned by
// gap-falsify-v2-decompose.test.ts's positive control.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC = join(import.meta.dir, "..", "..", "src");
const parse = (rel: string): ts.SourceFile => ts.createSourceFile(rel, readFileSync(join(SRC, rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void { visit(n); n.forEachChild((c) => walk(c, visit)); }
const calleeName = (c: ts.CallExpression): string => ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : "";
const passesEscalate = (c: ts.CallExpression): boolean => {
  const opts = c.arguments[1];
  return !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === "escalate" && p.initializer.getText() === "escalateToDecomposition");
};

describe("bumpFailedAttempts escalates only through the callback, and every residue call site passes it", () => {
  it("MUST-FAIL (1): every bumpFailedAttempts call in gap-to-feature passes escalate: escalateToDecomposition", () => {
    const sf = parse("resolvers/gap-to-feature.ts");
    const calls: ts.CallExpression[] = [];
    walk(sf, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "bumpFailedAttempts") calls.push(n); });
    expect(calls.length).toBeGreaterThan(0);
    const missing = calls.filter((c) => !passesEscalate(c)).map((c) => `line ${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1}: ${c.getText().slice(0, 120)}`);
    expect(missing).toEqual([]);
  });

  it("MUST-FAIL (2): the pwt-escalation deps hand bump the same callback", () => {
    // The default deps live in the closed landing verdict (gap-to-feature judge split, L) and take the callback as
    // a parameter; every place that builds them hands it escalateToDecomposition (or the grader's own deps.escalate). The
    // parameter default of escalateApplyFailureToPwt (no callback) serves only callers that pass no deps: tests.
    const lv = parse("judge/gap-landing-verdict.ts");
    let forwards = false;
    walk(lv, (n) => {
      if (ts.isVariableDeclaration(n) && n.name.getText() === "defaultPwtEscalationDeps") {
        walk(n, (m) => { if (ts.isCallExpression(m) && calleeName(m) === "bumpFailedAttempts" && m.arguments[1] && /\bescalate:\s*cb\.escalate\b/.test(m.arguments[1].getText())) forwards = true; });
      }
    });
    expect(forwards).toBe(true);
    const builds: string[] = [];
    for (const rel of ["resolvers/gap-to-feature.ts", "judge/gap-landing-verdict.ts"]) {
      walk(parse(rel), (n) => { if (ts.isCallExpression(n) && calleeName(n) === "defaultPwtEscalationDeps" && !ts.isParameter(n.parent)) builds.push(n.getText()); });
    }
    expect(builds.length).toBeGreaterThan(0);
    expect(builds.filter((b) => !/escalate:\s*(escalateToDecomposition|deps\.escalate)\b/.test(b))).toEqual([]);
  });

  it("MUST-FAIL (3): the closed bump calls opts.escalate in the narrowing try, never a residue function", () => {
    const sf = parse("judge/gap-attempt-credit.ts");
    let bump: ts.FunctionDeclaration | undefined;
    walk(sf, (n) => { if (!bump && ts.isFunctionDeclaration(n) && n.name?.text === "bumpFailedAttempts") bump = n; });
    expect(bump).toBeDefined();
    const text = bump!.getText();
    expect(text).not.toContain("escalateToDecomposition");
    const tries: ts.TryStatement[] = [];
    walk(bump!, (n) => { if (ts.isTryStatement(n) && n.catchClause && n.catchClause.getText().includes("child gap emit failed")) tries.push(n); });
    expect(tries.length).toBe(1);
    const block = tries[0]!.tryBlock.getText();
    const esc = block.indexOf('await opts.escalate?.(gap, "chronic failure");');
    expect(esc).toBeGreaterThan(-1);
    expect(esc).toBeGreaterThan(block.indexOf("narrowedChildRecord("));
  });
});
