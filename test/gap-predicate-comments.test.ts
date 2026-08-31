import { describe, it, expect } from "bun:test";
import { stripComments, derivePredicateLiteral } from "../src/gap-predicate.js";

// Uniqueness alone is not enough to make a class-1 predicate safe.
//
// Measured over the live store when this was added: 127 open gaps citing a
// development-vessel file, 47 yielding a unique literal — and **14 of those 47 (30%) had
// their only match INSIDE A COMMENT**. The recurring one, shared by several sibling
// route-edit gaps, was `re-test path (penalty, not hard exclusion)`: pure prose.
//
// A comment-anchored predicate reads ABSENT as soon as someone rewords the comment, so the
// gap closes green while the defect it names is untouched. That is the false-closure this
// module's own header calls worse than having no predicate at all.
describe("stripComments", () => {
  it("blanks line and block comments", () => {
    expect(stripComments("const a=1; // secretLiteralHere\n")).not.toContain("secretLiteralHere");
    expect(stripComments("/* secretLiteralHere */ const a=1;")).not.toContain("secretLiteralHere");
  });

  it("does NOT eat a // inside a string — the opposite failure", () => {
    // A naive stripper deletes from `//` in "https://…" and blanks real code, which pins a
    // gap open forever against a string the file no longer appears to contain.
    expect(stripComments(`const u = "https://example.com/path";`)).toContain("https://example.com/path");
    expect(stripComments(`const s = "a // b";`)).toContain("a // b");
    expect(stripComments("const t = `kill -9 -$__cpid`;")).toContain("kill -9 -$__cpid");
    expect(stripComments(`const s = 'x // y';`)).toContain("x // y");
  });

  it("honours escaped quotes so a string does not end early", () => {
    // If the escape is mishandled the parser thinks the string closed at the inner quote,
    // re-enters code mode, and then eats `// c` as a comment.
    const src = 'const s = "a\\"b // c";';
    expect(stripComments(src)).toContain("// c");
  });

  it("preserves length and newlines so offsets and line numbers still hold", () => {
    const src = "const a=1; // xx\nconst b=2;\n/* y\nz */\n";
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });

  it("handles an unterminated block comment without hanging or throwing", () => {
    expect(() => stripComments("const a=1; /* never closed")).not.toThrow();
  });
});

describe("derivePredicateLiteral — comment exclusion", () => {
  it("REJECTS a literal whose only occurrence is in a comment", () => {
    // The measured 30% case. This is the whole point of the change.
    expect(derivePredicateLiteral(
      "gap about `re-test path (penalty, x)`",
      "// re-test path (penalty, x)\nconst a=1;",
    )).toBeNull();
  });

  it("still derives a literal that occurs once in real code", () => {
    expect(derivePredicateLiteral(
      "gap about `actionableGapsPush(g)`",
      "actionableGapsPush(g);\nconst a=1;",
    )).toBe("actionableGapsPush(g)");
  });

  it("derives when the literal appears in BOTH a comment and code", () => {
    // Blanking the comment leaves the code occurrence unique — and the code site is the one
    // the oracle should track, so this must still qualify.
    expect(derivePredicateLiteral(
      "gap about `uniqueCodeToken99`",
      "// uniqueCodeToken99 explains it\nconst x = uniqueCodeToken99;",
    )).toBe("uniqueCodeToken99");
  });

  it("does not derive from a literal appearing twice in code", () => {
    // Unchanged behaviour: two matches cannot distinguish "fixed" from "one of two fixed".
    expect(derivePredicateLiteral(
      "gap about `duplicatedTokenXY`",
      "const a = duplicatedTokenXY;\nconst b = duplicatedTokenXY;",
    )).toBeNull();
  });

  it("does not derive a code literal that lives only inside a string in a comment", () => {
    // Belt and braces: a quoted span inside a block comment is still comment text.
    expect(derivePredicateLiteral(
      'gap about `someUniqueThing42`',
      '/* the fix is "someUniqueThing42" per the note */\nconst a=1;',
    )).toBeNull();
  });
});
