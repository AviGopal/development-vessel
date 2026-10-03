// NON-PRINTING BYTES ARE VISIBLE IN THE DRAFTER'S WINDOW AND BINDABLE AT APPLY
// (gap grounding-windows-render-control-bytes-invisibly-so-the-drafter-cannot-anchor-on-them, check-first).
//
// Measured (qa audit, 44 picks): feature_compose's grounding window showed edit-site source with
// non-printing bytes RAW. goal-host-vessel's goal-target-inference.ts:499 holds a raw 0x08 inside a
// regex literal where `\b` was meant. The drafter cannot see the byte, so it wrote `\b`
// (anchor_not_found) or returned ops:[] (5 empty plans, 2 anchor drops): the control-byte regex gap
// family could never land.
//
// Expected:
//   (a) a window over a line holding a raw 0x08 shows `\x08` and a one-line legend;
//   (b) an anchor written with `\x08` binds to the raw-byte line, and the edit applies there;
//   (c) CONTROL: a window over printable-only source is byte-identical to the pre-fix format;
//   (d) CONTROL: an anchor holding a literal backslash-x sequence that exists in source binds literally;
//   (e) end to end: the :499-like line, rendered, quoted by the drafter, with the byte replaced by `\b`,
//       produces a file with no 0x08.
// Also: an anchor matching BOTH literally and decoded, at different places, is refused as ambiguous;
// a drafted replace_lines boundary line in rendered form matches; the anchor-in-window gate accepts it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertAnchorInWindow, groundingFileBlock } from "../../src/resolvers/feature-compose.js";
import { bindDraftedAnchor, CONTROL_BYTE_LEGEND, lineMatchesDrafted, renderControlBytes } from "../../src/control-bytes.js";

const BS = "\u0008"; // the raw byte, written as an escape so this test file itself stays printable
const LINE_499 = `  const empty = ((/${BS}(compute|calculate|how many)${BS}/i.test(goal) && known) ? a : b);`;
const FILE_499 = ["// head", "const known = true;", LINE_499, "export {};"].join("\n");
const whole = (content: string) => ({ slice: content, centered: false, head: true });

/** fs_edit's semantics: the anchor must occur exactly once; replace that occurrence. */
function applyEdit(content: string, oldString: string, newString: string): string {
  const n = content.split(oldString).length - 1;
  if (n !== 1) throw new Error(`anchor occurs ${n} times`);
  return content.replace(oldString, () => newString);
}

describe("(a) a raw control byte is rendered visibly in the grounding window", () => {
  test("the window over a 0x08 line shows \\x08 plus the legend, and holds no raw byte", () => {
    const block = groundingFileBlock("repos/goal-host-vessel/src/goal-target-inference.ts", FILE_499, whole(FILE_499), true);
    expect(block).toContain("3\t  const empty = ((/\\x08(compute|calculate|how many)\\x08/i.test(goal)");
    expect(block).not.toContain(BS);
    expect(CONTROL_BYTE_LEGEND.length).toBeGreaterThan(0);
    expect(CONTROL_BYTE_LEGEND).not.toContain("\n");
    expect(block.endsWith(`\n${CONTROL_BYTE_LEGEND}`)).toBe(true);
  });
  test("C0 (not TAB/LF), DEL and C1 are rendered; TAB and LF are not", () => {
    const r = renderControlBytes("a\u0000b\u001Bc\u007Fd\u0085e\tf\ng");
    expect(r.text).toBe("a\\x00b\\x1Bc\\x7Fd\\x85e\tf\ng");
    expect(r.escaped).toBe(4);
  });
});

describe("(c) CONTROL: printable-only source renders exactly as before", () => {
  test("a target window is byte-identical to the pre-fix format, with no legend", () => {
    const src = "import x from \"y\";\n\tconst re = /\\bword\\b/;\nexport {};";
    expect(groundingFileBlock("repos/v/src/f.ts", src, whole(src), true))
      .toBe("----- repos/v/src/f.ts -----\n1\timport x from \"y\";\n2\t\tconst re = /\\bword\\b/;\n3\texport {};");
  });
  test("a non-target windowed block is byte-identical too", () => {
    const src = "line one\nline two\nline three";
    expect(groundingFileBlock("repos/v/src/g.ts", src, { slice: "line two", centered: true, head: false }, false))
      .toBe("----- repos/v/src/g.ts -----\n… (head omitted)\nline two\n… (windowed around the change site; head/tail omitted)");
  });
});

describe("(b) an anchor quoting \\x08 binds to the raw byte and the edit applies there", () => {
  test("decoded binding", () => {
    const bound = bindDraftedAnchor(FILE_499, "/\\x08(compute|calculate|how many)\\x08/i");
    expect(bound).toEqual({ anchor: `/${BS}(compute|calculate|how many)${BS}/i`, via: "decoded" });
    if (!("anchor" in bound)) throw new Error("refused");
    const out = applyEdit(FILE_499, bound.anchor, "/\\b(compute|calculate|how many)\\b/i");
    expect(out.split("\n")[2]).toBe("  const empty = ((/\\b(compute|calculate|how many)\\b/i.test(goal) && known) ? a : b);");
  });
});

describe("(d) CONTROL: a literal backslash-x sequence in source still binds literally", () => {
  test("literal first", () => {
    const src = "const esc = \"\\x08\"; // a real four-char escape in source\nexport {};";
    expect(bindDraftedAnchor(src, "const esc = \"\\x08\";")).toEqual({ anchor: "const esc = \"\\x08\";", via: "literal" });
  });
  test("\\x41 (a printable byte) is never decoded", () => {
    expect(bindDraftedAnchor("A\\x41", "\\x41")).toEqual({ anchor: "\\x41", via: "literal" });
  });
  test("an anchor matching BOTH literally and decoded, at different places, is refused as ambiguous", () => {
    const src = `const lit = "\\x08";\nconst raw = "${BS}";`;
    const bound = bindDraftedAnchor(src, "\"\\x08\"");
    expect("refused" in bound && bound.refused).toBe("ambiguous_control_byte_anchor");
  });
});

describe("(e) end to end over the goal-target-inference.ts:499-like line", () => {
  test("rendered window -> drafter quotes the rendered line -> bind -> apply -> no 0x08 in the file", () => {
    const block = groundingFileBlock("repos/goal-host-vessel/src/goal-target-inference.ts", FILE_499, whole(FILE_499), true);
    const shownLine = block.split("\n").find((l) => l.startsWith("3\t"))!.replace(/^\d+\t/, "");
    // The drafter quotes the line it SEES as old_string and writes the proper escape in new_string.
    const newString = shownLine.replace(/\\x08/g, "\\b");
    expect(assertAnchorInWindow(block, [{ kind: "edit", path: "repos/goal-host-vessel/src/goal-target-inference.ts", old_string: shownLine }])).toEqual([]);
    const bound = bindDraftedAnchor(FILE_499, shownLine);
    if (!("anchor" in bound)) throw new Error("refused");
    const out = applyEdit(FILE_499, bound.anchor, newString);
    expect(out).not.toContain(BS);
    expect(out).toContain("/\\b(compute|calculate|how many)\\b/i.test(goal)");
  });
});

describe("the other matchers accept the rendered form", () => {
  test("a drafted replace_lines boundary line in rendered form matches the raw line", () => {
    expect(lineMatchesDrafted(LINE_499, "  const empty = ((/\\x08(compute|calculate|how many)\\x08/i.test(goal) && known) ? a : b);")).toBe(true);
    expect(lineMatchesDrafted(LINE_499, LINE_499)).toBe(true);
    expect(lineMatchesDrafted(LINE_499, "something else")).toBe(false);
  });
  test("the anchor-in-window gate accepts an anchor holding the raw byte against a rendered window", () => {
    const block = groundingFileBlock("repos/v/src/f.ts", FILE_499, whole(FILE_499), true);
    expect(assertAnchorInWindow(block, [{ kind: "edit", path: "repos/v/src/f.ts", old_string: LINE_499.trim() }])).toEqual([]);
  });
});

describe("wiring (source inspection: the call sites live inside feature_compose's network-bound closure)", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
  test("groundVesselFiles builds every file block through groundingFileBlock", () => {
    expect(src).toContain("contentParts.push(groundingFileBlock(");
  });
  test("the apply step binds the drafted anchor before counting occurrences", () => {
    expect(src).toMatch(/bindDraftedAnchor\(liveContent, op\.old_string/);
  });
  test("replace_lines compares boundary lines through lineMatchesDrafted", () => {
    expect(src).toContain("lineMatchesDrafted(gotFirst, op.expect_first_line)");
    expect(src).toContain("lineMatchesDrafted(gotLast, op.expect_last_line)");
  });
});
