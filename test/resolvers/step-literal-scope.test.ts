import { describe, expect, test } from "bun:test";
import { isLiteralOnlyStepClose, literalInReaderBody } from "../../src/resolvers/gap-to-feature";

// A decomposed step's literal counts only in comment-free code inside its literal_reader, and a close that rests
// only on such a literal is recorded landed_literal_only, not landed_verified (2026-09-30: a782ec1 closed on a
// module-level constant the draft added; 0f7e688 closed landed_verified on a helper name and was a regression).
describe("a step literal counts only inside its reader", () => {
  test("inside a function definition's body", () => {
    const src = "export function handleGapWritten(d) {\n  const x = d.variant_of;\n  return x;\n}\n";
    expect(literalInReaderBody(src, "variant_of", "handleGapWritten")).toBe(true);
  });
  test("only in a comment inside the body does not count", () => {
    const src = "function handleGapWritten(d) {\n  // TODO variant_of\n  /* variant_of */\n  return d;\n}\n";
    expect(literalInReaderBody(src, "variant_of", "handleGapWritten")).toBe(false);
  });
  test("a module-level constant the reader never uses does not count (the a782ec1 shape)", () => {
    const src = "const ID_FIXTURE = `x`;\nconst ALL = [ID_FIXTURE];\nbeforeAll(async () => {\n  await seed(ALL);\n});\n";
    expect(literalInReaderBody(src, "ID_FIXTURE", "beforeAll")).toBe(false);
  });
  test("inside a callback passed to a call (afterAll(() => { … }))", () => {
    const src = "afterAll(async () => {\n  await remove(ID_FIXTURE);\n});\n";
    expect(literalInReaderBody(src, "ID_FIXTURE", "afterAll")).toBe(true);
  });
  test("a plain call has no body, so a later unrelated block cannot stand in for it", () => {
    const src = "const r = searchTemplates(q);\nif (r) {\n  log('template_validation_pass');\n}\n";
    expect(literalInReaderBody(src, "template_validation_pass", "searchTemplates")).toBeNull();
  });
  test("a reader that is not in the file is unknown, never 'fixed'", () => {
    expect(literalInReaderBody("const a = 1;\n", "a", "missingReader")).toBeNull();
  });
});

describe("a close resting only on a step literal is not a verification", () => {
  test("a decomposed step with only an expected_literal is literal-only", () => {
    expect(isLiteralOnlyStepClose({ predicate_source: "decompose", expected_literal: "variant_of" })).toBe(true);
  });
  test("a step that also carries a measured check is not literal-only", () => {
    expect(isLiteralOnlyStepClose({ predicate_source: "decompose", expected_literal: "x", evidence_resolve: { shape: "test_suite" } })).toBe(false);
    expect(isLiteralOnlyStepClose({ predicate_source: "decompose", expected_literal: "x", verify_shape: "s" })).toBe(false);
  });
  test("a non-decomposed literal gap and an empty literal are not literal-only", () => {
    expect(isLiteralOnlyStepClose({ expected_literal: "x" })).toBe(false);
    expect(isLiteralOnlyStepClose({ predicate_source: "decompose", expected_literal: "  " })).toBe(false);
  });
});

// Return-type annotations are skipped as one balanced type expression (qa's parser probe, 2026-09-30).
describe("a return-type annotation is never the body", () => {
  test("a literal in the real body counts even when the return type contains braces", () => {
    const src = "const R = async (x: string): Promise<{ a: number }> => { return { a: LIT_IN_BODY }; };\n";
    expect(literalInReaderBody(src, "LIT_IN_BODY", "R")).toBe(true);
  });
  test("a literal that exists only in the return type does NOT count (the unsafe direction)", () => {
    const src = "const R = async (x: string): Promise<{ LIT_T: number }> => { return { a: 1 }; };\n";
    expect(literalInReaderBody(src, "LIT_T", "R")).toBe(false);
  });
  test("a type-literal return type on a function declaration is skipped", () => {
    const src = "function R(x: number): { ok: boolean } {\n  return { ok: LIT_OK };\n}\n";
    expect(literalInReaderBody(src, "LIT_OK", "R")).toBe(true);
    expect(literalInReaderBody("function R(x: number): { LIT_TYPE_ONLY: boolean } {\n  return { a: 1 };\n}\n", "LIT_TYPE_ONLY", "R")).toBe(false);
  });
});

describe("a destructured parameter of a definition is not its body", () => {
  test("a literal in the body of a definition with destructured params counts", () => {
    expect(literalInReaderBody("const R = async ({ id }) => {\n  use(LIT_BODY, id);\n};\n", "LIT_BODY", "R")).toBe(true);
  });
  test("a literal that exists only in a destructured parameter does NOT count", () => {
    expect(literalInReaderBody("const R = async ({ LIT_PARAM }) => {\n  return 1;\n};\n", "LIT_PARAM", "R")).toBe(false);
  });
});
