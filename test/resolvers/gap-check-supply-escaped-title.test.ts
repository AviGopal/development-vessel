// A TEST TITLE WRITTEN WITH AN ESCAPE IS STILL A DECLARED TITLE (gap check-supply-drops-any-test-whose-title-contains-
// an-escape-so-a-correct-red-check-reads-green-and-the-gap-never-arms).
//
// declaredTestTitles decodes each quoted title (`'the widget\'s total'` -> the widget's total), then kept it only when
// testTitleInSource found the DECODED text verbatim in the source, which a title written with \' or \" never holds. The
// arm step therefore judged only the check's other titles: a correct must-fail written that way was dropped, the control
// alone ran green, and the gap read green_at_head and never armed. testTitleSegmentOffset now also finds the spelling a
// quote kind gives the segment, and the arm step's body reader (testBody, for existenceOnlyCheck) matches decoded titles.
//
//   [MUST-FAIL] a single-quoted title with \' is declared, and the arm split puts it on the red side.
//   [MUST-FAIL] a double-quoted title with \" is declared, and the arm split puts it on the red side.
//   [MUST-FAIL] the escaped title's assertions are read by existenceOnlyCheck (a behaviour assertion keeps it armable).
//   [CONTROL]   plain titles are declared unchanged, in order.
//   [CONTROL]   a title the source does not hold is not in it, escaped or not.
//   [CONTROL]   a template title with a placeholder is still skipped.
//   [CONTROL]   `describe > it` run names still match segment by segment.
import { describe, expect, it } from "bun:test";
import { declaredTestTitles, existenceOnlyCheck, splitRedGreen } from "../../src/resolvers/gap-check-supply.js";
import { testTitleInSource, testTitleSegmentOffset } from "../../src/resolvers/retry-evidence.js";

const SINGLE = String.raw`import { expect, it } from "bun:test";
import { total } from "../../src/widget.js";
it('MUST-FAIL reports the widget\'s total as counted', () => {
  expect(total([2, 2])).toBe(4);
});
it("CONTROL an empty list totals zero", () => {
  expect(total([])).toBe(0);
});
`;
const DOUBLE = String.raw`import { expect, it } from "bun:test";
import { total } from "../../src/widget.js";
it("MUST-FAIL flags the \"spare\" widget as unused", () => {
  expect(total([1])).toBe(1);
});
it('CONTROL a single widget totals itself', () => {
  expect(total([3])).toBe(3);
});
`;
const EXISTENCE_CONTROL = String.raw`import { expect, it } from "bun:test";
import { total } from "../../src/widget.js";
it('MUST-FAIL counts the widget\'s parts', () => {
  expect(total([1, 2, 3])).toBe(6);
});
it("CONTROL total is a function", () => {
  expect(typeof total).toBe("function");
});
`;
const MF_SINGLE = "MUST-FAIL reports the widget's total as counted";
const MF_DOUBLE = 'MUST-FAIL flags the "spare" widget as unused';
const MF_PARTS = "MUST-FAIL counts the widget's parts";

describe("a title written with an escape is declared", () => {
  it("MUST-FAIL a single-quoted title with an escaped quote is kept, and the arm split reads it red", () => {
    const titles = declaredTestTitles(SINGLE);
    expect(titles).toEqual([MF_SINGLE, "CONTROL an empty list totals zero"]);
    expect(testTitleInSource(SINGLE, MF_SINGLE)).toBe(true);
    // bun reports the decoded run name; the arm step splits its new titles on the report's failing names.
    const split = splitRedGreen({ failingTests: [MF_SINGLE] }, titles);
    expect(split.red).toEqual([MF_SINGLE]);
    expect(split.green).toEqual(["CONTROL an empty list totals zero"]);
  });

  it("MUST-FAIL a double-quoted title with an escaped quote is kept, and the arm split reads it red", () => {
    const titles = declaredTestTitles(DOUBLE);
    expect(titles).toEqual([MF_DOUBLE, "CONTROL a single widget totals itself"]);
    expect(testTitleInSource(DOUBLE, MF_DOUBLE)).toBe(true);
    const split = splitRedGreen({ failingTests: [MF_DOUBLE] }, titles);
    expect(split.red).toEqual([MF_DOUBLE]);
    expect(split.green).toEqual(["CONTROL a single widget totals itself"]);
  });

  it("MUST-FAIL the escaped title's assertions are read by existenceOnlyCheck", () => {
    const ex = existenceOnlyCheck(EXISTENCE_CONTROL, [MF_PARTS, "CONTROL total is a function"]);
    expect(ex).toEqual({ existence_only: false, assertions: 2, existence: 1 });
  });
});

describe("title reading that the escape does not touch", () => {
  it("CONTROL plain titles are declared unchanged, in order", () => {
    const src = `it("adds two widgets", () => {});\ntest('drops a missing widget', () => {});\nit(\`counts every widget\`, () => {});\n`;
    expect(declaredTestTitles(src)).toEqual(["adds two widgets", "drops a missing widget", "counts every widget"]);
    expect(existenceOnlyCheck(EXISTENCE_CONTROL, ["CONTROL total is a function"])).toEqual({ existence_only: true, assertions: 1, existence: 1 });
  });

  it("CONTROL a title the source does not hold is not in it, escaped or not", () => {
    expect(testTitleInSource(SINGLE, "an invented title nobody wrote")).toBe(false);
    expect(testTitleInSource(SINGLE, "MUST-FAIL reports the gadget's total as counted")).toBe(false);
    expect(testTitleSegmentOffset(DOUBLE, 'flags the "other" widget')).toBe(-1);
    expect(existenceOnlyCheck(SINGLE, ["an invented title nobody wrote"])).toEqual({ existence_only: false, assertions: 0, existence: 0 });
  });

  it("CONTROL a template title with a placeholder is still skipped", () => {
    const src = "for (const label of [\"a\", \"b\"]) {\n  it(`[${label}] picks a widget`, () => {});\n}\nit(\"a plain widget title\", () => {});\n";
    expect(declaredTestTitles(src)).toEqual(["a plain widget title"]);
  });

  it("CONTROL describe > it run names still match segment by segment", () => {
    const src = `describe("widget totals", () => {\n  it("adds two numbers", () => {});\n});\n`;
    expect(testTitleInSource(src, "widget totals > adds two numbers")).toBe(true);
    expect(testTitleInSource(src, "widget totals > subtracts two numbers")).toBe(false);
    expect(testTitleInSource(src, "gadget totals > adds two numbers")).toBe(false);
  });
});
