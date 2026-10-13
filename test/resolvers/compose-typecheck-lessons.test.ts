// A TYPECHECK FAILURE TEACHES THE NEXT DRAFT WHERE TO LOOK (C-window-1, parts B and C).
//
// Measured on the lane's failed composes: most own-check runs of a stuck gap never ran because the draft failed typecheck
// (cannot find name, redeclare, impossible comparison), and each failure left only prose (verify_failure_reason), so the
// next draft made the same class of error against the same window. Repair rounds inside an attempt were shown the error
// line, never the declaration the error named, and looped on one slice.
//
// Expected (class-level; the tables vary the TS code, where the symbol lives and whether the output parses):
//   - B: a typecheck failure records {ts_code, symbol, symbol_location}; the location is resolved BY THE COMPOSER from the
//     vessel sources grounding reads (REPO_ROOT) when the lesson is written (a missing name: its declaration elsewhere, or declared_nowhere; a
//     redeclaration: the existing declaration in the erroring file); any other code is recorded without a location; only
//     the draft's own errors (not the parent's); an output with no parseable tsc line is RECORDED as unparsed (G3).
//   - B: the NEXT attempt's grounding includes that location (a lesson that only stores text is an archive, not teaching).
//   - C: inside an attempt, the repair round is re-grounded on the declarations behind missing-symbol / redeclaration
//     errors BEFORE its redraft.
//
// Seams: typecheckLessons / priorTcLessons / tcLessonGroundingBlock / symbolWidenBlock (retry-evidence) and
// composeAttemptEvidence (feature-compose), reached as optional exports so their absence reads as a red assertion.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const re = (await import("../../src/resolvers/retry-evidence.js")) as Record<string, any>;
const has = (name: string, from: Record<string, any>): boolean => typeof from[name] === "function";

const HELPERS = ["// helpers", ...Array.from({ length: 38 }, (_, i) => `// filler ${i}`), "export function helperFn(x: number): number {", "  return x + 1;", "}", "export type HelperT = { n: number };", "export class HelperC {}", "export const helperK = 3;", "export interface HelperI { k: number }", "export enum HelperE { A }"].join("\n");
const SITE = ["import { other } from \"./other.js\";", "export function run(): number {", "  const n = helperFn(1);", "  return n;", "}", "export const dup = 1;", "export const dup = 2;"].join("\n");
const FILES = [{ path: "src/lib/helpers.ts", content: HELPERS }, { path: "src/site.ts", content: SITE }];
const TS2304 = "src/site.ts(3,13): error TS2304: Cannot find name 'helperFn'.";
const TS2451 = "src/site.ts(7,14): error TS2451: Cannot redeclare block-scoped variable 'dup'.";
const TS2304_NOWHERE = "src/site.ts(3,13): error TS2304: Cannot find name 'inventedFn'.";
const PARENT_ERR = "src/old.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.";
const norm = (l: string): string => l.replace(/\(\d+,\d+\)/g, "").trim();
const PFX = "repos/demo-vessel/";

describe("B: the typecheck lesson records where its symbol is declared (G1: every code class, every declaration kind)", () => {
  const helpersLine = (needle: string): number => HELPERS.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const missing: Array<[string, string, string]> = [
    ["TS2304", "Cannot find name 'helperFn'.", "helperFn"],
    ["TS2552", "Cannot find name 'helperK'. Did you mean 'helperX'?", "helperK"],
    ["TS2305", "Module '\"./other.js\"' has no exported member 'HelperT'.", "HelperT"],
    ["TS2724", "'\"./other.js\"' has no exported member named 'HelperC'. Did you mean 'HelperX'?", "HelperC"],
    ["TS2614", "Module '\"./other.js\"' has no exported member 'HelperI'. Did you mean to use 'import HelperI from \"./other.js\"' instead?", "HelperI"],
    ["TS2304", "Cannot find name 'HelperE'.", "HelperE"],
  ];
  for (const [code, msg, sym] of missing) {
    it(`${code} naming ${sym}: located at its declaration in the vessel`, () => {
      expect(has("typecheckLessons", re)).toBe(true);
      const line = `src/site.ts(3,13): error ${code}: ${msg}`;
      const t = re.typecheckLessons(line, [], FILES, PFX);
      expect(t.length).toBe(1);
      expect(t[0]).toMatchObject({ ts_code: code, file: "src/site.ts", line: 3, symbol_location: { path: `${PFX}src/lib/helpers.ts`, line: helpersLine(sym) } });
    });
  }

  const redeclare = ["TS2451", "TS2300", "TS2393", "TS2323"];
  for (const code of redeclare) {
    it(`${code} redeclaring dup: located at the existing declaration in the erroring file`, () => {
      expect(has("typecheckLessons", re)).toBe(true);
      const t = re.typecheckLessons(`src/site.ts(7,14): error ${code}: Duplicate identifier 'dup'.`, [], FILES, PFX);
      expect(t[0]).toMatchObject({ ts_code: code, symbol: "dup", symbol_location: { path: `${PFX}src/site.ts`, line: 6 } });
    });
  }

  const other: Array<[string, string]> = [
    ["TS2367", "This comparison appears to be unintentional because the types '\"a\" | \"b\"' and '\"c\"' have no overlap."],
    ["TS2322", "Type 'string' is not assignable to type 'number'."],
    ["TS2345", "Argument of type 'string' is not assignable to parameter of type 'number'."],
    ["TS1005", "';' expected."],
  ];
  for (const [code, msg] of other) {
    it(`${code} (not a missing or duplicate name): recorded without a location, never dropped`, () => {
      expect(has("typecheckLessons", re)).toBe(true);
      const t = re.typecheckLessons(`src/resolvers/any-module.ts(350,42): error ${code}: ${msg}`, [], FILES, PFX);
      expect(t.length).toBe(1);
      expect(t[0]).toMatchObject({ ts_code: code, file: "src/resolvers/any-module.ts", line: 350, symbol_location: null });
      expect(t[0].declared_nowhere).toBeUndefined();
    });
  }

  it("a missing name declared nowhere is recorded as such", () => {
    expect(has("typecheckLessons", re)).toBe(true);
    const t = re.typecheckLessons(TS2304_NOWHERE, [], FILES, PFX);
    expect(t[0]).toMatchObject({ ts_code: "TS2304", symbol: "inventedFn", symbol_location: null, declared_nowhere: true });
  });

  it("only the draft's own errors become lessons: a line the parent tree also had is not one", () => {
    expect(has("typecheckLessons", re)).toBe(true);
    const t = re.typecheckLessons(`${PARENT_ERR}\n${TS2304}\n${TS2451}`, [norm(TS2304), norm(TS2451)], FILES, PFX);
    expect(t.map((x: any) => x.ts_code)).toEqual(["TS2304", "TS2451"]);
  });

  it("composeAttemptEvidence writes tc_lessons for a typecheck-stage failure from the composer's own source read", () => {
    const verify = [{ vessel: "repos/demo-vessel", errors: "verify", exit_code: 2, ok: false, output: `$ tsc --noEmit\n${TS2304}`, stage: "typecheck", draft: { own_red: [], introduced: [], new_ts: [norm(TS2304)], gate_detail: "" } }];
    const { record } = fc.composeAttemptEvidence([], [], verify, false, null, { sources: (v: string) => (v === "demo-vessel" ? FILES : []) });
    expect(record.tc_lessons?.[0]?.symbol_location).toEqual({ path: `${PFX}src/lib/helpers.ts`, line: 40 });
    expect(fc.composeAttemptEvidence([], [], verify, false, null).record.tc_lessons).toBeUndefined();
  });

  it("G3: a typecheck-stage failure with no parseable tsc line is RECORDED as unparsed, not silently lesson-less", () => {
    const verify = [{ vessel: "demo-vessel", errors: "verify", exit_code: 2, ok: false, output: "$ tsc --noEmit\nerror: some new compiler output format", stage: "typecheck", draft: { own_red: [], introduced: [], new_ts: [], gate_detail: "" } }];
    const { record } = fc.composeAttemptEvidence([], [], verify, false, null, { sources: () => FILES });
    expect(record.tc_lessons).toBeUndefined();
    expect(record.tc_lessons_unparsed).toContain("some new compiler output format");
    // Its reader: the next attempt's prior-attempt record shows it to the drafter.
    expect(re.attemptEvidenceBlock([{ ...record, at: "t", class: "verify_failed" }])).toContain("typecheck failed with output this code could not parse into errors: $ tsc --noEmit error: some new compiler output format");
  });
});

describe("B: the next attempt's grounding includes the lesson's location", () => {
  const read = (p: string): string | null => (p === `${PFX}src/lib/helpers.ts` ? HELPERS : null);

  it("MUST-FAIL at parent: a TS2304 'cannot find name' lesson puts the name's declaration in the next grounding", () => {
    expect(has("tcLessonGroundingBlock", re)).toBe(true);
    const lessons = [{ class: "verify_failed", stage: "typecheck", tc_lessons: re.typecheckLessons(TS2304, [], FILES, PFX) }];
    const b = re.tcLessonGroundingBlock(re.priorTcLessons(lessons), read, 5, new Set());
    expect(b.consumed).toBe(1);
    expect(b.text).toContain(`----- ${PFX}src/lib/helpers.ts lines 35-45 -----`);
    expect(b.text).toContain("40\texport function helperFn(x: number): number {");
  });

  it("a location inside a file already grounded whole is named, not repeated; a declared-nowhere name is stated; an unreadable location is skipped and not counted", () => {
    expect(has("tcLessonGroundingBlock", re)).toBe(true);
    const lessons = [{ tc_lessons: [...re.typecheckLessons(TS2304, [], FILES, PFX), ...re.typecheckLessons(TS2304_NOWHERE, [], FILES, PFX)] }];
    const b = re.tcLessonGroundingBlock(re.priorTcLessons(lessons), read, 5, new Set([`${PFX}src/lib/helpers.ts`]));
    expect(b.consumed).toBe(2);
    expect(b.text).toContain(`declared at ${PFX}src/lib/helpers.ts:40 (in the whole file shown above)`);
    expect(b.text).not.toContain("40\texport function helperFn");
    expect(b.text).toContain("'inventedFn' is declared NOWHERE in this vessel");
    const gone = re.tcLessonGroundingBlock(re.priorTcLessons(lessons.slice(0, 1).map((l) => ({ tc_lessons: l.tc_lessons.slice(0, 1) }))), () => null, 5, new Set());
    expect(gone).toEqual({ text: "", consumed: 0 });
  });

  it("no lesson, no block; the prompt's attempt record names the lesson and its location", () => {
    expect(has("tcLessonGroundingBlock", re)).toBe(true);
    expect(re.tcLessonGroundingBlock([], read, 5, new Set())).toEqual({ text: "", consumed: 0 });
    const rec = { at: "t", stage: "typecheck", class: "verify_failed", edited_spans: [], tc_lessons: re.typecheckLessons(TS2304, [], FILES, PFX) };
    expect(re.attemptEvidenceBlock([rec])).toContain(`TS2304 src/site.ts:3 'helperFn' (declared at ${PFX}src/lib/helpers.ts:40)`);
  });
});

describe("C: the repair round is re-grounded on the symbol before it redrafts", () => {
  it("MUST-FAIL at parent: a TS2304 error widens the repair grounding to the declaration (numbered gutter, import note)", () => {
    expect(has("symbolWidenBlock", re)).toBe(true);
    const w = re.symbolWidenBlock(`$ tsc --noEmit\n${TS2304}`, FILES, 3);
    expect(w.symbols).toEqual(["helperFn"]);
    expect(w.text).toContain("declared at src/lib/helpers.ts:40 (import it into src/site.ts)");
    expect(w.text).toContain("   40| export function helperFn(x: number): number {");
  });

  it("a redeclaration shows the existing declarations in the erroring file; a name declared nowhere is stated; other codes add nothing", () => {
    expect(has("symbolWidenBlock", re)).toBe(true);
    const w = re.symbolWidenBlock(TS2451, FILES, 1);
    expect(w.text).toContain("already declared at src/site.ts:6");
    expect(w.text).toContain("already declared at src/site.ts:7");
    expect(re.symbolWidenBlock(TS2304_NOWHERE, FILES, 3).text).toContain("'inventedFn': declared nowhere in this vessel");
    expect(re.symbolWidenBlock(PARENT_ERR, FILES, 3)).toEqual({ text: "", symbols: [] });
  });

  it("at most three symbols per round, each once", () => {
    expect(has("symbolWidenBlock", re)).toBe(true);
    const many = ["a1", "a2", "a3", "a4"].map((s) => `src/site.ts(3,13): error TS2304: Cannot find name '${s}'.`).join("\n") + `\n${TS2304}\n${TS2304}`;
    expect(re.symbolWidenBlock(many, FILES, 3).symbols).toEqual(["a1", "a2", "a3"]);
  });

  it("the repair round calls it before the repair prompt's LLM call (wiring)", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const call = src.indexOf("const fix = parseJsonObject(await llmCallWithFailover(");
    expect(call).toBeGreaterThan(0);
    const widen = src.lastIndexOf("symbolWidenBlock(errText", call);
    expect(widen).toBeGreaterThan(0);
    expect(src.lastIndexOf("Deterministic error-site grounding", call)).toBeLessThan(widen);
    expect(src.slice(widen, call)).toContain("errorSiteWindow += widen.text");
  });
});
