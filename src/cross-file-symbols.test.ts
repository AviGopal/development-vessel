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
  locateRegion,
  safeAnchorLines,
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

  // AN UNLOCATABLE REGION MUST YIELD NO ANCHORS, NOT AN ARBITRARY BAND.
  //
  // These pin the two halves of one defect, because a patch that satisfies only
  // one reads as addressing it. The band is centred on the first line CONTAINING
  // `region`; if that cannot be found, any band is a guess about where the edit
  // lives, and a confidently-offered wrong anchor is worse than none — measured
  // 2026-08-11, a drafter handed anchors from lines 168-328 of a 4209-line file
  // whose edit sites were all past 1148 invented an anchor occurring ZERO times,
  // identically on two dispatches.
  //
  // The empty case is the one that actually occurs: callers pass
  // `regionHint ?? ""`. `"anything".includes("")` is TRUE, so without an explicit
  // guard findIndex returns 0 and bands the top of the file.
  test("an empty region yields no anchors rather than banding line 0", () => {
    const long = Array.from({ length: 400 }, (_, i) => `const uniqueSymbolNumber${i} = ${i};`).join("\n");
    expect(renderSafeAnchors(long, "", "p.ts")).toBe("");
  });

  test("a region absent from the file yields no anchors rather than the midpoint", () => {
    const long = Array.from({ length: 400 }, (_, i) => `const uniqueSymbolNumber${i} = ${i};`).join("\n");
    expect(renderSafeAnchors(long, "a-token-that-does-not-occur-anywhere", "p.ts")).toBe("");
  });

  test("a locatable region bands near it, not across the whole file", () => {
    const long = Array.from({ length: 400 }, (_, i) => `const uniqueSymbolNumber${i} = ${i};`).join("\n");
    const out = renderSafeAnchors(long, "uniqueSymbolNumber200", "p.ts");
    const offered = [...out.matchAll(/uniqueSymbolNumber(\d+) =/g)].map((m) => Number(m[1]));
    expect(offered.length).toBeGreaterThan(0);
    // Every offered anchor lies inside the +/-80 band around the located region.
    for (const n of offered) expect(Math.abs(n - 200)).toBeLessThanOrEqual(80);
  });

  // ANCHORS MUST BE THE ONES NEAREST THE REGION, NOT THE BAND'S TOP EDGE.
  //
  // The selection was `uniqueAnchorLines(near, …).slice(0, maxAnchors)`, which
  // keeps the FIRST maxAnchors unique lines of a band starting at
  // `center - window` — so the drafter got lines [center-80, center-68]: up to 80
  // lines ABOVE the line it must edit, and never the line itself. Measured
  // 2026-08-11 on a 4209-line file, the band centred at 248 and every anchor came
  // from line 169 while the edit sites were 1148+. Centring the BAND is necessary
  // but not sufficient; the SELECTION has to be centred too.
  test("offered anchors are the ones nearest the region", () => {
    const long = Array.from({ length: 400 }, (_, i) => `const uniqueSymbolNumber${i} = ${i};`).join("\n");
    const out = renderSafeAnchors(long, "uniqueSymbolNumber200", "p.ts");
    const offered = [...out.matchAll(/uniqueSymbolNumber(\d+) =/g)].map((m) => Number(m[1]));
    expect(offered).toContain(200);
    // 12 anchors centred on 200 cannot reach the old top-of-band start.
    for (const n of offered) expect(Math.abs(n - 200)).toBeLessThanOrEqual(12);
  });

  // A MATCH INSIDE A COMMENT IS THE WEAKEST KIND OF MATCH.
  //
  // The observed failure: the grounding term first occurred in a doc comment 2,500
  // lines from the code it named, and the band centred there. Prose quoting an
  // identifier says it is discussed, not that the work is here — the same defect
  // already filed for goal→file routing, recurring one stage later.
  test("a code occurrence outranks an earlier comment occurrence", () => {
    const text = [
      "// targetToken is described here in prose",
      ...Array.from({ length: 200 }, (_, i) => `const filler${i} = ${i};`),
      "const targetToken = realImplementation();",
      ...Array.from({ length: 200 }, (_, i) => `const tail${i} = ${i};`),
    ].join("\n");
    expect(locateRegion(text.split("\n"), "targetToken")).toBe(201);
  });

  test("a comment-only match is still used when there is no code occurrence", () => {
    const text = ["// onlyInAComment appears here", "const x = 1;"].join("\n");
    expect(locateRegion(text.split("\n"), "onlyInAComment")).toBe(0);
  });

  test("candidate locators are tried in order and empties never locate", () => {
    const text = ["const alpha = 1;", "const beta = 2;"].join("\n");
    expect(locateRegion(text.split("\n"), ["", "beta"])).toBe(1);
    expect(locateRegion(text.split("\n"), ["nope", "alpha"])).toBe(0);
    expect(locateRegion(text.split("\n"), ["", "  "])).toBe(-1);
  });
});

describe("safeAnchorLines — the list behind the enumerated choice", () => {
  // The whole point of exposing the list: the caller offers INDICES, takes the
  // bytes from here, and the anchor can no longer be invented because the model
  // never writes it. So the list must be exactly what the rendered block shows.
  const long = Array.from({ length: 400 }, (_, i) => `const uniqueSymbolNumber${i} = ${i};`).join("\n");

  test("it returns the same anchors the rendered block advertises", () => {
    const list = safeAnchorLines(long, "uniqueSymbolNumber200");
    const rendered = renderSafeAnchors(long, "uniqueSymbolNumber200", "p.ts");
    expect(list.length).toBeGreaterThan(0);
    for (const a of list) expect(rendered).toContain(a);
  });

  test("every offered anchor occurs EXACTLY once in the whole file", () => {
    for (const a of safeAnchorLines(long, "uniqueSymbolNumber200")) {
      expect(anchorOccurrences(long, a)).toBe(1);
    }
  });

  test("nearest the region first — index 0 is the most useful choice", () => {
    const list = safeAnchorLines(long, "uniqueSymbolNumber200");
    expect(list[0]).toContain("uniqueSymbolNumber200");
  });

  test("an unlocatable region yields NO choices, so no index can be offered", () => {
    expect(safeAnchorLines(long, "")).toEqual([]);
    expect(safeAnchorLines(long, "a-token-that-does-not-occur")).toEqual([]);
    expect(safeAnchorLines("", "anything")).toEqual([]);
  });
});
