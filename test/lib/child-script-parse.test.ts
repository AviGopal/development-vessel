/**
 * child-script-parse — the child scripts a test passes to `bun --eval` as a template literal, cooked as the runtime cooks
 * them and parsed; the per-case call the test-defect localization makes from a stored failure; and the certifier the
 * test-defect admission runs on a parent and a draft text (src/lib/child-script-parse.ts).
 *   (a) MUST-FAIL: an escape the outer template cooks into the child (`'active\n'`) is a child script that does not
 *       parse; the same text with the escape doubled parses.
 *   (b) MUST-FAIL: a row whose every failing case runs an unparseable child script and carries a parse error is a test
 *       defect; one case failing elsewhere makes it mixed.
 *   CONTROL: a parse error whose case's child scripts all parse (a SyntaxError raised from src) is src; an assertion
 *       failure is src; a case not in the file is unlocated.
 *   (c) MUST-FAIL: the certifier admits only red-on-parent, green-on-draft, and refuses every draft that greens it by
 *       removing what it measures (a case, a child script) or by adding a skip, todo or only mark.
 * The fixtures are built here (never read from the vessel's own tests, which the system may fix).
 */
import { describe, expect, it } from "bun:test";
import { caseChildScripts, certifyTestDefectDraft, childScripts, classifyTestDefect, cookTemplate, testFileShape } from "../../src/lib/child-script-parse.js";

const BT = "`";
// Text of a test file: each case spawns a child whose source is a template literal; `body` is that literal's raw text.
const childCase = (title: string, body: string, mark = ""): string =>
  `  it${mark}("${title}", async () => {\n    const child = Bun.spawn([process.execPath, "--eval", ${BT}\n      const { f } = await import('\${import.meta.url}');\n${body}\n      process.stdout.write("ok");\n    ${BT}]);\n    expect(await new Response(child.stdout).text()).toBe("ok");\n  });\n`;
const plainCase = (title: string): string => `  it("${title}", () => {\n    expect(1).toBe(1);\n  });\n`;
const file = (...cases: string[]): string => `import { describe, expect, it } from "bun:test";\ndescribe("d", () => {\n${cases.join("")}});\n`;
// The defect: the template cooks \n into a real newline inside a single-quoted child string.
const BAD = "      const b = new Blob(['active\\n']);";
// The fix: the escape doubled, so the child's string holds the \n escape itself.
const GOOD = "      const b = new Blob(['active\\\\n']);";
const PARENT = file(childCase("a via child", BAD), childCase("b via child", BAD), childCase("c via child", GOOD), plainCase("d plain"));
const FIXED = file(childCase("a via child", GOOD), childCase("b via child", GOOD), childCase("c via child", GOOD), plainCase("d plain"));
const P = "d > ";

describe("child scripts: extraction and parse", () => {
  it("[MUST-FAIL] a cooked escape that breaks a child string is a child script that does not parse; the doubled escape parses", () => {
    const s = childScripts(PARENT);
    expect(s).toHaveLength(3);
    expect(s.map((x) => x.error === null)).toEqual([false, false, true]);
    expect(String(s[0]!.error)).toContain("Unterminated");
    expect(childScripts(FIXED).every((x) => x.error === null)).toBe(true);
  });
  it("[CONTROL] cooking processes escapes and drops a line continuation; an interpolation is one placeholder", () => {
    expect(cookTemplate("a\\nb\\tc\\\\d\\`e\\$f\\x41\\u0042\\u{43}")).toBe("a\nb\tc\\d`e$fABC");
    expect(cookTemplate("a\\\nb")).toBe("ab");
    expect(childScripts(PARENT)[2]!.code).toContain("await import('__tpl__')");
  });
  it("[CONTROL] each case holds the child scripts in its own body", () => {
    expect(caseChildScripts(PARENT).map((c) => [c.title, c.scripts.length])).toEqual([["a via child", 1], ["b via child", 1], ["c via child", 1], ["d plain", 0]]);
  });
});

describe("the per-case call", () => {
  const parseErr = "error: Unterminated string literal";
  it("[MUST-FAIL] every failing case a parse error in an unparseable child script: test_defect", () => {
    const c = classifyTestDefect(PARENT, [{ name: P + "a via child", error: parseErr }, { name: P + "b via child", error: parseErr }]);
    expect(c.verdict).toBe("test_defect");
    expect(c.cases.map((k) => k.call)).toEqual(["test_defect", "test_defect"]);
  });
  it("[MUST-FAIL] one case failing outside its child scripts makes the row mixed, per case", () => {
    const c = classifyTestDefect(PARENT, [{ name: P + "a via child", error: parseErr }, { name: P + "c via child", error: "error: Mock failure" }]);
    expect(c.verdict).toBe("mixed");
    expect(c.cases.map((k) => k.call)).toEqual(["test_defect", "src"]);
  });
  it("[CONTROL] a SyntaxError whose case's child scripts all parse is src (raised from a src frame, not the test)", () => {
    const c = classifyTestDefect(PARENT, [{ name: P + "c via child", error: "error: Unexpected token '}'" }]);
    expect(c.verdict).toBe("none");
    expect(c.cases[0]!.call).toBe("src");
    expect(c.cases[0]!.why).toContain("every child script of the case parses");
  });
  it("[CONTROL] an assertion failure, a parse error in a case with no child script, and the parent's JSON.parse EOF alone are src", () => {
    expect(classifyTestDefect(PARENT, [{ name: P + "a via child", error: "error: expect(received).toBe(expected)" }]).verdict).toBe("none");
    expect(classifyTestDefect(PARENT, [{ name: P + "d plain", error: parseErr }]).cases[0]!.call).toBe("src");
    expect(classifyTestDefect(PARENT, [{ name: P + "a via child", error: "SyntaxError: JSON Parse error: Unexpected EOF" }]).verdict).toBe("none");
  });
  it("[CONTROL] a case not in the file is unlocated; no failure is none", () => {
    expect(classifyTestDefect(PARENT, [{ name: P + "gone", error: parseErr }]).cases[0]!.call).toBe("unlocated");
    expect(classifyTestDefect(PARENT, []).verdict).toBe("none");
  });
});

describe("the certifier", () => {
  it("[MUST-FAIL] red on the parent and green on the draft, nothing removed: certified", () => {
    const c = certifyTestDefectDraft(PARENT, FIXED);
    expect(c.ok).toBe(true);
    expect(c.parent).toEqual({ cases: 4, skip_marks: 0, child_scripts: 3, unparseable: 2 });
    expect(c.draft.unparseable).toBe(0);
  });
  it("[CONTROL] a parent whose child scripts all parse cannot certify (the check is not red there)", () => {
    expect(certifyTestDefectDraft(FIXED, FIXED).ok).toBe(false);
  });
  it("[MUST-FAIL] a draft that still has an unparseable child script is refused", () => {
    const partial = file(childCase("a via child", GOOD), childCase("b via child", BAD), childCase("c via child", GOOD), plainCase("d plain"));
    expect(certifyTestDefectDraft(PARENT, partial)).toMatchObject({ ok: false, reason: expect.stringContaining("still do not parse") });
  });
  it("[MUST-FAIL] a draft that deletes a failing case is refused", () => {
    const dropped = file(childCase("a via child", GOOD), childCase("c via child", GOOD), plainCase("d plain"));
    expect(certifyTestDefectDraft(PARENT, dropped)).toMatchObject({ ok: false, reason: expect.stringContaining("removes test cases") });
  });
  it("[MUST-FAIL] a draft that removes a child script (the case kept) is refused", () => {
    const noChild = file(childCase("a via child", GOOD), plainCase("b via child"), childCase("c via child", GOOD), plainCase("d plain"));
    expect(certifyTestDefectDraft(PARENT, noChild)).toMatchObject({ ok: false, reason: expect.stringContaining("removes child scripts") });
  });
  for (const mark of [".skip", ".todo", ".only", ".skipIf(true)"]) {
    it(`[MUST-FAIL] a draft that adds it${mark} is refused`, () => {
      const marked = file(childCase("a via child", GOOD, mark), childCase("b via child", GOOD), childCase("c via child", GOOD), plainCase("d plain"));
      expect(testFileShape(marked).skip_marks).toBe(1);
      expect(certifyTestDefectDraft(PARENT, marked)).toMatchObject({ ok: false, reason: expect.stringContaining("adds skip/todo/only") });
    });
  }
});
