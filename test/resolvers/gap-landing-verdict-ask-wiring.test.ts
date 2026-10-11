// THE LANDING VERDICT ASKS HUMANS ONLY THROUGH THE CHANNEL IT IS HANDED (gap-to-feature judge split, qa 10.2).
//
// The landing verdict moved to the closed src/judge/gap-landing-verdict.ts. Its human escalations used to call
// ui-write-passthrough directly. That module stays open (an effect whose ground truth lives there), so the closed
// module takes a per-call `ask` channel instead:
// - closeLandedGap's ref.ask;
// - sweepPendingLandVerifications' deps.ask (through sweepIfCloneHeadsMoved);
// - escalateApplyFailureToPwt's ref.ask.
//
// A residue call site that forgot the channel would make every re-land, pending-verification and non-discriminating
// escalation throw instead of asking a human, with the verdict tests of the module itself still green. This pins:
//   (1) the closed module never imports ui-write-passthrough, and every escalation goes through `ask(`;
//   (2) every call into those entry points from gap-to-feature passes `ask: askHuman`;
//   (3) askHuman is ui-write-passthrough's resolver, and nothing else.
// The behaviour through the channel (a re-land escalation reaches the human) is pinned by
// gap-to-feature-reland-escalation.test.ts and the pending-land sweep suites, which now pass the same channel.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC = join(import.meta.dir, "..", "..", "src");
const parse = (rel: string): ts.SourceFile => ts.createSourceFile(rel, readFileSync(join(SRC, rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void { visit(n); n.forEachChild((c) => walk(c, visit)); }
const ENTRY: Record<string, number> = { closeLandedGap: 2, sweepIfCloneHeadsMoved: 0, sweepPendingLandVerifications: 0, escalateApplyFailureToPwt: 5 };

describe("the landing verdict asks through the channel it is handed", () => {
  it("MUST-FAIL (1): the closed module never imports ui-write-passthrough and asks only through `ask(`", () => {
    const sf = parse("judge/gap-landing-verdict.ts");
    const specs: string[] = [];
    walk(sf, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) specs.push(n.arguments[0].text);
    });
    expect(specs.filter((s) => s.includes("ui-write-passthrough"))).toEqual([]);
    let direct = 0, asks = 0;
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        if (n.expression.text === "resolveUiWritePassthrough") direct++;
        if (n.expression.text === "ask") asks++;
      }
    });
    expect(direct).toBe(0);
    expect(asks).toBe(3); // the re-land, pending-verification and non-discriminating escalations
  });

  it("MUST-FAIL (2): every gap-to-feature call into a landing-verdict entry point passes ask: askHuman", () => {
    const sf = parse("resolvers/gap-to-feature.ts");
    const missing: string[] = [];
    let seen = 0;
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || !(n.expression.text in ENTRY)) return;
      seen++;
      const arg = n.arguments[ENTRY[n.expression.text]!];
      const ok = !!arg && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === "ask" && p.initializer.getText() === "askHuman");
      if (!ok) missing.push(`line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText().slice(0, 140)}`);
    });
    expect(seen).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("MUST-FAIL (3): askHuman is ui-write-passthrough's resolver", () => {
    const sf = parse("resolvers/gap-to-feature.ts");
    let init = "";
    walk(sf, (n) => { if (ts.isVariableDeclaration(n) && n.name.getText() === "askHuman" && n.initializer) init = n.initializer.getText(); });
    expect(init).toBe("(p) => resolveUiWritePassthrough(p as never)");
    let imported = false;
    walk(sf, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === "./ui-write-passthrough.js") {
        imported = /\bresolveUiWritePassthrough\b/.test(n.importClause?.getText() ?? "");
      }
    });
    expect(imported).toBe(true);
  });
});
