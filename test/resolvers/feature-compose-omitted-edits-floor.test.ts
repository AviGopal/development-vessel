// CHECK-FIRST: a compose whose plan OMITS an edit the goal enumerates is not FAVORABLE.
//
// The ALL-EDITS FLOOR (b9537eb9, src/resolvers/feature-compose.ts) withholds FAVORABLE when a
// PLANNED op failed to APPLY (applyFailed). It cannot see a plan that never contained the op:
// "Apply exactly these 3 edits" planned as 2 ops, all applied, typechecks and greens — the same
// partial landing (3cced35 and 24a64a8 landed 1 of 3, f49d02e 4 of 5) by a different road.
//
// THE SEAM (exported from feature-compose.ts; absent at base):
//   omittedExactEditsRefusal(spec, ops, readPostApply) -> string | null
//     Refuses ONLY where the enumeration is deterministic: the spec parses as the strict numbered
//     exact-edit form the fc-exact path already reads (parseExactEditBlocks: one repo path,
//     "Apply exactly these N edits", EDIT k / old: / new: blocks, a closing "Done when:" line).
//     Returns a reason (containing "omits", so the existing classifier records the lesson as
//     partial_spec_omission) only when the plan has FEWER ops than N AND some EDIT k is covered by
//     nothing: not by an op's old_string (two adjacent edits merged into one op), not by an op's
//     new_string/content, and not by the post-apply file (an edit a prior attempt already landed).
//     It only refuses; it never adds ops. Any other spec returns null.
//   Wiring: resolveFeatureComposeInner calls it on pointer.spec right after the all-edits
//   floor and before the autonomy-scope floor, and flips verdict to UNFAVORABLE on a reason.
//
// MUST-FAIL (red at base): the omission cases and the wiring pin.
// CONTROLS: the b9537eb9 floor pin and the classifier reuse are green at base; the seam controls
// (single edit, merged ops, prose list, other dialects, retry after a partial landing, full plan)
// need the seam, so they are red at base BY CONSTRUCTION (TypeError: not a function), never by an
// assertion — they keep false refusals from appearing once the seam exists.
//
// Pure: no LLM, no network, no fs writes.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as fc from "../../src/resolvers/feature-compose.js";

type Op = { kind: "create_file" | "edit" | "replace_lines"; path: string; old_string?: string; new_string?: string; content?: string };
type Seam = (spec: unknown, ops: ReadonlyArray<Op>, readPostApply: (path: string) => string | null) => string | null;
const seam = (): Seam => (fc as unknown as { omittedExactEditsRefusal: Seam }).omittedExactEditsRefusal;

const PATH = "repos/development-vessel/src/resolvers/sample.ts";
function exactSpec(edits: Array<{ old: string; new: string }>): string {
  const blocks = edits.map((e, i) => `EDIT ${i + 1}\nold:\n${e.old}\nnew:\n${e.new}`).join("\n\n");
  return `In ${PATH}, tidy the sample. Apply exactly these ${edits.length} edits; each old text occurs exactly once:\n${blocks}\nDone when: all ${edits.length} edits are present exactly once and the file typechecks.`;
}
const E1 = { old: "const alpha = 1;", new: "const alpha = 10;" };
const E2 = { old: "const beta = 2;", new: "const beta = 20;" };
const E3 = { old: "const gamma = 3;", new: "const gamma = 30;" };
const op = (e: { old: string; new: string }): Op => ({ kind: "edit", path: PATH, old_string: e.old, new_string: e.new });
const base = [E1.old, E2.old, E3.old].join("\n") + "\n";
const reader = (content: string | null) => (p: string): string | null => (p === PATH ? content : null);

const SRC = "src/resolvers/feature-compose.ts";
const sf = ts.createSourceFile(SRC, readFileSync(SRC, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(node: ts.Node, visit: (n: ts.Node) => void): void { visit(node); node.forEachChild((c) => walk(c, visit)); }
function fnNamed(name: string): ts.Node {
  let found: ts.Node | undefined;
  walk(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; });
  if (!found) throw new Error(`${name} not found in ${SRC}`);
  return found;
}
const mentions = (root: ts.Node, name: string): boolean => { let hit = false; walk(root, (n) => { if (ts.isIdentifier(n) && n.text === name) hit = true; }); return hit; };
const assignsUnfavorable = (root: ts.Node): boolean => {
  let hit = false;
  walk(root, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === "verdict"
      && ts.isStringLiteral(n.right) && n.right.text === "UNFAVORABLE") hit = true;
  });
  return hit;
};
const inner = fnNamed("resolveFeatureComposeInner");
// The b9537eb9 floor: an `if` naming both verdict and applyFailed whose then-branch sets verdict UNFAVORABLE.
function allEditsFloorIf(): ts.IfStatement | undefined {
  let found: ts.IfStatement | undefined;
  walk(inner, (n) => {
    if (!found && ts.isIfStatement(n) && mentions(n.expression, "applyFailed") && mentions(n.expression, "verdict") && assignsUnfavorable(n.thenStatement)) found = n;
  });
  return found;
}

describe("ALL-EDITS FLOOR (b9537eb9) stays pinned", () => {
  it("a planned op that fails to apply withholds FAVORABLE: the applyFailed `if` sets verdict UNFAVORABLE", () => {
    const floor = allEditsFloorIf();
    expect(floor).toBeDefined();
    // It guards on the FAVORABLE verdict (a floor, not a re-grade) and sits after the apply loop that sets applyFailed.
    expect(floor!.expression.getText(sf)).toContain('"FAVORABLE"');
    let applyLoopSet = -1;
    walk(inner, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === "applyFailed"
        && n.right.kind === ts.SyntaxKind.TrueKeyword) applyLoopSet = Math.max(applyLoopSet, n.getStart(sf));
    });
    expect(applyLoopSet).toBeGreaterThan(-1);
    expect(floor!.getStart(sf)).toBeGreaterThan(applyLoopSet);
  });
});

describe("classifier reuse: an omission reason records partial_spec_omission (control)", () => {
  it("composeLessonClass maps an 'omits' reason on an applied, verified draft to partial_spec_omission", () => {
    expect(fc.composeLessonClass(null, null, [{ ok: true }], [{ ok: true, output: "" }], "the plan omits EDIT 2 of 3")).toBe("partial_spec_omission");
  });
});

describe("omittedExactEditsRefusal — MUST-FAIL: an enumerated edit missing from the plan refuses", () => {
  it("3 enumerated edits, 2 ops, EDIT 2 nowhere: refused, names EDIT 2, classified partial_spec_omission", () => {
    const after = [E1.new, E2.old, E3.new].join("\n") + "\n";
    const reason = seam()(exactSpec([E1, E2, E3]), [op(E1), op(E3)], reader(after));
    expect(typeof reason).toBe("string");
    expect(reason!).toMatch(/omits/);
    expect(reason!).toContain("EDIT 2");
    expect(fc.composeLessonClass(null, null, [{ ok: true }, { ok: true }], [{ ok: true, output: "" }], reason!)).toBe("partial_spec_omission");
  });
  it("2 enumerated edits, 1 op, post-apply file unreadable: refused (no evidence the missing edit exists)", () => {
    expect(seam()(exactSpec([E1, E2]), [op(E1)], reader(null))).toMatch(/omits/);
  });
  it("wiring: the inner compose calls the seam on pointer.spec between the all-edits floor and the autonomy-scope floor, and a reason withholds FAVORABLE", () => {
    const floor = allEditsFloorIf();
    expect(floor).toBeDefined();
    const calls: ts.CallExpression[] = [];
    walk(inner, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "omittedExactEditsRefusal") calls.push(n); });
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.arguments[0]?.getText(sf)).toBe("pointer.spec");
    let scopeImport = -1;
    walk(inner, (n) => { if (scopeImport < 0 && ts.isStringLiteral(n) && n.text === "./gap-to-feature.js" && n.parent && ts.isCallExpression(n.parent) && n.parent.getText(sf).includes("import(")) {
      if (n.getStart(sf) > floor!.getStart(sf)) scopeImport = n.getStart(sf);
    } });
    expect(call.getStart(sf)).toBeGreaterThan(floor!.getEnd());
    expect(scopeImport).toBeGreaterThan(call.getStart(sf));
    // The result is bound to a local whose truthiness sets verdict UNFAVORABLE.
    const decl = call.parent;
    const local = ts.isBinaryExpression(decl) && ts.isIdentifier(decl.left) ? decl.left.text : ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : "";
    expect(local).not.toBe("");
    let guarded = false;
    walk(inner, (n) => { if (ts.isIfStatement(n) && n.getStart(sf) > call.getStart(sf) && mentions(n.expression, local) && assignsUnfavorable(n.thenStatement)) guarded = true; });
    expect(guarded).toBe(true);
  });
});

describe("omittedExactEditsRefusal — CONTROLS: ambiguous or legitimately shorter plans pass", () => {
  it("single-edit spec with its one op: null", () => {
    expect(seam()(exactSpec([E1]), [op(E1)], reader(E1.new + "\n"))).toBeNull();
  });
  it("full plan (3 edits, 3 ops): null whatever the file reads", () => {
    expect(seam()(exactSpec([E1, E2, E3]), [op(E1), op(E2), op(E3)], reader(null))).toBeNull();
  });
  it("two adjacent edits merged into ONE op whose old_string spans both olds: null", () => {
    const merged: Op = { kind: "edit", path: PATH, old_string: `${E1.old}\n${E2.old}`, new_string: `${E1.new}\n${E2.new}` };
    expect(seam()(exactSpec([E1, E2]), [merged], reader(null))).toBeNull();
  });
  it("adjacent edits collapsed into one replace_lines op carrying both new texts: null", () => {
    const rl: Op = { kind: "replace_lines", path: PATH, new_string: `${E2.new}\n${E3.new}` };
    expect(seam()(exactSpec([E1, E2, E3]), [op(E1), rl], reader(null))).toBeNull();
  });
  it("retry after a partial landing: EDIT 1 is already in the file, the plan carries the other 2: null", () => {
    const after = [E1.new, E2.new, E3.new].join("\n") + "\n";
    expect(seam()(exactSpec([E1, E2, E3]), [op(E2), op(E3)], reader(after))).toBeNull();
  });
  it("whitespace-only differences between the spec's text and the op's are still coverage: null", () => {
    const reindented: Op = { kind: "edit", path: PATH, old_string: `  ${E1.old}\n  ${E2.old}  `, new_string: `  ${E1.new}\n  ${E2.new}` };
    expect(seam()(exactSpec([E1, E2]), [reindented], reader(null))).toBeNull();
  });
  it("a numbered/bulleted prose list with no EDIT blocks: null (not deterministically enumerated)", () => {
    const prose = `In ${PATH}, make these three changes:\n1. raise alpha to 10\n2. raise beta to 20\n- raise gamma to 30\nDone when: the file typechecks.`;
    expect(seam()(prose, [op(E1)], reader(base))).toBeNull();
  });
  it("prose with no list at all: null", () => {
    expect(seam()(`In ${PATH}, raise every constant tenfold so the sample reads in tens.`, [op(E1)], reader(base))).toBeNull();
  });
  it("the looser 'EDIT 1 — old:' / 'Exactly these four' dialect is not parsed: null", () => {
    const dialect = `In ${PATH}, tidy the sample. Exactly these three old->new edits, nothing else.\nEDIT 1 — old:\n${E1.old}\nnew:\n${E1.new}\nEDIT 2 — old:\n${E2.old}\nnew:\n${E2.new}\nEDIT 3 — old:\n${E3.old}\nnew:\n${E3.new}`;
    expect(seam()(dialect, [op(E1)], reader(base))).toBeNull();
  });
  it("a spec naming two repo paths is not the strict form: null", () => {
    const two = exactSpec([E1, E2]).replace("tidy the sample.", "tidy the sample (see also repos/development-vessel/src/other.ts).");
    expect(seam()(two, [op(E1)], reader(base))).toBeNull();
  });
  it("a non-string spec: null", () => {
    expect(seam()(undefined, [], reader(null))).toBeNull();
  });
});

// SOLE-COVER CASES (qa mutation review). Each fixture is covered by exactly ONE branch of the seam,
// so removing that branch must turn the null into a refusal; each is paired with the same fixture
// minus that one cover, which must refuse, so the fixture is proven to parse and to reach the branch.
describe("omittedExactEditsRefusal — each coverage branch is the SOLE cover of one fixture", () => {
  it("old_string only: one op spans both olds (whitespace drifted), carries neither new, the file still holds both olds: null", () => {
    const merged: Op = { kind: "edit", path: PATH, old_string: `   ${E1.old}\n\n  ${E2.old}  `, new_string: "// rewritten by hand" };
    const after = `${E1.old}\n${E2.old}\n`;
    expect(seam()(exactSpec([E1, E2]), [merged], reader(after))).toBeNull();
    // Paired: the same op spanning only E1 leaves E2 uncovered.
    expect(seam()(exactSpec([E1, E2]), [{ ...merged, old_string: E1.old }], reader(after))).toMatch(/omits EDIT 2\b/);
  });
  it("post-apply new present only: a prior attempt landed an insertion (its old stays in the file), no op covers it: null", () => {
    const INS = { old: "const alpha = 1;", new: "const alpha = 1;\nconst delta = 4;" };
    const after = `${INS.new}\n${E2.new}\n${E3.new}\n`;
    expect(seam()(exactSpec([INS, E2, E3]), [op(E2), op(E3)], reader(after))).toBeNull();
    // Paired: the insertion not in the file (old still there, new absent) is an omission.
    expect(seam()(exactSpec([INS, E2, E3]), [op(E2), op(E3)], reader(`${INS.old}\n${E2.new}\n${E3.new}\n`))).toMatch(/omits EDIT 1\b/);
  });
  it("post-apply old absent only: a prior attempt landed a deletion (new is empty), no op covers it: null", () => {
    const DEL = { old: "const omega = 9;", new: "" };
    const after = `${E2.new}\n${E3.new}\n`;
    expect(seam()(exactSpec([DEL, E2, E3]), [op(E2), op(E3)], reader(after))).toBeNull();
    // Paired: the deletion's old text still in the file is an omission.
    expect(seam()(exactSpec([DEL, E2, E3]), [op(E2), op(E3)], reader(`${DEL.old}\n${after}`))).toMatch(/omits EDIT 1\b/);
  });
  it("count rule only: as many ops as edits, one of them unrelated, EDIT 2 uncovered: null (the floor judges only SHORTER plans)", () => {
    const unrelated: Op = { kind: "edit", path: PATH, old_string: "// header", new_string: "// header, tidied" };
    expect(seam()(exactSpec([E1, E2]), [op(E1), unrelated], reader(null))).toBeNull();
    // Paired: without the unrelated op the plan is shorter and EDIT 2 is uncovered.
    expect(seam()(exactSpec([E1, E2]), [op(E1)], reader(null))).toMatch(/omits EDIT 2\b/);
  });
});

// EXACT WIRING. No seam drives the real compose path with a stubbed planner: the floor runs inside
// resolveFeatureComposeInner (not exported) only after a discovered LLM plan, a real apply and a real
// verify, so the guard and the lesson argument are pinned on the syntax tree.
describe("omitted-edits floor wiring — exact", () => {
  function omissionGuard(): ts.IfStatement | undefined {
    let found: ts.IfStatement | undefined;
    walk(inner, (n) => { if (!found && ts.isIfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === "omissionReason") found = n; });
    return found;
  }
  it("the guard is the bare `if (omissionReason)` and its FIRST statement flips verdict to UNFAVORABLE", () => {
    const g = omissionGuard();
    expect(g).toBeDefined();
    expect(g!.getText(sf)).toMatch(/^if \(omissionReason\) \{\s*verdict = "UNFAVORABLE";/);
    const then = g!.thenStatement;
    expect(ts.isBlock(then)).toBe(true);
    const first = (then as ts.Block).statements[0];
    expect(first && ts.isExpressionStatement(first) && assignsUnfavorable(first)).toBe(true);
    // It sits inside the FAVORABLE-guarded block that assigns omissionReason from the seam.
    const outer = g!.parent?.parent;
    expect(outer && ts.isIfStatement(outer) && outer.expression.getText(sf) === 'verdict === "FAVORABLE"').toBe(true);
  });
  it("the lesson class reads omissionReason: composeLessonClass's reason argument names it, and that reason classifies partial_spec_omission", () => {
    const calls: ts.CallExpression[] = [];
    walk(inner, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "composeLessonClass") calls.push(n); });
    expect(calls.length).toBe(1);
    const reasonArg = calls[0]!.arguments[4];
    expect(reasonArg).toBeDefined();
    expect(mentions(reasonArg!, "omissionReason")).toBe(true);
    expect(reasonArg!.getText(sf)).toContain("semantic_gate?.reason ?? omissionReason");
    // The real classifier on the real seam's reason for an omission withhold.
    const reason = seam()(exactSpec([E1, E2, E3]), [op(E1), op(E3)], reader(`${E1.new}\n${E2.old}\n${E3.new}\n`));
    expect(fc.composeLessonClass(null, null, [{ ok: true }, { ok: true }], [{ ok: true, output: "" }], String(null ?? reason ?? ""))).toBe("partial_spec_omission");
  });
});
