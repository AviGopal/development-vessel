// Pins the cross-file symbol grounding.
//
// THE OBSERVED CASE: a goal named `isFailoverError`, the grounding window was
// built from the TARGET file only, and the predicate is declared in another file.
// The drafter reached the right line, then invented both the signature (called it
// with no argument) and the module path (`../error-types`), and finally commented
// out its own import. Law 8 — the load-bearing fact was never in the window.
import { describe, expect, test } from "bun:test";
import {
  symbolsNeedingDeclaration,
  renderSymbolDeclarations,
  importSpecifier,
  typeNamesIn,
  uniqueAnchorLines,
  anchorOccurrences,
  renderSafeAnchors,
} from "./cross-file-symbols";

const SPEC = `Edit repos/llm-resolver-vessel/src/model-policy.ts so a provider-level failure
does not damage a model's learned quality score. This vessel already classifies that
error class with isFailoverError and uses it to gate cooldowns; the same predicate
should guard the beta increment.`;

describe("symbolsNeedingDeclaration — finds what the window is missing", () => {
  test("the symbol from the observed failure is selected when absent", () => {
    expect(symbolsNeedingDeclaration(SPEC, "some window without it")).toContain("isFailoverError");
  });

  test("a symbol ALREADY in the window is not looked up", () => {
    // Nothing to add: the drafter can already see it.
    const g = "export const isFailoverError = (e: unknown): boolean => ...";
    expect(symbolsNeedingDeclaration(SPEC, g)).not.toContain("isFailoverError");
  });

  test("prose is not mistaken for symbols", () => {
    const out = symbolsNeedingDeclaration(SPEC, "");
    for (const w of ["provider", "quality", "predicate", "however", "because"]) {
      expect(out).not.toContain(w);
    }
  });

  test("snake_case counts, bare lowercase words do not", () => {
    expect(symbolsNeedingDeclaration("touch the org_id column", "")).toContain("org_id");
    expect(symbolsNeedingDeclaration("touch the column", "")).toEqual([]);
  });

  test("is bounded — each lookup costs a search", () => {
    const many = "aaaBbb cccDdd eeeFff gggHhh iiiJjj kkkLll";
    expect(symbolsNeedingDeclaration(many, "", 3).length).toBe(3);
  });

  test("empty/garbage input is safe", () => {
    expect(symbolsNeedingDeclaration("", "")).toEqual([]);
    expect(symbolsNeedingDeclaration(undefined as unknown as string, "")).toEqual([]);
  });
});

describe("importSpecifier — the half of the fact the drafter invented", () => {
  test("same directory", () => {
    expect(
      importSpecifier("repos/v/src/model-policy.ts", "repos/v/src/provider-errors.ts"),
    ).toBe("./provider-errors.js");
  });

  test("parent directory", () => {
    expect(
      importSpecifier("repos/v/src/resolvers/a.ts", "repos/v/src/provider-errors.ts"),
    ).toBe("../provider-errors.js");
  });

  test(".ts becomes .js — the emitted extension, which the failure got wrong twice", () => {
    expect(importSpecifier("a/b/x.ts", "a/b/y.ts")).toBe("./y.js");
    expect(importSpecifier("a/b/x.ts", "a/b/y.tsx")).toBe("./y.js");
  });
});

describe("renderSymbolDeclarations — carries signature AND import path", () => {
  test("both missing facts appear in the block", () => {
    const out = renderSymbolDeclarations(
      [{
        symbol: "isFailoverError",
        file: "repos/llm-resolver-vessel/src/provider-errors.ts",
        line: "export const isFailoverError = (e: unknown): boolean => isExhausted(e) || isUnreachable(e);",
      }],
      "repos/llm-resolver-vessel/src/model-policy.ts",
    );
    expect(out).toContain("(e: unknown)");           // the signature it guessed away
    expect(out).toContain('from "./provider-errors.js"'); // the path it invented
  });

  test("an empty list renders nothing, so callers can concatenate blindly", () => {
    expect(renderSymbolDeclarations([], "a/b.ts")).toBe("");
  });

  test("the block is budget-bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      symbol: `sym${i}`, file: `repos/v/src/f${i}.ts`, line: "x".repeat(200),
    }));
    expect(renderSymbolDeclarations(many, "repos/v/src/t.ts", 500).length).toBeLessThanOrEqual(520);
  });
});

describe("typeNamesIn — a signature without its types is half a fact", () => {
  // Measured 2026-08-11: given the helper's declaration, the drafter wrote the
  // call correctly and failed to compile —
  //   TS2345: '{ endpoint?: string }[]' is not assignable to 'SatisfierProducer[]'
  // because the signature named a type it had never been shown. Resolving the
  // types mentioned in a resolved declaration closes that, one hop out.
  test("extracts the type from the real declaration", () => {
    expect(
      typeNamesIn("export function pickSatisfierProducer(producers: SatisfierProducer[]): SatisfierProducer | undefined {"),
    ).toEqual(["SatisfierProducer"]);
  });

  test("built-ins are not worth resolving", () => {
    expect(typeNamesIn("function f(a: string, b: Promise<Record<string, number>>): Array<Date>")).toEqual([]);
  });

  test("lowercase tokens are parameter names, not types", () => {
    expect(typeNamesIn("function f(producers, best, pool)")).toEqual([]);
  });

  test("multiple distinct types, deduped", () => {
    expect(typeNamesIn("function g(a: Alpha, b: Beta, c: Alpha): Gamma")).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  test("empty input is safe", () => {
    expect(typeNamesIn("")).toEqual([]);
    expect(typeNamesIn(undefined as unknown as string)).toEqual([]);
  });
});

describe("symbolsNeedingDeclaration — a mention is not a declaration", () => {
  // THE DEFECT, and it silently disabled this module for the case it was written
  // for. The original skip was `if (grounding.includes(name)) continue` — "already
  // visible to the drafter". Measured 2026-08-11: the window was index.ts, which
  // contains `pickSatisfierProducer` three times (one import, two call sites),
  // while the DECLARATION lives in satisfier-pick.ts. The symbol read as visible,
  // nothing was resolved, and the drafter wrote a call that failed TS2345 for want
  // of the parameter type.
  //
  // A call site says the name exists. Only a declaration says what to pass.
  const SPEC = "These lookups should use the pickSatisfierProducer helper the vessel already has.";

  test("an import plus call sites does NOT suppress the lookup", () => {
    const window = [
      'import { pickSatisfierProducer } from "./satisfier-pick.js";',
      "  const v = pickSatisfierProducer(list);",
      "  const earlyV = pickSatisfierProducer(other);",
    ].join("\n");
    expect(symbolsNeedingDeclaration(SPEC, window)).toContain("pickSatisfierProducer");
  });

  test("a real declaration DOES suppress it", () => {
    const window = "export function pickSatisfierProducer(producers: SatisfierProducer[]) {";
    expect(symbolsNeedingDeclaration(SPEC, window)).not.toContain("pickSatisfierProducer");
  });

  test("every declaration form is recognised", () => {
    for (const decl of [
      "function pickSatisfierProducer(",
      "export const pickSatisfierProducer = (",
      "  export async function pickSatisfierProducer(",
      "interface pickSatisfierProducer {",
    ]) {
      expect(symbolsNeedingDeclaration(SPEC, decl)).not.toContain("pickSatisfierProducer");
    }
  });

  test("a mention inside prose or a comment does not suppress it", () => {
    expect(
      symbolsNeedingDeclaration(SPEC, "// pickSatisfierProducer already encodes the rule"),
    ).toContain("pickSatisfierProducer");
  });
});

describe("uniqueAnchorLines / anchorOccurrences — uniqueness is a whole-file fact", () => {
  // The compose prompt already demands a UNIQUE old_string. A drafter cannot
  // verify that from an excerpt — uniqueness is a property of the whole file and
  // the window is a fragment. Measured 2026-08-11: a draft anchored on a line
  // occurring THREE times and apply refused it (correctly). Law 8 — compute the
  // fact and hand it over rather than instructing harder.
  const FILE = [
    "import { a } from './a';",
    "const shared = compute(value);",
    "function one() {",
    "  const shared = compute(value);",
    "  return distinctLineNumberOne(x);",
    "}",
    "function two() {",
    "  return distinctLineNumberTwo(y);",
    "}",
  ].join("\n");

  test("counts occurrences the way apply binds", () => {
    expect(anchorOccurrences(FILE, "const shared = compute(value);")).toBe(2);
    expect(anchorOccurrences(FILE, "return distinctLineNumberOne(x);")).toBe(1);
    expect(anchorOccurrences(FILE, "nowhere")).toBe(0);
  });

  test("a duplicated line is never offered as an anchor", () => {
    expect(uniqueAnchorLines(FILE)).not.toContain("const shared = compute(value);");
  });

  test("every offered anchor is genuinely unique", () => {
    for (const a of uniqueAnchorLines(FILE)) expect(anchorOccurrences(FILE, a)).toBe(1);
  });

  test("noise is skipped — braces, comments, and trivially short lines", () => {
    const out = uniqueAnchorLines("{\n}\n// a comment that is quite long indeed\nx;\n");
    expect(out).toEqual([]);
  });

  test("the rendered block is empty when there is nothing safe to offer", () => {
    expect(renderSafeAnchors("", "r", "p.ts")).toBe("");
    expect(renderSafeAnchors("{\n}\n", "r", "p.ts")).toBe("");
  });
});
