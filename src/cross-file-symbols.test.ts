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
