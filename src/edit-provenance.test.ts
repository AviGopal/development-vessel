// Pins the two gates on LLM-re-derived edit anchors.
//
// THE OBSERVED CASE (2026-08-11, on the compose host). feature-compose re-derives
// an anchor when the planned one does not match the live bytes, and accepted the
// candidate on ONE test: it occurs exactly once. The model returned a DOC-COMMENT
// line — genuinely unique — paired with `if (this.childProcess?.exitCode !== null) {`
// for a module that is not a class. The edit applied, PARSED (it landed inside a
// block comment), and no gate fired.
import { describe, expect, test } from "bun:test";
import { anchorCameFromWindow, unknownMemberAccesses, refuseRederivedEdit } from "./edit-provenance";

// The real corrupted file, reduced to what the gates read.
const MODULE = `
/**
 * A CROSS-PROCESS capacity bound for compose.
 *
 * never "the fleet is wedged".
 */
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
async function holderAlive(path: string): Promise<boolean> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return true;
}
`;

describe("the observed corruption is refused", () => {
  test("a replacement referencing this.<prop> in a module with no class is refused", () => {
    const r = refuseRederivedEdit({
      candidateAnchor: ' * never "the fleet is wedged".',
      replacement: "      if (this.childProcess?.exitCode !== null) {",
      window: MODULE,
      moduleText: MODULE,
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("replacement_introduces_unknown_symbol");
    expect(r!.detail).toContain("this.childProcess");
  });

  test("CONTROL — the same shape is ALLOWED once the module really has that field", () => {
    const asClass = MODULE + "\nclass Runner { childProcess: any; }\n";
    expect(
      refuseRederivedEdit({
        candidateAnchor: ' * never "the fleet is wedged".',
        replacement: "      if (this.childProcess?.exitCode !== null) {",
        window: asClass,
        moduleText: asClass,
      }),
    ).toBeNull();
  });

  test("an anchor the model did not get from its window is refused", () => {
    const r = refuseRederivedEdit({
      candidateAnchor: "const somethingNeverShown = 1;",
      replacement: "const somethingNeverShown = 2;",
      window: MODULE,
      moduleText: MODULE + "\nconst somethingNeverShown = 1;\n",
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("anchor_not_from_window");
  });
});

describe("ordinary correct edits are NOT refused — the gate must not cost good work", () => {
  test("an edit anchored in the window with grounded symbols passes", () => {
    expect(
      refuseRederivedEdit({
        candidateAnchor: "async function holderAlive(path: string): Promise<boolean> {",
        replacement: "async function holderAlive(path: string, now: number): Promise<boolean> {",
        window: MODULE,
        moduleText: MODULE,
      }),
    ).toBeNull();
  });

  test("a replacement introducing a fresh LOCAL is fine — only member access is judged", () => {
    expect(unknownMemberAccesses("const freshLocal = 1; return freshLocal;", MODULE)).toEqual([]);
  });

  test("ambient receivers are not hallucinations", () => {
    expect(unknownMemberAccesses("console.log(JSON.stringify(Math.max(1,2)));", MODULE)).toEqual([]);
  });

  test("a receiver the module already names is grounded", () => {
    expect(unknownMemberAccesses("await unlink.call(null);", MODULE)).toEqual([]);
  });
});

describe("both gates FAIL OPEN — a check that cannot decide must allow", () => {
  test("no window means no evidence, so the anchor is allowed", () => {
    expect(anchorCameFromWindow("anything at all", "")).toBe(true);
  });

  test("empty module text yields no symbol refusals", () => {
    expect(unknownMemberAccesses("this.whatever.deeply.nested", "")).toEqual([]);
  });

  test("empty replacement yields no refusals", () => {
    expect(unknownMemberAccesses("", MODULE)).toEqual([]);
    expect(refuseRederivedEdit({ candidateAnchor: "", replacement: "", window: "", moduleText: "" })).toBeNull();
  });
});

describe("anchorCameFromWindow tolerates reflowed whitespace, not invented text", () => {
  test("indentation differences are not a provenance failure", () => {
    expect(anchorCameFromWindow("async function holderAlive(path: string): Promise<boolean> {", MODULE)).toBe(true);
    expect(anchorCameFromWindow("async   function holderAlive(path: string):  Promise<boolean> {", MODULE)).toBe(true);
  });

  test("text that is simply not there is refused", () => {
    expect(anchorCameFromWindow("function thatWasNeverShown() {", MODULE)).toBe(false);
  });
});
