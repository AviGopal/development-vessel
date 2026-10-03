// CHECK-FIRST: a green armed class-2 own check outranks a non-hard-fail "addresses:false".
//
// GAP semantic-gate-refuters-overturn-a-green-class2-draft-by-misreading-the-requirement.
// Measured on node 1, 2026-10-03 07:03Z: the ONLY draft in a 2 h window that turned its gap's
// ARMED class-2 own check red->green (traces-carry-no-code-version step 1: own check ran:true,
// red:[], tc_ok:true) was overturned by the LLM semantic gate (addresses:false,
// on_live_path:false, hard_fail:false). The overturn is the inline rule at the gate site of
// resolveFeatureCompose (src/resolvers/feature-compose.ts):
//     if (!semantic_gate.addresses || semantic_gate.on_live_path === false) { verdict = "UNFAVORABLE"; ...
// which treats every judge opinion as a veto, however much deterministic evidence says otherwise.
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
//   - Each dissent is recorded with later_outcome (null until the landing is verified or
//     regressed), so the gate can be calibrated.
//
// THE SEAMS THESE TESTS PIN (absent at base; a fix adds them):
//   semanticGateDisposition(input) — exported from src/resolvers/feature-compose.ts, pure:
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
//   recordSemanticDissent(gapId, dissent, { readGap, writeGap }) — exported from the same file.
//     WHERE CALIBRATION READS IT: the gap row's classification_metadata.semantic_dissent (an array,
//     appended). The pending-land sweep in gap-to-feature (pending_outcome_verification ->
//     landed_verified / reverted_landing) is the reader that fills later_outcome. It must NOT write
//     semantic_gate_reason: priorAttemptFeedbackBlock reads that as "your last draft was rejected".
//   Wiring: the gate site calls semanticGateDisposition(, EVERY resolveVesselMitosisCutover call in
//     feature-compose.ts (the compose landing and the parked-landing resume) carries semantic_dissent,
//     and vessel-mitosis-cutover.ts stamps landedUnverifiedReason when it is present.
//
// CONTROLS go through decide(): the seam when exported, otherwise the base inline rule, which must
// then be present VERBATIM in the source (exactly one of the two holds, or the control fails), so a
// control is never a test-local opinion of what the code does.
//
// No LLM, no network (the fetch guard records any request), no fs writes (gap I/O is injected).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import * as fc from "../../src/resolvers/feature-compose.js";
import { verifyPatchAddressesGap, type ReachabilityFact, type SemanticGateVerdict } from "../../src/resolvers/feature-compose.js";
import { installCutoverFetchGuard, type FetchGuard } from "./cutover-fetch-guard.js";

const FC_SRC = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
const CUTOVER_SRC = readFileSync(new URL("../../src/resolvers/vessel-mitosis-cutover.ts", import.meta.url), "utf8");
const BASE_INLINE_VETO = "if (!semantic_gate.addresses || semantic_gate.on_live_path === false) {";

type OwnCheck = { test_file: string; ran: boolean; tc_ok: boolean; base_red: string[] | null; draft_red: string[]; contract_breach: string | null };
type DispositionInput = { gate: SemanticGateVerdict; own_check: OwnCheck | null; diff: string; edit_site: string | null; src_files: Record<string, string> };
type Dissent = { reason: string; gate_verdict: Record<string, unknown>; at: string; later_outcome: unknown };
type Disposition = { land: boolean; veto: string | null; semantic_dissent?: Dissent; landed_unverified: boolean; post_land_by_effect_check: string };

const seam = (fc as unknown as Record<string, unknown>).semanticGateDisposition as ((i: DispositionInput) => Disposition) | undefined;
const recorder = (fc as unknown as Record<string, unknown>).recordSemanticDissent as
  | ((gapId: string, d: Dissent, deps: { readGap: (id: string) => Promise<Record<string, unknown> | null>; writeGap: (row: Record<string, unknown>) => Promise<void> }) => Promise<void>)
  | undefined;

function decide(input: DispositionInput): Disposition & { via: "seam" | "base_inline_rule" } {
  const hasSeam = typeof seam === "function";
  const hasInline = FC_SRC.includes(BASE_INLINE_VETO);
  // Exactly one: the seam replaced the blanket veto, or the blanket veto is still the code.
  expect({ hasSeam, hasInline }).toEqual(hasSeam ? { hasSeam: true, hasInline: false } : { hasSeam: false, hasInline: true });
  if (hasSeam) return { ...seam!(input), via: "seam" };
  const land = input.gate.addresses && input.gate.on_live_path !== false;
  return { land, veto: land ? null : "semantic_reject", landed_unverified: false, post_land_by_effect_check: "not_required", via: "base_inline_rule" };
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
beforeEach(() => { guard = installCutoverFetchGuard(); });
afterEach(() => { expect(guard.restore()).toEqual([]); });

describe("semantic dissent: a green armed class-2 check outranks a non-hard-fail addresses:false", () => {
  it("MUST-FAIL: armed class-2 check red->green + gate {addresses:false, hard_fail:false} LANDS stamped semantic_dissent, landed_unverified until the by-effect check passes", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    // The gate half is real base code and reproduces the measured triple.
    expect(gate).toMatchObject({ addresses: false, on_live_path: false, llm_consulted: true });
    expect(gate.hard_fail === true).toBe(false);

    expect(typeof seam).toBe("function");
    const d = seam!({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect(d.land).toBe(true);
    expect(d.veto).toBeNull(); // not semantic_reject
    expect(d.semantic_dissent?.reason).toBe(MISREAD);
    expect(d.semantic_dissent?.gate_verdict).toMatchObject({ addresses: false, on_live_path: false });
    expect(d.landed_unverified).toBe(true);
    expect(d.post_land_by_effect_check).toBe("required");
  });

  it("MUST-FAIL (wiring): the compose gate site uses the disposition and the cutover lands a dissent landed_unverified", () => {
    // Booleans, not toContain: a failing toContain would print the whole source file.
    // EVERY cutover call, including the parked-landing resume: a dissent landing that is parked
    // (held lease, restart) and resumed must not lose its stamp and land as verified.
    const cutoverCalls = FC_SRC.split("await resolveVesselMitosisCutover({").slice(1).map((c) => c.slice(0, c.indexOf("} as never)")));
    expect({
      gate_site_calls_disposition: FC_SRC.includes("semanticGateDisposition("),
      // The cutover pointer carries the stamp, so the landing record and the trace can show it.
      cutover_pointer_carries_dissent: cutoverCalls.length > 0 && cutoverCalls.every((c) => c.includes("semantic_dissent")),
      // The cutover reads it and withholds own_check_verified until the by-effect check passes.
      cutover_marks_dissent_landed_unverified: /semantic_dissent[\s\S]{0,600}landedUnverifiedReason\s*=|landedUnverifiedReason\s*=[^;]*semantic_dissent/.test(CUTOVER_SRC),
    }).toEqual({ gate_site_calls_disposition: true, cutover_pointer_carries_dissent: true, cutover_marks_dissent_landed_unverified: true });
  });

  it("MUST-FAIL (contract): the dissent record is {reason, gate_verdict, at, later_outcome:null} on the gap row's classification_metadata.semantic_dissent", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    expect(typeof seam).toBe("function");
    const d = seam!({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    const rec = d.semantic_dissent!;
    expect(Object.keys(rec).sort()).toEqual(["at", "gate_verdict", "later_outcome", "reason"]);
    expect(rec.later_outcome).toBeNull();
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);

    expect(typeof recorder).toBe("function");
    const prior: Dissent = { reason: "an earlier dissent", gate_verdict: { addresses: false }, at: "2026-10-01T00:00:00.000Z", later_outcome: "verified" };
    const row = { id: "traces-carry-no-code-version", status: "open", classification_metadata: { edit_site: EDIT_SITE, semantic_dissent: [prior] } };
    const writes: Record<string, unknown>[] = [];
    await recorder!("traces-carry-no-code-version", rec, {
      readGap: async (id) => (id === row.id ? structuredClone(row) : null),
      writeGap: async (r) => { writes.push(r); },
    });
    expect(writes.length).toBe(1);
    const meta = (writes[0]!.classification_metadata ?? {}) as Record<string, unknown>;
    expect(meta.edit_site).toBe(EDIT_SITE); // other metadata kept
    expect(meta.semantic_dissent).toEqual([prior, rec]); // appended, not replaced
    // A landed dissent is not a rejection: the next drafter must not be told its fix was refused.
    expect("semantic_gate_reason" in meta).toBe(false);
  });

  it("CONTROL: a diff that changes only the gap's own check file (self-certification) is still REFUSED", async () => {
    const gate = await gateSays(SELF_CERT_DIFF, []);
    expect(gate.hard_fail === true).toBe(false); // a test-only diff skips the reachability hard-fail: only the disposition can refuse it
    const d = decide({ gate, own_check: RED_TO_GREEN, diff: SELF_CERT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect(d.land).toBe(false);
    expect(d.semantic_dissent).toBeUndefined();
    expect(d.veto).toBe(d.via === "seam" ? "self_certification" : "semantic_reject");
  });

  it("CONTROL: a hollow write (a new field with no read site in src) is still REFUSED", async () => {
    const gate = await gateSays(HOLLOW_DIFF);
    expect(gate.hard_fail === true).toBe(false); // not the reachability hard-fail: the hollow-write rule must catch it
    expect(Object.values(HOLLOW_SRC_FILES).join("\n").split("\n").filter((l) => l.includes("code_version_stamp")).length).toBe(1);
    const d = decide({ gate, own_check: RED_TO_GREEN, diff: HOLLOW_DIFF, edit_site: EDIT_SITE, src_files: HOLLOW_SRC_FILES });
    expect(d.land).toBe(false);
    expect(d.semantic_dissent).toBeUndefined();
    expect(d.veto).toBe(d.via === "seam" ? "hollow_write" : "semantic_reject");
  });

  it("CONTROL: a gate hard_fail is still REFUSED", async () => {
    const facts: ReachabilityFact[] = [{ symbol: "stampCodeVersion", isNewFunction: true, callerCount: 0, isEntrypoint: false, reachable: false }];
    const gate = await gateSays(DEAD_CODE_DIFF, facts);
    expect(gate.hard_fail).toBe(true);
    const d = decide({ gate, own_check: RED_TO_GREEN, diff: DEAD_CODE_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect(d.land).toBe(false);
    expect(d.semantic_dissent).toBeUndefined();
    expect(d.veto).toBe(d.via === "seam" ? "hard_fail" : "semantic_reject");
  });

  it("CONTROL: a diff that misses the gap's edit_site entirely is still REFUSED", async () => {
    const gate = await gateSays(MISS_DIFF, [{ symbol: "scoreRelevance", isNewFunction: false, callerCount: 2, isEntrypoint: false, reachable: true }]);
    expect(gate.hard_fail === true).toBe(false);
    const d = decide({ gate, own_check: RED_TO_GREEN, diff: MISS_DIFF, edit_site: EDIT_SITE, src_files: MISS_SRC_FILES });
    expect(d.land).toBe(false);
    expect(d.semantic_dissent).toBeUndefined();
    expect(d.veto).toBe(d.via === "seam" ? "edit_site_missed" : "semantic_reject");
  });

  it("CONTROL: a draft whose own check did NOT go red->green is unaffected (addresses:false still refuses, no dissent)", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF);
    const cases: Array<[string, OwnCheck | null]> = [
      ["unarmed (no class-2 check)", null],
      ["already green on the parent", { ...RED_TO_GREEN, base_red: [], contract_breach: "the gap's own check is already GREEN on the parent tree, so it cannot certify this draft" }],
      ["parent not judged", { ...RED_TO_GREEN, base_red: null }],
      ["still red on the draft", { ...RED_TO_GREEN, draft_red: ["traces carry the code_version of the tree that ran them"] }],
      ["did not run", { ...RED_TO_GREEN, ran: false }],
    ];
    for (const [label, own] of cases) {
      const d = decide({ gate, own_check: own, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
      expect({ label, land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null }).toEqual({ label, land: false, veto: "semantic_reject", dissent: null });
    }
  });

  it("CONTROL: a draft the gate PASSES lands with no dissent stamp and no extra hold", async () => {
    const gate = await gateSays(GREEN_DRAFT_DIFF, LIVE_FACTS, { addresses: true, on_live_path: true, reason: "edits the live emit path" });
    expect(gate.addresses).toBe(true);
    const d = decide({ gate, own_check: RED_TO_GREEN, diff: GREEN_DRAFT_DIFF, edit_site: EDIT_SITE, src_files: SRC_FILES });
    expect(d.land).toBe(true);
    expect(d.veto).toBeNull();
    expect(d.semantic_dissent).toBeUndefined();
    expect(d.landed_unverified).toBe(false);
  });
});
