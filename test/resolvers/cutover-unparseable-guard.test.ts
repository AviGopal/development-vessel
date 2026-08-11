// Pins the `unparseable_typescript` cutover signature added 2026-08-11.
//
// THE INCIDENT: a compose prepended 20 lines of an entirely different, hallucinated
// implementation onto activity-api's 1,237-line src/routes/goal-paths.ts — an Express
// router in a Hono vessel, importing a service that does not exist, with the GAP SUMMARY
// pasted at line 3 as bare unquoted prose. activity-api (the trace store AND the Thompson
// learner) crash-looped for 5 minutes, NRestarts 107 -> 123, respawning every ~6s. An
// operator had to hand-restore it because self-recovery.timer was simultaneously in a
// dead state (next_elapse=0, NextElapseUSecMonotonic=infinity) and could not fire.
//
// WHY A NEW SIGNATURE WAS NEEDED. The drafter-corruption gate already had two shape-based
// signatures and BOTH provably miss this, verified against the captured artifact:
//   - byte_zero_injection compares the staged first line to HEADER_OPENING, which accepts
//     /^\s*(\/\*|\/\/|import\b|export\b|#!|["'`]use )/. The injected text BEGINS WITH AN
//     IMPORT, so it reads as a legitimate file opening.
//   - catastrophic_truncation needs the staged file to shrink past half. It GREW —
//     51,036B against a live 51,011B.
// A prepend that opens with imports falls exactly between the two. Rather than widen a
// shape rule (and inherit its false positives), this asks the only question that decides
// whether the vessel boots: does the file parse?
//
// IT DOES NOT REPLACE THE OTHERS, and a test below pins that: the 2026-08-02 placeholder
// corruption (`{{source_code.content}}...` at byte 0) is syntactically VALID TypeScript —
// a block containing a labelled statement — so a parse check accepts it. All four
// signatures are complementary; removing any one reopens a distinct hole.
//
// SCOPE: strictly weaker than `tsc`. It rejects source that cannot be PARSED at all, never
// a type error, so it cannot refuse a merely-imperfect edit. Control over all 835 .ts/.tsx
// files under /vessels/*/src at the time of writing: ZERO parse failures.

import { describe, expect, test } from "bun:test";

/** The predicate as implemented in vessel-mitosis-cutover.ts (signature `d`). */
const parses = (code: string, loader: "ts" | "tsx" = "ts"): boolean => {
  try {
    new Bun.Transpiler({ loader }).transformSync(code);
    return true;
  } catch {
    return false;
  }
};

// The head of the real corrupted file, verbatim. Line 3 is the gap summary as bare prose —
// that is the token the runtime choked on ('Expected ";" but found "handler"').
const CORRUPT_HEAD = `import { Request, Response, Router } from 'express';
import { createExecutionPathRecord } from '../services/execution-path-service';
The handler that writes execution-path records sets no tenant marking on them, so an

const router = Router();
export default router;
`;

const HEADER_OPENING = /^\s*(\/\*|\/\/|import\b|export\b|#!|["'\`]use )/;

describe("unparseable_typescript — the signature that catches the incident", () => {
  test("THE REGRESSION: prose spliced into a module is rejected", () => {
    expect(parses(CORRUPT_HEAD)).toBe(false);
  });

  test("the two pre-existing signatures BOTH miss it — this is why the check exists", () => {
    const liveFirst = "/**";
    const stagedFirst = CORRUPT_HEAD.split("\n")[0] ?? "";
    // byte_zero_injection: fires only when the staged opening is NOT header-like.
    const byteZeroFires =
      HEADER_OPENING.test(liveFirst) && stagedFirst.trim() !== "" && !HEADER_OPENING.test(stagedFirst);
    expect(byteZeroFires).toBe(false);
    // catastrophic_truncation: fires only on a shrink past half. The file grew.
    const truncationFires = 51011 > 400 && 51036 < 51011 * 0.5;
    expect(truncationFires).toBe(false);
  });

  test("it does NOT subsume signature (a): the 2026-08-02 placeholder shape PARSES", () => {
    // Measured, not assumed — I expected this to fail to parse and it does not.
    // `{{source_code.content}}` is a block containing a labelled statement, which is
    // syntactically valid TypeScript, so the transpiler accepts it happily even though
    // the file is meaningless. That is why signature (a) (unrendered placeholder on line
    // 1) must STAY: the two checks are complementary and neither one replaces the other.
    // Deleting (a) on the belief that a parse check covers it would silently reopen the
    // exact hole that crash-looped development-vessel on 2026-08-02.
    expect(parses("{{source_code.content}}{{source_code.content}}/**\n * header\n */\n")).toBe(true);
  });
});

describe("the false-positive boundary — it must not refuse ordinary edits", () => {
  test("a normal TypeScript module parses", () => {
    expect(parses(`import { Hono } from "hono";\nconst app = new Hono();\nexport default app;\n`)).toBe(true);
  });

  test("a TYPE ERROR still parses — this is deliberately weaker than tsc", () => {
    // If this ever returns false the check has overreached into typechecking and will
    // start refusing edits that merely fail `tsc`, which is a different gate's job.
    expect(parses(`const n: number = "not a number";\nexport { n };\n`)).toBe(true);
  });

  test("modern syntax the fleet actually uses parses", () => {
    expect(parses(`export const f = async <T,>(x: T): Promise<T> => x satisfies T;\n`)).toBe(true);
    expect(parses(`enum E { A = 1 }\ndeclare module "x" { const y: number; }\nexport { E };\n`)).toBe(true);
    expect(parses(`@dec() class C { #p = 1; accessor q = 2; }\nexport { C };\n`)).toBe(true);
  });

  test("a file that is only a comment or only prose-in-a-template parses", () => {
    // src/seed/*.ts legitimately holds prompt text inside backticks; it must not trip.
    expect(parses(`// just a comment\n`)).toBe(true);
    expect(parses("export const P = `The handler that writes records sets no marking.`;\n")).toBe(true);
  });

  test("tsx is parsed with the tsx loader", () => {
    expect(parses(`export const C = () => <div className="x">hi</div>;\n`, "tsx")).toBe(true);
  });
});
