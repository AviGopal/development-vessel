// CHECK-FIRST: a landing over the lane's own semantic dissent is PARTIAL, and the dissent becomes the next gap.
//
// Measured (autonomous commit 30e236ed, development-vessel): the semantic gate refused the draft 2/2
// (addresses:false), but the gap's armed own check went red->green and the diff passed the
// self-certification, hollow-write and edit-site screens, so semanticGateDisposition returned
// land:true, landed_unverified:true. Then:
//   - the pending-land sweep closed the gap `landed_verified`, the same reason a landing the gate accepted
//     gets, so the verified-landing count could not tell the two apart;
//   - the sweep settled the dissent's later_outcome as `passed` using THE SAME own check the gate had
//     doubted. The "post-land by-effect check" was circular: the check that outranked the gate was also
//     the evidence that the gate had been wrong;
//   - the key it added (synthesize_from, an object-literal contract key) had no reader in its vessel's
//     src, and hollowWriteIdentifiers did not see it (it finds new functions and `.x =` writes only).
//
// RULING (qa, binding; the object-literal-key half as corrected by qa review):
//   (a) a landing under dissent closes as `landed_partial`, never `landed_verified`; the verified-landing
//       credit (the gap store holder's expectation calibration) does not count it;
//   (b) at landing time the dissent's reason is minted into a NARROWED CHILD gap through the one
//       narrowed-child builder (gap-to-feature narrowedChildRecord, also used by chronic-failure
//       narrowing). It carries the parent's edit_site, the dissent reason, parent_gap_id and a
//       falsifier_spec naming the parent's check as the one its own must differ from; it inherits no check;
//   (c) a dissent's later_outcome may be settled `passed` ONLY by a check distinct from the parent's own
//       check (never the same test name): the child's, when the child closes. A `failed` (the landing was
//       reverted, or measured present while running) is still recorded from any route;
//   (d) object-literal keys a diff adds in non-test src with ZERO readers in the vessel's OWN src are
//       EVIDENCE attached to a dissent (and its child), never a veto and never by themselves a partial
//       landing: a key another vessel reads looks unread from here.
//
// This makes counted landings HONEST; it is expected to LOWER the verified count. It is not a draft-yield fix.
//
// No LLM, no network (fetch guard), no host process (exec guard), no fs writes (gap I/O injected).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as fc from "../../src/resolvers/feature-compose.js";
import type { SemanticGateVerdict } from "../../src/resolvers/feature-compose.js";
import { installCutoverFetchGuard, restoreCutoverFetch, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

type GapDeps = { readGap: (id: string) => Promise<Record<string, unknown> | null>; writeGap: (row: Record<string, unknown>) => Promise<void> };
type OwnCheck = { test_file: string; ran: boolean; tc_ok: boolean; base_red: string[] | null; draft_red: string[]; contract_breach: string | null };
type Disposition = { land: boolean; veto: string | null; semantic_dissent?: Record<string, unknown>; landed_unverified: boolean };

function exported<T>(name: string): T {
  const f = (fc as unknown as Record<string, unknown>)[name];
  expect(typeof f, `src/resolvers/feature-compose.ts must export ${name}`).toBe("function");
  return f as T;
}

// ── fixtures: the 30e236ed shape ─────────────────────────────────────────────────────────────────
const V = "development-vessel";
const EDIT_FILE = "src/resolvers/llm-dispatch-contract.ts";
const EDIT_SITE = `repos/${V}/${EDIT_FILE}:12`;
const OWN_TEST_FILE = "test/resolvers/llm-dispatch-contract.test.ts";
const OWN_TEST_NAME = "the contract names where a synthesized payload comes from";
const PARENT_ID = "llm-dispatch-contract-names-no-synthesis-source";
const LANDED_SHA = "30e236ed5b0f4c7e9a1d2c3b4a5f6e7d8c9b0a1f";
const REFUTERS = "2/2 refuters: the contract now NAMES synthesize_from, but nothing reads it — KNOWN_RESOLVERS still dispatches without it, so no synthesized payload changes";
const OWN_CHECK_META = { evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${V}`, test_file: OWN_TEST_FILE, only_tests: [OWN_TEST_NAME] }, zero_field: "requested_not_passing" } };
const CHILD_CHECK_META = { evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${V}`, test_file: "test/resolvers/known-resolvers-synthesis.test.ts", only_tests: ["KNOWN_RESOLVERS dispatches with the contract's synthesize_from"] }, zero_field: "requested_not_passing" } };

const CONTRACT_PRE = [
  "export const LLM_DISPATCH_CONTRACT = {",
  '  shape: "llm_dispatch",',
  '  model_hint: "default",',
  "};",
].join("\n");
const CONTRACT_POST = CONTRACT_PRE.replace('  model_hint: "default",', '  model_hint: "default",\n  synthesize_from: "goal_and_upstream",');
const KEY_DIFF = [
  `### /vessels/${V}/${EDIT_FILE}`,
  `--- a/${V}/${EDIT_FILE}`,
  `+++ b/${V}/${EDIT_FILE}`,
  "@@ -1,4 +1,5 @@",
  " export const LLM_DISPATCH_CONTRACT = {",
  '   shape: "llm_dispatch",',
  '   model_hint: "default",',
  '+  synthesize_from: "goal_and_upstream",',
  " };",
].join("\n");
const DISPATCH_SRC = 'import { LLM_DISPATCH_CONTRACT } from "./llm-dispatch-contract.js";\nexport function dispatch() { return { shape: LLM_DISPATCH_CONTRACT.shape, hint: LLM_DISPATCH_CONTRACT.model_hint }; }\n';
const SRC_NO_READER: Record<string, string> = { [EDIT_FILE]: CONTRACT_POST, "src/resolvers/llm-dispatch.ts": DISPATCH_SRC };
const SRC_WITH_READER: Record<string, string> = {
  ...SRC_NO_READER,
  "src/resolvers/llm-dispatch.ts": DISPATCH_SRC.replace("hint: LLM_DISPATCH_CONTRACT.model_hint", "hint: LLM_DISPATCH_CONTRACT.model_hint, from: LLM_DISPATCH_CONTRACT.synthesize_from"),
};
// A test file mentioning the key is not a reader.
const SRC_TEST_ONLY_READER: Record<string, string> = { ...SRC_NO_READER, "test/resolvers/llm-dispatch-contract.test.ts": "expect(LLM_DISPATCH_CONTRACT.synthesize_from).toBe(\"goal_and_upstream\");\n" };

const RED_TO_GREEN: OwnCheck = { test_file: OWN_TEST_FILE, ran: true, tc_ok: true, base_red: [OWN_TEST_NAME], draft_red: [], contract_breach: null };
const DISSENT_GATE = { addresses: false, on_live_path: false, hard_fail: false, reason: REFUTERS } as unknown as SemanticGateVerdict;
const PASS_GATE = { addresses: true, on_live_path: true, hard_fail: false, reason: "wires the contract" } as unknown as SemanticGateVerdict;

let guard: FetchGuard;
let exec: ExecGuard;
beforeEach(() => { guard = installCutoverFetchGuard(); exec = installCutoverExecGuard(); });
afterEach(() => {
  const execViolations = exec.restore();
  expect(guard.restore()).toEqual([]);
  expect(execViolations).toEqual([]);
});
afterAll(() => { restoreCutoverFetch(); restoreCutoverExecModules(); });

/** An in-memory gap store keyed by id. Like the real store, a write carries omitted classification_metadata keys forward. */
function memoryStore(rows: Record<string, unknown>[]): { deps: GapDeps; writes: Record<string, unknown>[]; row: (id: string) => Record<string, unknown> | undefined } {
  const m = new Map<string, Record<string, unknown>>(rows.map((r) => [String(r.id), structuredClone(r)]));
  const writes: Record<string, unknown>[] = [];
  return {
    deps: {
      readGap: async (id) => (m.has(id) ? structuredClone(m.get(id)!) : null),
      writeGap: async (r) => {
        writes.push(structuredClone(r));
        const id = String(r.id);
        const cur = m.get(id) ?? {};
        m.set(id, { ...cur, ...structuredClone(r), classification_metadata: { ...((cur.classification_metadata ?? {}) as Record<string, unknown>), ...((r.classification_metadata ?? {}) as Record<string, unknown>) } });
      },
    },
    writes,
    row: (id) => m.get(id),
  };
}
const metaOf = (r: Record<string, unknown> | undefined): Record<string, unknown> => ((r?.classification_metadata ?? {}) as Record<string, unknown>);
const PARENT_ROW = { id: PARENT_ID, status: "open", category: "missing_capability", source: "substrate_detected", summary: "the llm dispatch contract names no synthesis source", detected_at: "2026-10-02T00:00:00.000Z", classification_metadata: { edit_site: EDIT_SITE, ...OWN_CHECK_META, falsifier: { class: "class2" }, predicate_birth_verdict: "present" } };

/** The landing the compose made: disposition, then the settle the compose calls after a pushed cutover. */
async function landUnderDissent(store: ReturnType<typeof memoryStore>, src: Record<string, string> = SRC_NO_READER): Promise<Record<string, unknown>> {
  const d = exported<(i: unknown) => Disposition>("semanticGateDisposition")({ gate: DISSENT_GATE, own_check: RED_TO_GREEN, diff: KEY_DIFF, edit_site: EDIT_SITE, src_files: src });
  expect({ land: d.land, veto: d.veto, dissent: !!d.semantic_dissent }).toEqual({ land: true, veto: null, dissent: true });
  await exported<(g: string, d: unknown, cut: unknown, deps: GapDeps) => Promise<unknown>>("settleSemanticDissent")(PARENT_ID, d.semantic_dissent, { push_status: "pushed", new_git_sha: LANDED_SHA }, store.deps);
  return d.semantic_dissent!;
}

// ── STRUCTURAL PINS READ THE SYNTAX TREE ─────────────────────────────────────────────────────────
const GTF_PATH = new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url).pathname;
function walk(node: ts.Node, visit: (n: ts.Node) => void): void { visit(node); node.forEachChild((c) => walk(c, visit)); }
function fnNamed(path: string, name: string): ts.Node {
  const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.Node | undefined;
  walk(sf, (n) => { if (!found && ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; });
  expect(found !== undefined, `function '${name}' must exist in gap-to-feature.ts`).toBe(true);
  return found!;
}
/** Every object-literal `closed_reason:` initializer in `fn`, as source text. */
function closedReasonInitializers(fn: ts.Node): string[] {
  const out: string[] = [];
  walk(fn, (n) => { if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "closed_reason") out.push(n.initializer.getText()); });
  return out;
}

describe("a landing over the lane's own semantic dissent is partial, and the dissent becomes the next gap", () => {
  // ── (a) landed_partial ──────────────────────────────────────────────────────────────────────────
  it("MUST-FAIL (a): own check red->green + gate dissent 2/2 -> the close reason for that landing is landed_partial, not landed_verified", async () => {
    const store = memoryStore([PARENT_ROW]);
    await landUnderDissent(store);
    const reason = exported<(m: Record<string, unknown>, sha: string, literalOnly: boolean) => string>("landedCloseReason");
    const meta = metaOf(store.row(PARENT_ID));
    expect(reason(meta, LANDED_SHA, false)).toBe("landed_partial");
    expect(reason(meta, LANDED_SHA.slice(0, 12), false)).toBe("landed_partial"); // the sweep's pending sha may be abbreviated
    expect(reason(meta, LANDED_SHA, true)).toBe("landed_partial"); // literal-only does not upgrade it
  });

  it("CONTROL (a): a no-dissent landing still closes landed_verified (and a literal-only one landed_literal_only)", async () => {
    const reason = exported<(m: Record<string, unknown>, sha: string, literalOnly: boolean) => string>("landedCloseReason");
    expect(reason(metaOf(PARENT_ROW), LANDED_SHA, false)).toBe("landed_verified");
    expect(reason(metaOf(PARENT_ROW), LANDED_SHA, true)).toBe("landed_literal_only");
    // A dissent recorded for a DIFFERENT, earlier landing (already settled) does not make this one partial.
    const old = { reason: "old", gate_verdict: {}, at: "2026-09-30T00:00:00.000Z", landed_sha: "1111111aaaaaaa", later_outcome: { result: "failed", at: "2026-09-30T01:00:00.000Z" } };
    expect(reason({ ...metaOf(PARENT_ROW), semantic_dissent: [old] }, LANDED_SHA, false)).toBe("landed_verified");
  });

  it("MUST-FAIL (a, wiring AST): both landing closers — closeLandedGap and the pending-land sweep — take closed_reason from landedCloseReason", () => {
    const sites = ["closeLandedGap", "sweepPendingLandVerificationsOnce"].map((fn) => [fn, closedReasonInitializers(fnNamed(GTF_PATH, fn))] as const);
    for (const [fn, inits] of sites) {
      const landing = inits.filter((t) => /landed_verified|landedCloseReason/.test(t));
      expect({ fn, every_landing_close_uses_the_helper: landing.length > 0 && landing.every((t) => t.startsWith("landedCloseReason(")) }).toEqual({ fn, every_landing_close_uses_the_helper: true });
    }
  });

  it("MUST-FAIL (a): landed_partial is an AUTONOMOUS close reason (goal-reach attribution), but NOT a really-fixed reason (detector yield)", async () => {
    const { AUTONOMOUS_CLOSE_REASONS } = await import("../../src/resolvers/goal-reach-tick.js");
    expect(AUTONOMOUS_CLOSE_REASONS.has("landed_partial")).toBe(true);
    const dy = readFileSync(new URL("../../src/resolvers/detector-yield-registry.ts", import.meta.url).pathname, "utf8");
    const really = /const REALLY_FIXED_REASONS = new Set\(\[([\s\S]*?)\]\)/.exec(dy)?.[1] ?? "";
    expect(really.includes("landed_verified") && !really.includes("landed_partial")).toBe(true);
  });

  // ── (b) the narrowed child ──────────────────────────────────────────────────────────────────────
  it("MUST-FAIL (b): the landing mints a narrowed child carrying the parent's edit_site, the dissent reason, parent_gap_id and a falsifier_spec; it inherits NO check", async () => {
    const store = memoryStore([PARENT_ROW]);
    await landUnderDissent(store);
    const parentDissents = metaOf(store.row(PARENT_ID)).semantic_dissent as Array<Record<string, unknown>>;
    expect(parentDissents.length).toBe(1);
    const childId = String(parentDissents[0]!.child_gap_id ?? "");
    expect(childId).toBe(`${PARENT_ID}-dissent-narrowed`);
    const child = store.row(childId)!;
    const cm = metaOf(child);
    expect({
      status: child.status,
      edit_site: cm.edit_site,
      parent_gap_id: cm.parent_gap_id,
      narrowed_from: cm.narrowed_from,
      summary_has_reason: String(child.summary).includes(REFUTERS),
      dissent_reason: (cm.dissent as Record<string, unknown> | undefined)?.reason,
      dissent_landed_sha: (cm.dissent as Record<string, unknown> | undefined)?.landed_sha,
      must_differ_from_names: ((cm.falsifier_spec as Record<string, unknown> | undefined)?.must_differ_from as Record<string, unknown> | undefined)?.test_names,
      // no check of the parent's: the parent's own check is already green, so a copy would be born satisfied
      evidence_resolve: cm.evidence_resolve ?? null,
      verify_shape: cm.verify_shape ?? null,
      expected_literal: cm.expected_literal ?? null,
      falsifier: cm.falsifier ?? null,
      predicate_birth_verdict: cm.predicate_birth_verdict ?? null,
      semantic_dissent: cm.semantic_dissent ?? null,
    }).toEqual({
      status: "open",
      edit_site: EDIT_SITE,
      parent_gap_id: PARENT_ID,
      narrowed_from: "semantic_dissent",
      summary_has_reason: true,
      dissent_reason: REFUTERS,
      dissent_landed_sha: LANDED_SHA,
      must_differ_from_names: [OWN_TEST_NAME],
      evidence_resolve: null,
      verify_shape: null,
      expected_literal: null,
      falsifier: null,
      predicate_birth_verdict: null,
      semantic_dissent: null,
    });
  });

  it("MUST-FAIL (b, one builder): chronic-failure narrowing and the dissent child are built by the same exported narrowedChildRecord", async () => {
    const g = await import("../../src/resolvers/gap-to-feature.js");
    expect(typeof (g as Record<string, unknown>).narrowedChildRecord).toBe("function");
    const bump = fnNamed(GTF_PATH, "bumpFailedAttempts");
    let calls = 0;
    walk(bump, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "narrowedChildRecord") calls++; });
    expect(calls).toBe(1);
  });

  it("CONTROL (b): an unpushed landing mints no child and records no dissent", async () => {
    const store = memoryStore([PARENT_ROW]);
    const d = exported<(i: unknown) => Disposition>("semanticGateDisposition")({ gate: DISSENT_GATE, own_check: RED_TO_GREEN, diff: KEY_DIFF, edit_site: EDIT_SITE, src_files: SRC_NO_READER });
    await exported<(g: string, d: unknown, cut: unknown, deps: GapDeps) => Promise<unknown>>("settleSemanticDissent")(PARENT_ID, d.semantic_dissent, { push_status: "push_failed", new_git_sha: "" }, store.deps);
    expect(store.writes).toEqual([]);
  });

  // ── (c) settlement only by a DISTINCT check ─────────────────────────────────────────────────────
  it("MUST-FAIL (c): a later sweep with the SAME own check does NOT settle the dissent as passed", async () => {
    const store = memoryStore([PARENT_ROW]);
    await landUnderDissent(store);
    const resolveOutcome = exported<(g: string, o: { result: "passed" | "failed"; at?: string }, deps: GapDeps) => Promise<number>>("resolveDissentOutcome");
    const n = await resolveOutcome(PARENT_ID, { result: "passed", at: "2026-10-03T12:00:00.000Z" }, store.deps);
    expect(n).toBe(0);
    expect((metaOf(store.row(PARENT_ID)).semantic_dissent as Array<Record<string, unknown>>)[0]!.later_outcome).toBeNull();
    // Re-armed with a check that shares the test NAME (a different timeout, say) is still the same check.
    const same = memoryStore([PARENT_ROW]);
    await landUnderDissent(same);
    const r = same.row(PARENT_ID)!;
    const er = structuredClone(OWN_CHECK_META.evidence_resolve) as Record<string, unknown>;
    (er.input as Record<string, unknown>).timeout_ms = 999;
    await same.deps.writeGap({ id: PARENT_ID, status: r.status, classification_metadata: { evidence_resolve: er } });
    expect(await resolveOutcome(PARENT_ID, { result: "passed" }, same.deps)).toBe(0);
  });

  it("MUST-FAIL (c): the CHILD's distinct check closing settles the parent's dissent as passed, citing the child", async () => {
    const store = memoryStore([PARENT_ROW]);
    await landUnderDissent(store);
    const childId = `${PARENT_ID}-dissent-narrowed`;
    // The child gets armed with its own check, distinct from the parent's.
    await store.deps.writeGap({ id: childId, status: "open", classification_metadata: { ...CHILD_CHECK_META } });
    const resolveOutcome = exported<(g: string, o: { result: "passed" | "failed"; at?: string }, deps: GapDeps) => Promise<number>>("resolveDissentOutcome");
    await resolveOutcome(childId, { result: "passed", at: "2026-10-04T00:00:00.000Z" }, store.deps);
    const lo = (metaOf(store.row(PARENT_ID)).semantic_dissent as Array<Record<string, unknown>>)[0]!.later_outcome as Record<string, unknown> | null;
    expect(lo).toMatchObject({ result: "passed", at: "2026-10-04T00:00:00.000Z", settled_by: { gap_id: childId } });
  });

  it("MUST-FAIL (c): a child armed with the PARENT's check (same test name) cannot settle the parent's dissent", async () => {
    const store = memoryStore([PARENT_ROW]);
    await landUnderDissent(store);
    const childId = `${PARENT_ID}-dissent-narrowed`;
    await store.deps.writeGap({ id: childId, status: "open", classification_metadata: { ...OWN_CHECK_META } });
    const resolveOutcome = exported<(g: string, o: { result: "passed" | "failed"; at?: string }, deps: GapDeps) => Promise<number>>("resolveDissentOutcome");
    await resolveOutcome(childId, { result: "passed" }, store.deps);
    expect((metaOf(store.row(PARENT_ID)).semantic_dissent as Array<Record<string, unknown>>)[0]!.later_outcome).toBeNull();
  });

  it("CONTROL (c): a failure (reverted / measured present) is still recorded on the parent's own route", async () => {
    const store = memoryStore([PARENT_ROW]);
    await landUnderDissent(store);
    const resolveOutcome = exported<(g: string, o: { result: "passed" | "failed"; at?: string }, deps: GapDeps) => Promise<number>>("resolveDissentOutcome");
    expect(await resolveOutcome(PARENT_ID, { result: "failed", at: "2026-10-03T12:00:00.000Z" }, store.deps)).toBe(1);
  });

  it("MUST-FAIL (c, arming): the dissent child may be given its own check (decomposeGap), and a proposed check that is the parent's is refused", async () => {
    const store = memoryStore([PARENT_ROW]);
    await landUnderDissent(store);
    const cm = metaOf(store.row(`${PARENT_ID}-dissent-narrowed`));
    const refusal = exported<(childMeta: Record<string, unknown>, proposed: Record<string, unknown>) => string | null>("dissentChildCheckRefusal");
    const isChild = exported<(m: Record<string, unknown>) => boolean>("isDissentChild");
    expect(isChild(cm)).toBe(true);
    expect(isChild({ parent_gap_id: PARENT_ID })).toBe(false); // a chronic-failure child or a step is not
    expect(refusal(cm, OWN_CHECK_META)).toMatch(/parent's own check/);
    expect(refusal(cm, CHILD_CHECK_META)).toBeNull();
    // Wiring: decomposeGap lets a dissent child through its "a decomposed step is not decomposed again" guard and
    // runs the refusal on the proposed parent_check.
    const dg = fnNamed(GTF_PATH, "decomposeGap");
    const called = new Set<string>();
    walk(dg, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) called.add(n.expression.text); });
    expect({ isDissentChild: called.has("isDissentChild"), dissentChildCheckRefusal: called.has("dissentChildCheckRefusal") }).toEqual({ isDissentChild: true, dissentChildCheckRefusal: true });
  });

  // ── (2a) STALE DISSENT: a later landing the gate AGREES with supersedes an unsettled dissent ────────
  // Without this, an unsettled dissent with no landed_sha (recorded before landed_sha was stamped) marks
  // EVERY later landing on the gap partial, freezing it there.
  const LEGACY_DISSENT = { reason: "an old 2/2 dissent, recorded before landed_sha was stamped", gate_verdict: { addresses: false, on_live_path: false }, at: "2026-10-02T08:00:00.000Z", later_outcome: null };
  const NEW_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
  const settleFn = () => exported<(g: string, d: unknown, cut: unknown, deps: GapDeps) => Promise<unknown>>("settleSemanticDissent");
  const reasonFn = () => exported<(m: Record<string, unknown>, sha: string, literalOnly: boolean) => string>("landedCloseReason");

  it("MUST-FAIL (2a): an old unsettled dissent with no landed_sha, then a new landing the gate agrees with -> landed_verified, and the old dissent is settled superseded by that landing's sha and check", async () => {
    const store = memoryStore([{ ...PARENT_ROW, classification_metadata: { ...metaOf(PARENT_ROW), semantic_dissent: [LEGACY_DISSENT] } }]);
    expect(reasonFn()(metaOf(store.row(PARENT_ID)), NEW_SHA, false)).toBe("landed_partial"); // the freeze, before the landing
    const d = exported<(i: unknown) => Disposition>("semanticGateDisposition")({ gate: PASS_GATE, own_check: RED_TO_GREEN, diff: KEY_DIFF, edit_site: EDIT_SITE, src_files: SRC_WITH_READER });
    expect(d.semantic_dissent ?? null).toBeNull();
    await settleFn()(PARENT_ID, d.semantic_dissent ?? null, { push_status: "pushed", new_git_sha: NEW_SHA }, store.deps);
    const meta = metaOf(store.row(PARENT_ID));
    const list = meta.semantic_dissent as Array<Record<string, unknown>>;
    expect(list.length).toBe(1);
    expect(list[0]!.later_outcome).toMatchObject({ result: "superseded", settled_by: { landed_sha: NEW_SHA, check_key: (exported<(m: Record<string, unknown>) => { key: string } | null>("gapCheckIdentity")(OWN_CHECK_META))!.key } });
    expect(reasonFn()(meta, NEW_SHA, false)).toBe("landed_verified");
    // No child is minted for an agreeing landing.
    expect(store.row(`${PARENT_ID}-dissent-narrowed`)).toBeUndefined();
  });

  it("CONTROL (2a): a new landing that ALSO dissents is still partial", async () => {
    const store = memoryStore([{ ...PARENT_ROW, classification_metadata: { ...metaOf(PARENT_ROW), semantic_dissent: [LEGACY_DISSENT] } }]);
    const d = exported<(i: unknown) => Disposition>("semanticGateDisposition")({ gate: DISSENT_GATE, own_check: RED_TO_GREEN, diff: KEY_DIFF, edit_site: EDIT_SITE, src_files: SRC_NO_READER });
    await settleFn()(PARENT_ID, d.semantic_dissent, { push_status: "pushed", new_git_sha: NEW_SHA }, store.deps);
    const meta = metaOf(store.row(PARENT_ID));
    expect(reasonFn()(meta, NEW_SHA, false)).toBe("landed_partial");
    expect(((meta.semantic_dissent as Array<Record<string, unknown>>)[0]!.later_outcome as Record<string, unknown> | null)?.result ?? null).not.toBe("superseded");
  });

  it("CONTROL (2a): an agreeing landing that did NOT push supersedes nothing; settled dissents are untouched", async () => {
    const settled = { ...LEGACY_DISSENT, later_outcome: { result: "failed", at: "2026-10-02T09:00:00.000Z" } };
    const store = memoryStore([{ ...PARENT_ROW, classification_metadata: { ...metaOf(PARENT_ROW), semantic_dissent: [LEGACY_DISSENT] } }]);
    await settleFn()(PARENT_ID, null, { push_status: "push_failed", new_git_sha: "" }, store.deps);
    expect(store.writes).toEqual([]);
    const done = memoryStore([{ ...PARENT_ROW, classification_metadata: { ...metaOf(PARENT_ROW), semantic_dissent: [settled] } }]);
    await settleFn()(PARENT_ID, null, { push_status: "pushed", new_git_sha: NEW_SHA }, done.deps);
    expect(done.writes).toEqual([]);
  });

  // ── (d) zero-local-reader keys are EVIDENCE, never a veto ──────────────────────────────────────
  it("MUST-FAIL (d): with a dissent, the dissent and the child's record list the zero-local-reader key as evidence", async () => {
    const store = memoryStore([PARENT_ROW]);
    const dissent = await landUnderDissent(store);
    expect(dissent.unread_keys).toEqual(["synthesize_from"]);
    const cm = metaOf(store.row(`${PARENT_ID}-dissent-narrowed`));
    expect((cm.dissent as Record<string, unknown>).unread_keys).toEqual(["synthesize_from"]);
  });

  it("PIN (d): a zero-local-reader key with NO dissent is a normal landing — no veto, not unverified", () => {
    const d = exported<(i: unknown) => Disposition>("semanticGateDisposition")({ gate: PASS_GATE, own_check: RED_TO_GREEN, diff: KEY_DIFF, edit_site: EDIT_SITE, src_files: SRC_NO_READER });
    expect({ land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null, landed_unverified: d.landed_unverified }).toEqual({ land: true, veto: null, dissent: null, landed_unverified: false });
    // And under a dissent the key does not turn the landing into a veto (hollow_write stays new-symbol/`.x =` only).
    const dd = exported<(i: unknown) => Disposition>("semanticGateDisposition")({ gate: DISSENT_GATE, own_check: RED_TO_GREEN, diff: KEY_DIFF, edit_site: EDIT_SITE, src_files: SRC_NO_READER });
    expect({ land: dd.land, veto: dd.veto }).toEqual({ land: true, veto: null });
  });

  it("CONTROL (d): a key WITH a reader in the vessel's src is not listed; a test-file mention is not a reader", () => {
    const keys = exported<(diff: string, src: Record<string, string>) => string[]>("unreadObjectLiteralKeys");
    expect(keys(KEY_DIFF, SRC_WITH_READER)).toEqual([]);
    expect(keys(KEY_DIFF, SRC_NO_READER)).toEqual(["synthesize_from"]);
    expect(keys(KEY_DIFF, SRC_TEST_ONLY_READER)).toEqual(["synthesize_from"]);
    const d = exported<(i: unknown) => Disposition>("semanticGateDisposition")({ gate: DISSENT_GATE, own_check: RED_TO_GREEN, diff: KEY_DIFF, edit_site: EDIT_SITE, src_files: SRC_WITH_READER });
    expect(d.semantic_dissent && "unread_keys" in d.semantic_dissent).toBe(false);
  });

  it("CONTROL (d): type members, `case`/`default` labels, an edited (removed+added) key and keys added in test files are not object-literal keys", () => {
    const keys = exported<(diff: string, src: Record<string, string>) => string[]>("unreadObjectLiteralKeys");
    const diff = [
      `### /vessels/${V}/${EDIT_FILE}`,
      "@@ -1,6 +1,9 @@",
      "+  synth_kind: string;",
      "+  synth_mode?: unknown,",
      "+    default:",
      '-  model_hint: "default",',
      '+  model_hint: "fast",',
      `### /vessels/${V}/test/resolvers/x.test.ts`,
      '+  test_only_key: "x",',
    ].join("\n");
    expect(keys(diff, SRC_NO_READER)).toEqual([]);
  });
});
