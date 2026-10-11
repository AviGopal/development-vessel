// CHECK-FIRST: a green armed class-2 own check outranks a non-hard-fail "addresses:false".
//
// GAP semantic-gate-refuters-overturn-a-green-class2-draft-by-misreading-the-requirement.
// Measured on node 1, 2026-10-03 07:03Z: the ONLY draft in a 2 h window that turned its gap's
// ARMED class-2 own check red->green (traces-carry-no-code-version step 1: own check ran:true,
// red:[], tc_ok:true) was overturned by the LLM semantic gate (addresses:false,
// on_live_path:false, hard_fail:false). At base the gate site in resolveFeatureComposeInner
// (src/resolvers/feature-compose.ts) flips the verdict on ANY addresses:false / on_live_path:false.
//
// RULING (qa, binding):
//   - A non-hard-fail addresses:false on a draft that turned its gap's ARMED class-2 check
//     red->green is ADVISORY: not a veto, not a hold.
//   - The gate keeps its VETO only when it cites a concrete, checkable defect:
//       (1) hard_fail;
//       (2) self-certification: the diff touches only tests, fixtures or the gap's own check file;
//       (3) hollow_write: the diff introduces an identifier (a defined symbol or an assigned
//           field) that has no READ site in src;
//       (4) edit_site_missed: the diff misses the gap's edit_site entirely.
//   - Otherwise the draft LANDS stamped semantic_dissent {reason, gate_verdict, at}, and the
//     post-land by-effect check is MANDATORY: it lands landed_unverified until that passes.
//   - Each dissent is recorded with later_outcome (null until the landing's by-effect check
//     resolves), so the gate can be calibrated.
//
// THE SEAMS THESE TESTS PIN (all exported from src/resolvers/feature-compose.ts; absent at base):
//   semanticGateDisposition(input) — pure:
//     input  { gate: SemanticGateVerdict,
//              own_check: { test_file, ran, tc_ok, base_red: string[] | null, draft_red: string[],
//                           contract_breach: string | null } | null   (null = the gap has no armed check),
//              diff: string            (the "### <path>" form verifyPatchAddressesGap judges),
//              edit_site: string | null (the gap's classification_metadata.edit_site, "path[:line]"),
//              src_files: Record<string, string>  (vessel-relative path -> post-patch text) }
//     output { land: boolean,
//              veto: null | "hard_fail" | "self_certification" | "hollow_write" | "edit_site_missed" | "semantic_reject",
//              semantic_dissent?: { reason, gate_verdict, at, later_outcome: null },
//              landed_unverified: boolean, post_land_by_effect_check: "required" | "not_required" }
//     A READ site is a src line (test files excluded) containing the identifier that is not its own
//     definition or assignment. edit_site absent = not checkable = not a veto.
//   recordSemanticDissent(gapId, dissent, { readGap, writeGap }) — the writer.
//     WHERE CALIBRATION READS IT: the gap row's classification_metadata.semantic_dissent (an array,
//     appended). It must NOT write semantic_gate_reason: priorAttemptFeedbackBlock reads that as
//     "your last draft was rejected".
//   settleSemanticDissent(gapId, dissent, cutoverResult, { readGap, writeGap }) — NO PHANTOM DISSENT.
//     Records (through recordSemanticDissent) ONLY when the cutover result says
//     push_status === "pushed" with a non-empty new_git_sha; a refused, deferred or unpushed cutover
//     writes nothing. Both landing sites call it AFTER their resolveVesselMitosisCutover call, and
//     nothing else in feature-compose.ts calls recordSemanticDissent.
//   resolveDissentOutcome(gapId, { result: "passed" | "failed", at }, { readGap, writeGap }) — THE READER.
//     Sets later_outcome = { result, at } on every entry of classification_metadata.semantic_dissent
//     whose later_outcome is still null; resolved entries are untouched; nothing pending = no write.
//     THE SWEEP MUST CALL IT: sweepPendingLandVerificationsOnce (src/resolvers/gap-to-feature.ts)
//     calls it with result "passed" where it closes a landing landed_verified, and with "failed"
//     where it finds the landing reverted or measured present. That half is an operator gap
//     (gap-to-feature is outside the autonomy scope); its pin is the "THE READER IS CALLED" test.
//   Wiring, pinned on the SYNTAX TREE (comments, renames and reflows do not matter):
//     - resolveFeatureComposeInner calls semanticGateDisposition after verifyPatchAddressesGap;
//     - every resolveVesselMitosisCutover call in feature-compose.ts (the compose landing in
//       resolveFeatureComposeInner and the parked-landing resume in resumeParkedLanding) passes a
//       pointer with a semantic_dissent property;
//     - runGitAwareCutoverInner (src/resolvers/vessel-mitosis-cutover.ts) assigns
//       landedUnverifiedReason from a semantic_dissent property read (directly, or through a local
//       bound from it, in the assignment or in the condition guarding it).
//
// CONTROLS (green at base) exercise only real base code: the real gate (verifyPatchAddressesGap, judge
// stubbed) produces the verdicts the CONTRACT tests feed the seam. CONTRACT tests need the seam and are
// red at base by construction: they keep the four veto classes, the no-red->green case and the
// passing case from regressing once the seam exists.
//
// No LLM, no network (fetch guard), no host process (exec guard), no fs writes (gap I/O injected).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as fc from "../../src/resolvers/feature-compose.js";
import { verifyPatchAddressesGap, type ReachabilityFact, type SemanticGateVerdict } from "../../src/resolvers/feature-compose.js";
import { installCutoverFetchGuard, restoreCutoverFetch, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

type OwnCheck = { test_file: string; ran: boolean; tc_ok: boolean; base_red: string[] | null; draft_red: string[]; contract_breach: string | null };
type DispositionInput = { gate: SemanticGateVerdict; own_check: OwnCheck | null; diff: string; edit_site: string | null; src_files: Record<string, string> };
type Dissent = { reason: string; gate_verdict: Record<string, unknown>; at: string; later_outcome: unknown };
type Disposition = { land: boolean; veto: string | null; semantic_dissent?: Dissent; landed_unverified: boolean; post_land_by_effect_check: string };
type GapDeps = { readGap: (id: string) => Promise<Record<string, unknown> | null>; writeGap: (row: Record<string, unknown>) => Promise<void> };

function exported<T>(name: string): T {
  const f = (fc as unknown as Record<string, unknown>)[name];
  expect(typeof f, `src/resolvers/feature-compose.ts must export ${name}`).toBe("function");
  return f as T;
}
const disposition = (i: DispositionInput): Disposition => exported<(i: DispositionInput) => Disposition>("semanticGateDisposition")(i);

// ── STRUCTURAL PINS READ THE SYNTAX TREE, NOT THE TEXT ──────────────────────────────────────────
const FC_PATH = new URL("../../src/resolvers/feature-compose.ts", import.meta.url).pathname;
const CUTOVER_PATH = new URL("../../src/resolvers/vessel-mitosis-cutover.ts", import.meta.url).pathname;
const GTF_PATH = new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url).pathname;
const _sf = new Map<string, ts.SourceFile>();
function sourceOf(path: string): ts.SourceFile {
  let sf = _sf.get(path);
  if (!sf) { sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); _sf.set(path, sf); }
  return sf;
}
function walk(node: ts.Node, visit: (n: ts.Node) => void): void { visit(node); node.forEachChild((c) => walk(c, visit)); }
/** The function named `name`: a function declaration, or a const bound to an arrow/function expression. */
function fnNamed(path: string, name: string): ts.Node {
  let found: ts.Node | undefined;
  walk(sourceOf(path), (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = n.initializer;
  });
  expect(found !== undefined, `function '${name}' must exist in ${path.split("/").slice(-2).join("/")}`).toBe(true);
  return found!;
}
const calleeName = (c: ts.CallExpression): string => {
  const e = c.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
};
function callsTo(root: ts.Node, callee: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(root, (n) => { if (ts.isCallExpression(n) && calleeName(n) === callee) out.push(n); });
  return out;
}
/** Every call to `callee` in the file, with the name of its nearest enclosing named function. */
function callSitesInFile(path: string, callee: string): Array<{ fn: string; call: ts.CallExpression }> {
  const out: Array<{ fn: string; call: ts.CallExpression }> = [];
  const visit = (n: ts.Node, fn: string): void => {
    let cur = fn;
    if (ts.isFunctionDeclaration(n) && n.name) cur = n.name.text;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) cur = n.name.text;
    if (ts.isCallExpression(n) && calleeName(n) === callee) out.push({ fn: cur, call: n });
    n.forEachChild((c) => visit(c, cur));
  };
  visit(sourceOf(path), "<module>");
  return out;
}
const propName = (n: ts.PropertyName | ts.BindingName | undefined): string =>
  !n ? "" : ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : "";
/** Does `root` contain an object-literal property (assignment or shorthand) named `name`? */
function hasObjectProperty(root: ts.Node, name: string): boolean {
  let hit = false;
  walk(root, (n) => { if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && propName(n.name) === name) hit = true; });
  return hit;
}
/** Does `root` READ a property named `name` (x.name, x["name"], or a destructured binding)? */
function readsProperty(root: ts.Node, name: string): boolean {
  let hit = false;
  walk(root, (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === name) hit = true;
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === name) hit = true;
    else if (ts.isBindingElement(n) && (propName(n.propertyName) || propName(n.name)) === name) hit = true;
  });
  return hit;
}
/** Locals in `fn` whose initializer reads property `name` (or that destructure it). */
function localsBoundFrom(fn: ts.Node, name: string): Set<string> {
  const out = new Set<string>();
  walk(fn, (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && readsProperty(n.initializer, name)) out.add(n.name.text);
    if (ts.isBindingElement(n) && (propName(n.propertyName) || propName(n.name)) === name && ts.isIdentifier(n.name)) out.add(n.name.text);
  });
  return out;
}
function mentionsIdentifier(root: ts.Node, names: Set<string>): boolean {
  let hit = false;
  walk(root, (n) => { if (ts.isIdentifier(n) && names.has(n.text)) hit = true; });
  return hit;
}
/** Is `target` assigned (target = …) in `fn` from a read of property `prop`: in the RHS, or in a guarding if-condition? */
function assignedFromPropertyRead(fn: ts.Node, target: string, prop: string): boolean {
  const locals = localsBoundFrom(fn, prop);
  const fromProp = (e: ts.Node): boolean => readsProperty(e, prop) || mentionsIdentifier(e, locals);
  let hit = false;
  walk(fn, (n) => {
    if (!(ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === target)) return;
    if (fromProp(n.right)) { hit = true; return; }
    for (let p: ts.Node | undefined = n.parent; p && p !== fn; p = p.parent) {
      if ((ts.isIfStatement(p) || ts.isConditionalExpression(p)) && fromProp(ts.isIfStatement(p) ? p.expression : p.condition)) { hit = true; return; }
    }
  });
  return hit;
}
/** The string-literal value of property `key` in a call's object-literal argument at `index`, or null. */
function literalArgProperty(call: ts.CallExpression, index: number, key: string): string | null {
  let a: ts.Expression | undefined = call.arguments[index];
  while (a && (ts.isAsExpression(a) || ts.isParenthesizedExpression(a) || ts.isSatisfiesExpression(a))) a = a.expression;
  if (!a || !ts.isObjectLiteralExpression(a)) return null;
  for (const p of a.properties) if (ts.isPropertyAssignment(p) && propName(p.name) === key && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
  return null;
}

// ---- fixtures: the traces-carry-no-code-version step-1 shape --------------------------------
const V = "development-vessel";
const EDIT_FILE = "src/resolvers/execution-trace-emit.ts";
const EDIT_SITE = `repos/${V}/${EDIT_FILE}:42`;
const OWN_TEST = "test/resolvers/traces-carry-code-version.test.ts";
const GAP_SUMMARY = "traces carry no code version: an emitted execution trace must carry the code_version of the tree that ran it";

const EMIT_POST = [
  'import { currentCodeVersion } from "./code-version.js";',
  "export function emitTrace(id: string) {",
  "  const trace = {",
  "    id,",
  "    code_version: currentCodeVersion(),",
  "  };",
  "  return postTrace(trace);",
  "}",
].join("\n");
const CODE_VERSION_SRC = "export function currentCodeVersion(): string { return process.env.GIT_SHA ?? \"unknown\"; }\n";
const SRC_FILES: Record<string, string> = {
  [EDIT_FILE]: EMIT_POST,
  "src/resolvers/code-version.ts": CODE_VERSION_SRC,
  "src/resolvers/trace-post.ts": "export async function postTrace(t: { id: string; code_version: string | null }) { return t.code_version; }\n",
};

// The measured draft: an existing line of the edit_site file changes; no new identifier.
const GREEN_DRAFT_DIFF = [
  `### /vessels/${V}/${EDIT_FILE}`,
  `--- a/${V}/${EDIT_FILE}`,
  `+++ b/${V}/${EDIT_FILE}`,
  "@@ -3,5 +3,5 @@ export function emitTrace(id: string) {",
  "   const trace = {",
  "     id,",
  "-    code_version: null,",
  "+    code_version: currentCodeVersion(),",
  "   };",
].join("\n");

// Self-certification: the only file touched is the gap's own check.
const SELF_CERT_DIFF = [
  `### /vessels/${V}/${OWN_TEST}`,
  `--- a/${V}/${OWN_TEST}`,
  `+++ b/${V}/${OWN_TEST}`,
  "@@ -10,3 +10,3 @@",
  "-    expect(trace.code_version).toMatch(/^[0-9a-f]{7,40}$/);",
  "+    expect(trace.code_version ?? \"unknown\").toBeDefined();",
].join("\n");

// Hollow write: a field assigned on the edit_site file that nothing in src reads.
const HOLLOW_DIFF = [
  `### /vessels/${V}/${EDIT_FILE}`,
  `--- a/${V}/${EDIT_FILE}`,
  `+++ b/${V}/${EDIT_FILE}`,
  "@@ -6,2 +6,3 @@",
  "   };",
  "+  (trace as Record<string, unknown>).code_version_stamp = currentCodeVersion();",
  "   return postTrace(trace);",
].join("\n");
const HOLLOW_SRC_FILES: Record<string, string> = {
  ...SRC_FILES,
  [EDIT_FILE]: EMIT_POST.replace("  return postTrace(trace);", "  (trace as Record<string, unknown>).code_version_stamp = currentCodeVersion();\n  return postTrace(trace);"),
};

// Edit-site miss: a real change, in a file the gap does not name.
const OTHER_FILE = "src/resolvers/relevance-score.ts";
const MISS_DIFF = [
  `### /vessels/${V}/${OTHER_FILE}`,
  `--- a/${V}/${OTHER_FILE}`,
  `+++ b/${V}/${OTHER_FILE}`,
  "@@ -20,2 +20,2 @@ export function scoreRelevance(x: number) {",
  "-  return x * 0.5;",
  "+  return x * currentCodeVersion().length;",
].join("\n");
const MISS_SRC_FILES: Record<string, string> = {
  ...SRC_FILES,
  [OTHER_FILE]: 'import { currentCodeVersion } from "./code-version.js";\nexport function scoreRelevance(x: number) {\n  return x * currentCodeVersion().length;\n}\n',
};

// A new function with zero callers: the reachability hard-fail (real base code).
const DEAD_CODE_DIFF = [
  `### NEW FILE /vessels/${V}/src/resolvers/code-version-stamp.ts`,
  "+function stampCodeVersion(t: unknown) {",
  "+  void t;",
  "+}",
].join("\n");

const LIVE_FACTS: ReachabilityFact[] = [{ symbol: "emitTrace", isNewFunction: false, callerCount: 3, isEntrypoint: true, reachable: true }];

/** The red->green armed own check the node-1 draft produced. */
const RED_TO_GREEN: OwnCheck = { test_file: OWN_TEST, ran: true, tc_ok: true, base_red: ["traces carry the code_version of the tree that ran them"], draft_red: [], contract_breach: null };

const MISREAD = "the diff stamps code_version on the trace object, but the requirement is that the TRACE STORE records which code ran; nothing here reaches the store";

/** The REAL gate (base code), its judge stubbed to the measured addresses:false / on_live_path:false. */
async function gateSays(diff: string, facts: ReachabilityFact[] = LIVE_FACTS, judge: Record<string, unknown> = { addresses: false, on_live_path: false, reason: MISREAD }): Promise<SemanticGateVerdict> {
  return verifyPatchAddressesGap({
    gapSummary: GAP_SUMMARY,
    gapMeta: { edit_site: EDIT_SITE },
    diff,
    reachability: facts,
    llm: async () => JSON.stringify(judge),
    runSemanticJudge: true,
  });
}

let guard: FetchGuard;
let exec: ExecGuard;
beforeEach(() => { guard = installCutoverFetchGuard(); exec = installCutoverExecGuard(); });
afterEach(() => {
  const execViolations = exec.restore();
  expect(guard.restore()).toEqual([]);
  expect(execViolations).toEqual([]);
});
afterAll(() => { restoreCutoverFetch(); restoreCutoverExecModules(); });

/**
 * A gap row store in memory: the injected readGap/writeGap the recorder, settler and reader take. Like the real
 * store (substrate-gap.ts), a write carries the row's omitted classification_metadata keys forward; every
 * payload is recorded so a test can assert what a writer SENT (the relocation-hint merge test's pattern).
 */
function memoryGap(row: Record<string, unknown>): { deps: GapDeps; writes: Record<string, unknown>[]; current: () => Record<string, unknown>; others: Map<string, Record<string, unknown>> } {
  let cur = structuredClone(row);
  const writes: Record<string, unknown>[] = [];
  // Rows written under another id (the narrowed child a pushed landing under dissent mints) are kept apart.
  const others = new Map<string, Record<string, unknown>>();
  return {
    deps: {
      readGap: async (id) => (id === cur.id ? structuredClone(cur) : (others.has(id) ? structuredClone(others.get(id)!) : null)),
      writeGap: async (r) => {
        if (r.id !== cur.id) { others.set(String(r.id), structuredClone(r)); return; }
        writes.push(structuredClone(r));
        const sent = structuredClone(r);
        cur = { ...cur, ...sent, classification_metadata: { ...((cur.classification_metadata ?? {}) as Record<string, unknown>), ...((sent.classification_metadata ?? {}) as Record<string, unknown>) } };
      },
    },
    writes,
    current: () => cur,
    others,
  };
}
const dissentsOf = (row: Record<string, unknown>): unknown[] | undefined =>
  ((row.classification_metadata ?? {}) as Record<string, unknown>).semantic_dissent as unknown[] | undefined;

describe("semantic dissent: a green armed class-2 check outranks a non-hard-fail addresses:false", () => {
  // ── CONTROLS: real base code, green at base ─────────────────────────────────────────────────────
  it("CONTROL: the real gate reproduces the measured verdict on the red->green draft (addresses:false, on_live_path:false, not hard_fail)", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    expect(gate).toMatchObject({ addresses: false, on_live_path: false, llm_consulted: true, reason: MISREAD });
    expect(gate.hard_fail === true).toBe(false);
  });

  it("CONTROL: the real gate does NOT hard-fail a diff to the gap's own check file, so only the disposition can refuse self-certification", async () => {
    const gate = await gateSays(SELF_CERT_DIFF, []);
    expect(gate.addresses).toBe(false);
    expect(gate.hard_fail === true).toBe(false);
  });

  it("CONTROL: the real gate does NOT hard-fail a field write nothing reads, so only the hollow-write rule can refuse it", async () => {
    const gate = await gateSays(HOLLOW_DIFF);
    expect(gate.hard_fail === true).toBe(false);
    expect(Object.values(HOLLOW_SRC_FILES).join("\n").split("\n").filter((l) => l.includes("code_version_stamp")).length).toBe(1);
  });

  it("CONTROL: the real gate hard-fails a new function with zero callers", async () => {
    const gate = await gateSays(DEAD_CODE_DIFF, [{ symbol: "stampCodeVersion", isNewFunction: true, callerCount: 0, isEntrypoint: false, reachable: false }]);
    expect(gate).toMatchObject({ addresses: false, hard_fail: true, llm_consulted: false });
  });

  it("CONTROL: the exec guard blocks AND records a deliberate `systemctl restart x` on every spawn API", async () => {
    // PATH points nowhere, so even a broken guard cannot reach the host's systemctl.
    const env = { PATH: "/nonexistent-dissent-guard" };
    expect(() => Bun.spawn(["systemctl", "restart", "x"], { env })).toThrow(/exec guard/);
    expect(() => Bun.spawnSync(["systemctl", "restart", "x"], { env })).toThrow(/exec guard/);
    const cp = await import("node:child_process");
    expect(() => cp.execSync("systemctl restart x", { env })).toThrow(/exec guard/);
    expect(() => cp.execFileSync("systemctl", ["restart", "x"], { env })).toThrow(/exec guard/);
    expect(() => cp.spawnSync("systemctl", ["restart", "x"], { env })).toThrow(/exec guard/);
    expect(() => cp.spawn("sh", ["-c", "true && systemctl restart x"], { env })).toThrow(/exec guard/);
    expect(() => cp.exec("docker restart x", { env })).toThrow(/exec guard/);
    expect(() => cp.execFile("/usr/bin/podman", ["restart", "x"], { env })).toThrow(/exec guard/);
    expect(() => Bun.spawn(["vessel-ctl", "restart", "x"], { env })).toThrow(/exec guard/);
    expect(exec.violations.length).toBe(9);
    expect(exec.violations[0]).toBe("Bun.spawn: systemctl restart x");
    expect(exec.violations[2]).toBe("child_process.execSync: systemctl restart x");
    // A command that only MENTIONS a word is not blocked; a routed one answers without running.
    exec.route({ name: "stub restart", match: (c) => c === "systemctl restart routed.service", respond: () => ({ exitCode: 3, stderr: "stubbed" }) });
    const p = Bun.spawn(["systemctl", "restart", "routed.service"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(3);
    expect(await new Response(p.stderr as ReadableStream).text()).toBe("stubbed");
    expect(exec.hits).toEqual(["stub restart"]);
    exec.violations.length = 0; // the deliberate probes are this control's subject, not violations of the file
  });

  // ── MUST-FAIL: the ruling ───────────────────────────────────────────────────────────────────────
  it("MUST-FAIL: armed class-2 check red->green + gate {addresses:false, hard_fail:false} LANDS stamped semantic_dissent, landed_unverified until the by-effect check passes", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    const d = disposition({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect(d.land).toBe(true);
    expect(d.veto).toBeNull(); // not semantic_reject
    expect(d.semantic_dissent?.reason).toBe(MISREAD);
    expect(d.semantic_dissent?.gate_verdict).toMatchObject({ addresses: false, on_live_path: false });
    expect(d.landed_unverified).toBe(true);
    expect(d.post_land_by_effect_check).toBe("required");
  });

  it("MUST-FAIL (wiring, AST): the gate site calls the disposition, every cutover call carries semantic_dissent, and the cutover sets landedUnverifiedReason from it", () => {
    const gateSite = fnNamed(FC_PATH, "resolveFeatureComposeInner");
    const judged = callsTo(gateSite, "verifyPatchAddressesGap").map((c) => c.getStart());
    const disposed = callsTo(gateSite, "semanticGateDisposition").map((c) => c.getStart());
    const cutoverCalls = callSitesInFile(FC_PATH, "resolveVesselMitosisCutover");
    expect({
      gate_site_judges: judged.length > 0,
      gate_site_calls_disposition_after_the_judge: disposed.length > 0 && judged.length > 0 && disposed.some((d) => d > judged[0]!),
      cutover_call_sites: cutoverCalls.map((c) => c.fn).sort(),
      every_cutover_pointer_carries_semantic_dissent: cutoverCalls.every((c) => c.call.arguments[0] !== undefined && hasObjectProperty(c.call.arguments[0]!, "semantic_dissent")),
      cutover_sets_landed_unverified_from_semantic_dissent: assignedFromPropertyRead(fnNamed(CUTOVER_PATH, "runGitAwareCutoverInner"), "landedUnverifiedReason", "semantic_dissent"),
    }).toEqual({
      gate_site_judges: true,
      gate_site_calls_disposition_after_the_judge: true,
      cutover_call_sites: ["resolveFeatureComposeInner", "resumeParkedLanding"],
      every_cutover_pointer_carries_semantic_dissent: true,
      cutover_sets_landed_unverified_from_semantic_dissent: true,
    });
  });

  it("MUST-FAIL (contract): the dissent record is {reason, gate_verdict, at, later_outcome:null} on the gap row's classification_metadata.semantic_dissent", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    const rec = disposition({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES }).semantic_dissent!;
    expect(Object.keys(rec).sort()).toEqual(["at", "gate_verdict", "later_outcome", "reason"]);
    expect(rec.later_outcome).toBeNull();
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);

    const record = exported<(g: string, d: Dissent, deps: GapDeps) => Promise<void>>("recordSemanticDissent");
    const prior: Dissent = { reason: "an earlier dissent", gate_verdict: { addresses: false }, at: "2026-10-01T00:00:00.000Z", later_outcome: { result: "passed", at: "2026-10-01T02:00:00.000Z" } };
    const store = memoryGap({ id: "traces-carry-no-code-version", status: "open", classification_metadata: { edit_site: EDIT_SITE, semantic_dissent: [prior] } });
    await record("traces-carry-no-code-version", rec, store.deps);
    expect(store.writes.length).toBe(1);
    const meta = (store.current().classification_metadata ?? {}) as Record<string, unknown>;
    expect(meta.edit_site).toBe(EDIT_SITE); // other metadata kept
    expect(meta.semantic_dissent).toEqual([prior, rec]); // appended, not replaced
    // A landed dissent is not a rejection: the next drafter must not be told its fix was refused.
    expect("semantic_gate_reason" in meta).toBe(false);
  });

  it("MUST-FAIL (phantom dissent): a refused, deferred or unpushed cutover leaves NO semantic_dissent entry; only a pushed landing records one", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    const rec = disposition({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES }).semantic_dissent!;
    const settle = exported<(g: string, d: Dissent, cut: Record<string, unknown>, deps: GapDeps) => Promise<unknown>>("settleSemanticDissent");
    const notLanded: Array<[string, Record<string, unknown>]> = [
      ["refused", { refused: true, refuse_class: "stale_base", reason: "base moved" }],
      ["deferred", { kind: "gap_store_unavailable", deferred: true, preserve_pending: true }],
      ["push failed", { push_status: "push_failed", new_git_sha: "" }],
      ["pushed without a sha", { push_status: "pushed", new_git_sha: "  " }],
    ];
    for (const [label, cut] of notLanded) {
      const store = memoryGap({ id: "g1", status: "open", classification_metadata: { edit_site: EDIT_SITE } });
      await settle("g1", rec, cut, store.deps);
      expect({ label, entries: dissentsOf(store.current()) ?? [] }).toEqual({ label, entries: [] });
    }
    const landed = memoryGap({ id: "g1", status: "open", classification_metadata: { edit_site: EDIT_SITE } });
    await settle("g1", rec, { push_status: "pushed", new_git_sha: "4bba1a5302a4ccd1cacf8df837f457629af2546b" }, landed.deps);
    // Stamped at landing (landed partial): the sha, the parent's check (none on this row) and the minted child.
    expect(dissentsOf(landed.current())).toEqual([{ ...rec, landed_sha: "4bba1a5302a4ccd1cacf8df837f457629af2546b", own_check: null, child_gap_id: "g1-dissent-narrowed" }]);
    expect([...landed.others.keys()]).toEqual(["g1-dissent-narrowed"]);

    // And the compose records through the settler only, after the cutover answered.
    const direct = callSitesInFile(FC_PATH, "recordSemanticDissent").map((c) => c.fn);
    const settled = callSitesInFile(FC_PATH, "settleSemanticDissent");
    const afterCutover = settled.every((s) => {
      const cut = callsTo(fnNamed(FC_PATH, s.fn), "resolveVesselMitosisCutover").map((c) => c.getStart());
      return cut.length > 0 && cut.some((p) => p < s.call.getStart());
    });
    expect({ direct_writers: direct, settle_sites: settled.map((s) => s.fn).sort(), every_settle_after_a_cutover: afterCutover }).toEqual({
      direct_writers: ["settleSemanticDissent"],
      settle_sites: ["resolveFeatureComposeInner", "resumeParkedLanding"],
      every_settle_after_a_cutover: true,
    });
  });

  // CHANGED PIN (landed_partial, 2026-10-03): a "passed" from the gap's OWN check no longer settles its dissent —
  // that check is the one the gate doubted (circular). "failed" still fills; "passed" fills only from a distinct
  // check (feature-compose-dissent-partial.test.ts pins that path).
  it("MUST-FAIL (the reader): when the by-effect check resolves, every pending dissent gets later_outcome {result, at}; resolved ones are untouched", async () => {
    const resolveOutcome = exported<(g: string, o: { result: "passed" | "failed"; at: string }, deps: GapDeps) => Promise<unknown>>("resolveDissentOutcome");
    const done = { reason: "old", gate_verdict: { addresses: false }, at: "2026-10-01T00:00:00.000Z", later_outcome: { result: "failed", at: "2026-10-01T05:00:00.000Z" } };
    const pending = { reason: MISREAD, gate_verdict: { addresses: false, on_live_path: false }, at: "2026-10-03T07:03:00.000Z", later_outcome: null };
    {
      const store = memoryGap({ id: "g2", status: "open", classification_metadata: { edit_site: EDIT_SITE, semantic_dissent: [done, pending] } });
      await resolveOutcome("g2", { result: "failed", at: "2026-10-03T09:00:00.000Z" }, store.deps);
      expect(dissentsOf(store.current())).toEqual([done, { ...pending, later_outcome: { result: "failed", at: "2026-10-03T09:00:00.000Z" } }]);
      expect((store.current().classification_metadata as Record<string, unknown>).edit_site).toBe(EDIT_SITE);
    }
    {
      const store = memoryGap({ id: "g2", status: "open", classification_metadata: { edit_site: EDIT_SITE, semantic_dissent: [done, pending] } });
      await resolveOutcome("g2", { result: "passed", at: "2026-10-03T09:00:00.000Z" }, store.deps);
      expect(store.writes.length).toBe(0); // the gap's own check cannot settle its own dissent as passed
    }
    // Nothing pending (or no dissent at all): no write.
    for (const meta of [{ semantic_dissent: [done] }, { edit_site: EDIT_SITE }]) {
      const store = memoryGap({ id: "g3", status: "open", classification_metadata: meta });
      await resolveOutcome("g3", { result: "passed", at: "2026-10-03T09:00:00.000Z" }, store.deps);
      expect(store.writes.length).toBe(0);
    }
  });

  it("MUST-FAIL (stale full-row write): recordSemanticDissent and resolveDissentOutcome send ONLY semantic_dissent in classification_metadata, with the row's identity and status; the row keeps its other keys", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    const rec = disposition({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES }).semantic_dissent!;
    const record = exported<(g: string, d: Dissent, deps: GapDeps) => Promise<void>>("recordSemanticDissent");
    const resolveOutcome = exported<(g: string, o: { result: "passed" | "failed"; at: string }, deps: GapDeps) => Promise<unknown>>("resolveDissentOutcome");
    const row = { id: "g-merge", status: "open", category: "missing_capability", summary: "merge fixture", detected_at: "2026-10-01T00:00:00.000Z", classification_metadata: { edit_site: EDIT_SITE, failure_lessons: [{ class: "verify_failed" }] } };
    const store = memoryGap(row);
    await record("g-merge", rec, store.deps);
    await resolveOutcome("g-merge", { result: "failed", at: "2026-10-03T09:00:00.000Z" }, store.deps);
    expect(store.writes.length).toBe(2);
    for (const w of store.writes) {
      expect(Object.keys((w.classification_metadata ?? {}) as Record<string, unknown>)).toEqual(["semantic_dissent"]);
      expect({ id: w.id, status: w.status, category: w.category, summary: w.summary }).toEqual({ id: "g-merge", status: "open", category: "missing_capability", summary: "merge fixture" });
    }
    const meta = store.current().classification_metadata as Record<string, unknown>;
    expect(meta.edit_site).toBe(EDIT_SITE);
    expect((meta.failure_lessons as unknown[]).length).toBe(1);
    expect(dissentsOf(store.current())).toEqual([{ ...rec, later_outcome: { result: "failed", at: "2026-10-03T09:00:00.000Z" } }]);
    // The reader on a gap the sweep just CLOSED writes the closed status back, never reopening it.
    const closed = memoryGap({ ...row, id: "g-closed", status: "closed", classification_metadata: { semantic_dissent: [rec] } });
    await resolveOutcome("g-closed", { result: "failed", at: "2026-10-03T09:00:00.000Z" }, closed.deps);
    expect(closed.writes.map((w) => [w.status, Object.keys((w.classification_metadata ?? {}) as Record<string, unknown>)])).toEqual([["closed", ["semantic_dissent"]]]);
  });

  it("MUST-FAIL (the reader is called, operator half): the pending-land sweep resolves dissents with 'passed' on a verified landing and 'failed' on a reverted or present one", () => {
    const sweep = fnNamed(new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname, "sweepPendingLandVerificationsOnce"); // moved to gap-landing-verdict (judge split)
    const results = callsTo(sweep, "resolveDissentOutcome").map((c) => literalArgProperty(c, 1, "result"));
    expect({ passed: results.includes("passed"), failed: results.includes("failed") }).toEqual({ passed: true, failed: true });
  });

  // ── CONTRACT: need the seam (red at base); they keep the veto classes from regressing ──────────
  it("CONTRACT: a diff that changes only the gap's own check file (self-certification) is still REFUSED", async () => {
    const gate = await gateSays(SELF_CERT_DIFF, []);
    const d = disposition({ gate, own_check: RED_TO_GREEN, diff: SELF_CERT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect({ land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null }).toEqual({ land: false, veto: "self_certification", dissent: null });
  });

  it("CONTRACT: a hollow write (a new field with no read site in src) is still REFUSED", async () => {
    const gate = await gateSays(HOLLOW_DIFF);
    const d = disposition({ gate, own_check: RED_TO_GREEN, diff: HOLLOW_DIFF, edit_site: EDIT_SITE, src_files: HOLLOW_SRC_FILES });
    expect({ land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null }).toEqual({ land: false, veto: "hollow_write", dissent: null });
  });

  it("CONTRACT: a gate hard_fail is still REFUSED", async () => {
    const gate = await gateSays(DEAD_CODE_DIFF, [{ symbol: "stampCodeVersion", isNewFunction: true, callerCount: 0, isEntrypoint: false, reachable: false }]);
    const d = disposition({ gate, own_check: RED_TO_GREEN, diff: DEAD_CODE_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect({ land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null }).toEqual({ land: false, veto: "hard_fail", dissent: null });
  });

  it("CONTRACT: a diff that misses the gap's edit_site entirely is still REFUSED", async () => {
    const gate = await gateSays(MISS_DIFF, [{ symbol: "scoreRelevance", isNewFunction: false, callerCount: 2, isEntrypoint: false, reachable: true }]);
    expect(gate.hard_fail === true).toBe(false);
    const d = disposition({ gate, own_check: RED_TO_GREEN, diff: MISS_DIFF, edit_site: EDIT_SITE, src_files: MISS_SRC_FILES });
    expect({ land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null }).toEqual({ land: false, veto: "edit_site_missed", dissent: null });
  });

  it("CONTRACT: a draft whose own check did NOT go red->green is unaffected (addresses:false still refuses, no dissent)", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    const cases: Array<[string, OwnCheck | null]> = [
      ["unarmed (no class-2 check)", null],
      ["already green on the parent", { ...RED_TO_GREEN, base_red: [], contract_breach: "the gap's own check is already GREEN on the parent tree, so it cannot certify this draft" }],
      ["parent not judged", { ...RED_TO_GREEN, base_red: null }],
      ["still red on the draft", { ...RED_TO_GREEN, draft_red: ["traces carry the code_version of the tree that ran them"] }],
      ["did not run", { ...RED_TO_GREEN, ran: false }],
    ];
    for (const [label, own] of cases) {
      const d = disposition({ gate, own_check: own, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
      expect({ label, land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null }).toEqual({ label, land: false, veto: "semantic_reject", dissent: null });
    }
  });

  it("CONTRACT: a draft the gate PASSES lands with no dissent stamp and no extra hold", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF, LIVE_FACTS, { addresses: true, on_live_path: true, reason: "edits the live emit path" });
    expect(gate.addresses).toBe(true);
    const d = disposition({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect({ land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null, landed_unverified: d.landed_unverified }).toEqual({ land: true, veto: null, dissent: null, landed_unverified: false });
  });
});
