// CHECK-FIRST: the AUTONOMY SCOPE FLOOR sees every path a compose will land, repair edits included.
//
// The floor (contained-self-development 1.3, src/resolvers/feature-compose.ts) judged only the
// applied ops: `autonomyScopeFloor(scope, applied.filter(ok).map(path), gap)`. The fc-repair rounds
// write files too (replace_lines and old_string fixes), and record them in `edited` only. The
// cutover stages `[...created, ...edited]` and lands it with no further scope check, and
// write-containment lets excluded writes through because it relies on this floor. So an undirected
// compose whose REPAIR round edited an excluded file (a tsc error in an excluded importer such as
// feature-compose.ts, which the lint-repair prompt invites it to edit) passed the floor and landed.
//
// THE SEAM (exported from feature-compose.ts; absent at base):
//   autonomyFloorPaths(applied, edited, created, ws?, repoRoot?) -> { paths, unmapped }
//     paths: applied ok paths as they are, plus every edited/created ABSOLUTE path mapped to
//     `repos/<vessel>/<rel>` (ws.rel for a compose worktree, else under repoRoot), normalised, de-duplicated.
//     unmapped: every absolute path it could not place inside one vessel, with a reason.
//   Wiring: resolveFeatureComposeInner calls it with (applied, edited, created, ws) inside the
//   undirected floor block, withholds FAVORABLE on any unmapped path (fail closed), and passes
//   `.paths` to autonomyScopeFloor.
//
// MUST-FAIL (red at base): the seam cases and the wiring pin.
// CONTROLS: the directed exemption pin and the applied-only floor behaviour are green at base; the
// seam controls are red at base BY CONSTRUCTION (TypeError: not a function), never by an assertion.
//
// Note on mapping: autonomyScopeExcludes suffix-matches, so a raw absolute path to an excluded file
// already matches its entry. The mapping is what makes a `..` path (the repair path is model-supplied
// and never normalised) and a path outside every vessel judgeable; those cases pin it.
//
// Pure: no LLM, no network, no fs writes.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as fc from "../../src/resolvers/feature-compose.js";
import { autonomyScopeFloor } from "../../src/resolvers/gap-to-feature.js";

type Applied = { ok: boolean; path: string };
type Ws = { rel(abs: string): string | undefined };
type Result = { paths: string[]; unmapped: Array<{ path: string; reason: string }> };
type Seam = (applied: ReadonlyArray<Applied>, edited: ReadonlyArray<string>, created: ReadonlyArray<string>, ws?: Ws, repoRoot?: string) => Result;
const seam = (): Seam => (fc as unknown as { autonomyFloorPaths: Seam }).autonomyFloorPaths;

const FC = "repos/development-vessel/src/resolvers/feature-compose.ts";
const G2F = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const IMPULSES = "repos/development-vessel/src/routes/impulses.ts";
const scope = { excluded: [FC, G2F, IMPULSES, "repos/discovery-vessel/"], readable: true, reason: "test scope" } as Parameters<typeof autonomyScopeFloor>[0];

const WS_ROOT = "/workspace/git/compose/fc-x/development-vessel";
const isolatedWs: Ws = { rel: (abs) => (abs.startsWith(`${WS_ROOT}/`) ? `development-vessel/${abs.slice(WS_ROOT.length + 1)}` : undefined) };
const noWs: Ws = { rel: () => undefined };
const IN_SCOPE_APPLIED: Applied = { ok: true, path: "repos/development-vessel/src/resolvers/sample.ts" };

describe("autonomyFloorPaths — MUST-FAIL: an excluded repair edit reaches the floor", () => {
  it("isolated compose: an edited compose-worktree path to feature-compose.ts is mapped and withheld", () => {
    const r = seam()([IN_SCOPE_APPLIED], [`${WS_ROOT}/src/resolvers/feature-compose.ts`], [], isolatedWs, "/vessels");
    expect(r.unmapped).toEqual([]);
    expect(r.paths).toContain(FC);
    expect(r.paths.every((p) => p.startsWith("repos/"))).toBe(true);
    expect(autonomyScopeFloor(scope, r.paths).hits).toEqual([FC]);
  });
  it("non-isolated compose: an edited /vessels path to gap-to-feature.ts is mapped and withheld", () => {
    const r = seam()([IN_SCOPE_APPLIED], ["/vessels/development-vessel/src/resolvers/gap-to-feature.ts"], [], noWs, "/vessels");
    expect(r.unmapped).toEqual([]);
    expect(r.paths).toContain(G2F);
    expect(autonomyScopeFloor(scope, r.paths).hits).toEqual([G2F]);
  });
  it("a `..` repair path is normalised before the floor, so it cannot step around an excluded entry", () => {
    const raw = `${WS_ROOT}/src/lib/../resolvers/feature-compose.ts`;
    const r = seam()([IN_SCOPE_APPLIED], [raw], [], isolatedWs, "/vessels");
    expect(r.unmapped).toEqual([]);
    expect(r.paths).toContain(FC);
    expect(autonomyScopeFloor(scope, r.paths).hits).toEqual([FC]);
  });
  it("a created path is covered the same way (an excluded created file under a vessel root)", () => {
    const r = seam()([IN_SCOPE_APPLIED], [], ["/vessels/discovery-vessel/src/new.ts"], noWs, "/vessels");
    expect(autonomyScopeFloor(scope, r.paths).hits).toEqual(["repos/discovery-vessel/"]);
  });
  it("an edited path that maps to no vessel fails closed with a named reason", () => {
    for (const bad of ["/tmp/elsewhere/feature-compose.ts", "/vessels//abs/x.ts", "/vessels/top-level.ts", `${WS_ROOT}/../../../../etc/x.ts`, "/vessels/development-vessel/../../etc/x.ts"]) {
      const r = seam()([IN_SCOPE_APPLIED], [bad], [], isolatedWs, "/vessels");
      expect(r.unmapped.map((u) => u.path)).toEqual([bad]);
      expect(r.unmapped[0]!.reason.length).toBeGreaterThan(0);
      expect(r.paths).not.toContain(bad);
    }
  });
  it("wiring: inside the undirected block the floor's input IS the seam's paths, and an unmapped path withholds FAVORABLE", () => {
    const calls: ts.CallExpression[] = [];
    walk(inner, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "autonomyFloorPaths") calls.push(n); });
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.arguments.map((a) => a.getText(sf))).toEqual(["applied", "edited", "created", "ws"]);
    const decl = call.parent;
    const local = ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : "";
    expect(local).not.toBe("");
    const floorCalls = floorCallsIn(inner);
    expect(floorCalls.length).toBe(1);
    expect(floorCalls[0]!.arguments[1]?.getText(sf)).toBe(`${local}.paths`);
    // Both sit inside the one undirected guard.
    const guard = directedGuard();
    expect(guard).toBeDefined();
    expect(call.getStart(sf)).toBeGreaterThan(guard!.thenStatement.getStart(sf));
    expect(call.getEnd()).toBeLessThan(guard!.thenStatement.getEnd());
    expect(call.getStart(sf)).toBeLessThan(floorCalls[0]!.getStart(sf));
    // An unmapped path sets verdict UNFAVORABLE before (and instead of) trusting the floor.
    let guarded = false;
    walk(guard!.thenStatement, (n) => {
      if (ts.isIfStatement(n) && n.expression.getText(sf).includes(`${local}.unmapped`) && assignsUnfavorable(n.thenStatement)) guarded = true;
    });
    expect(guarded).toBe(true);
  });
});

describe("autonomy floor — MUST-FAIL: an unmapped path WITHHOLDS at the floor, not only in the helper", () => {
  // The helper cases above prove unmappable forms come back as `unmapped`; this pins that the floor then
  // acts on them. No seam drives the floor decision (it is inline in resolveFeatureComposeInner), so the
  // decision is pinned structurally: a mutant `if (floorInput.unmapped.length > 0 && false)` must fail.
  it("the unmapped `if` is exactly `<local>.unmapped.length > 0`, sets verdict UNFAVORABLE and scopeWithheld true, and precedes the scopeHits branch", () => {
    const calls: ts.CallExpression[] = [];
    walk(inner, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "autonomyFloorPaths") calls.push(n); });
    expect(calls.length).toBe(1);
    const decl = calls[0]!.parent;
    const local = ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : "";
    expect(local).not.toBe("");
    const guard = directedGuard();
    expect(guard).toBeDefined();
    // Every `if` in the guard whose condition reads `<local>.unmapped`: exactly one, and its condition is the bare comparison.
    const unmappedIfs: ts.IfStatement[] = [];
    walk(guard!.thenStatement, (n) => { if (ts.isIfStatement(n) && n.expression.getText(sf).includes(`${local}.unmapped`)) unmappedIfs.push(n); });
    expect(unmappedIfs.length).toBe(1);
    const u = unmappedIfs[0]!;
    expect(u.expression.getText(sf)).toBe(`${local}.unmapped.length > 0`);
    // Both assignments are direct statements of its block (not nested under a further condition).
    expect(ts.isBlock(u.thenStatement)).toBe(true);
    const direct = (u.thenStatement as ts.Block).statements.map((s) => s.getText(sf));
    expect(direct).toContain('verdict = "UNFAVORABLE";');
    expect(direct).toContain("scopeWithheld = true;");
    // It decides first: the scopeHits branch is its else, and no scopeHits `if` precedes it.
    expect(u.elseStatement && ts.isIfStatement(u.elseStatement)).toBe(true);
    expect((u.elseStatement as ts.IfStatement).expression.getText(sf)).toBe("scopeHits.length > 0");
    let firstHitsIf = Number.POSITIVE_INFINITY;
    walk(guard!.thenStatement, (n) => { if (ts.isIfStatement(n) && n.expression.getText(sf).includes("scopeHits")) firstHitsIf = Math.min(firstHitsIf, n.getStart(sf)); });
    expect(u.getStart(sf)).toBeLessThan(firstHitsIf);
  });
});

describe("autonomyFloorPaths — CONTROLS", () => {
  it("an in-scope repair edit passes", () => {
    const r = seam()([IN_SCOPE_APPLIED], [`${WS_ROOT}/src/resolvers/sample-helper.ts`], [`${WS_ROOT}/src/resolvers/sample-new.ts`], isolatedWs, "/vessels");
    expect(r.unmapped).toEqual([]);
    expect(autonomyScopeFloor(scope, r.paths)).toEqual({ hits: [], unreadable: null });
  });
  it("applied paths pass through unchanged and de-duplicated; failed ops are not judged", () => {
    const r = seam()([IN_SCOPE_APPLIED, { ok: true, path: FC }, { ok: false, path: IMPULSES }], [`${WS_ROOT}/src/resolvers/feature-compose.ts`], [], isolatedWs, "/vessels");
    expect(r.paths).toEqual([IN_SCOPE_APPLIED.path, FC]);
    expect(autonomyScopeFloor(scope, r.paths).hits).toEqual([FC]);
  });
  it("applied-only behaviour is unchanged: an applied hit is still a hit (green at base)", () => {
    expect(autonomyScopeFloor(scope, [IN_SCOPE_APPLIED.path, IMPULSES]).hits).toEqual([IMPULSES]);
    expect(autonomyScopeFloor(scope, [IN_SCOPE_APPLIED.path]).hits).toEqual([]);
  });
  it("the directed exemption is unchanged: the floor runs only under `directed !== true` (green at base)", () => {
    const guard = directedGuard();
    expect(guard).toBeDefined();
    expect(guard!.expression.getText(sf)).toBe('verdict === "FAVORABLE" && (pointer as { directed?: boolean }).directed !== true');
    // The floor call lives in that guard and nowhere else.
    const all = floorCallsIn(inner);
    expect(all.length).toBe(1);
    expect(floorCallsIn(guard!.thenStatement).length).toBe(1);
  });
});

// ── AST helpers ──
const SRC = "src/resolvers/feature-compose.ts";
const sf = ts.createSourceFile(SRC, readFileSync(SRC, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(node: ts.Node, visit: (n: ts.Node) => void): void { visit(node); node.forEachChild((c) => walk(c, visit)); }
function fnNamed(name: string): ts.Node {
  let found: ts.Node | undefined;
  walk(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; });
  if (!found) throw new Error(`${name} not found in ${SRC}`);
  return found;
}
const inner = fnNamed("resolveFeatureComposeInner");
function floorCallsIn(root: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(root, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "autonomyScopeFloor") out.push(n); });
  return out;
}
function directedGuard(): ts.IfStatement | undefined {
  let found: ts.IfStatement | undefined;
  walk(inner, (n) => {
    if (!found && ts.isIfStatement(n) && n.expression.getText(sf).includes("directed !== true") && floorCallsIn(n.thenStatement).length > 0) found = n;
  });
  return found;
}
const assignsUnfavorable = (root: ts.Node): boolean => {
  let hit = false;
  walk(root, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === "verdict"
      && ts.isStringLiteral(n.right) && n.right.text === "UNFAVORABLE") hit = true;
  });
  return hit;
};
