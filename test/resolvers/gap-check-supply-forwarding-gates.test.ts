// THE ARM GATES RUN ON EVERY NODE, WHEREVER THE GAP STORE IS HELD (2026-10-22).
//
// The arm step's red-reason gates (redForTheRightReason, armRedReasonRefusal, contractMismatchRefusal) and the first
// failure it keeps on the ledger were taken only where the gap store is local. A node that forwards its store settles a
// handed-off check from the holder's birth stamp, which carries a verdict and no report, so all four were null there:
// 333be5f's check (an assertion red on a shape and a body field its resolver never returns, red on every tree) armed on
// a forwarding node though the same check is refused on the holder (gap-check-supply-contract-mismatch.test.ts). The
// behaviour depended on which node holds the store (law 1). Now a forwarding node reads the check's run report where
// its verdict was measured (the check's own pointer, resolved at the holder) and judges it by the same gates; a report
// it cannot read arms nothing.
//
// The two nodes are one process, as in gap-check-supply-forwarding-arm.test.ts: the holder is the in-process
// substrate-gap resolver (and the in-process test_suite resolver) answering the forward URL with GAP_STORE_ENDPOINT
// unset for its turn. The check runs through the REAL test_suite resolver against a temp clone holding
// template-input-lint-scan.ts as it was at 333be5f with its dependencies stubbed, so nothing is scanned or posted.
//
// Named mutants this file kills: (M1) the gates guarded by gapStoreIsLocal() again: the 333be5f and wrong-reason cases
// arm; (M2) the report read failing open (arming on the holder's present when the report is unreadable): the
// unreadable-report case arms; (M3) the report read dropped and the gates run on a null report: the forwarding
// genuine-red control is refused.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { landCheck } from "./landed-check.fixture.js";

const ROOT = join(tmpdir(), `gcs-fwdgates-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const HOLDER = "http://holder.test/v2/impulses/resolve";
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SELF_RESOLVE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SELF_RESOLVE_ENDPOINT"] = "http://self.test/v2/impulses/resolve";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const FIX = join(import.meta.dir, "..", "fixtures", "check-contract-mismatch");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
const SITE_REL = "src/resolvers/template-input-lint-scan.ts";
const SITE = `repos/${VESSEL}/${SITE_REL}`;
const TREE: Record<string, string> = {
  [SITE_REL]: fixture("template-input-lint-scan.at-333be5f.ts.txt"),
  "src/resolvers/types.ts": "export type ResolverResult = { shape: string; body: unknown };\n",
  "src/lib/self-auth.ts": "export function selfAuthHeaders(_url: string, _self: string): Record<string, string> { return {}; }\n",
  "src/seed/index.ts": "export const SEED_TEMPLATES: unknown[] = [];\n",
};
/** genuine-red's check with its last assertion reading through a field the report never has: red on a TypeError. */
const WRONG_REASON = fixture("genuine-red.check.ts.txt").replace("expect(result.body.finding_count).toBe(1);", "expect((result.body as any).nope.deeper).toBe(1);");

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let lastShellOutput = "";
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
/** Whether the stub holder answers the check's own pointer (a real holder serves test_suite; an unreachable one does not). */
let holderServesReports = true;
/** Every test_suite run, and which node ran it. */
let suiteRuns: Array<{ test_file: unknown; on_holder: boolean; via: "judge" | "holder_url" }> = [];
/** The suite's single-test checks predate CHECK_NO_CONTROL_STAGE: off, except where a case runs the default (unset). */
let controlDefault = false;
let logged: string[] = [];
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", ...(controlDefault ? {} : { require_control: false }), budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });

async function asHolder<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  try { return await fn(); } finally { if (was === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = was; }
}
async function holderRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
async function runSuite(pointer: Row, via: "judge" | "holder_url"): Promise<Response> {
  const r = await resolveTestSuite(pointer as never);
  suiteRuns.push({ test_file: pointer["test_file"], on_holder: !process.env["GAP_STORE_ENDPOINT"], via });
  return Response.json({ success: true, shape: r.shape, body: r.body });
}
/** The forward URL, answered by the holder's own resolvers in its own turn. */
async function holderAnswers(pointer: Row): Promise<Response> {
  return asHolder(async () => {
    if (pointer["type"] === "test_suite") {
      if (!holderServesReports) return Response.json({ success: false, shape: "structuredError", body: { detail: "fixture: the holder does not answer this pointer" } });
      return runSuite(pointer, "holder_url");
    }
    let r: { shape: string; body: unknown };
    if (pointer["type"] === "substrateGap") r = await sg.resolveSubstrateGap(pointer as never);
    else if (pointer["type"] === "substrateGap_write") r = await sg.resolveSubstrateGapWrite(pointer as never);
    else r = { shape: "structuredError", body: { detail: `the test holder does not serve ${String(pointer["type"])}` } };
    await sg.__settleBirthEvaluationsForTests();
    return Response.json(r);
  });
}

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const base of [join(CLONES, VESSEL), join(RUNTIME, VESSEL)]) {
    for (const d of ["test/checks", "node_modules"]) mkdirSync(join(base, d), { recursive: true });
    for (const [rel, text] of Object.entries(TREE)) { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); }
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url === HOLDER) return holderAnswers((imp.pointer ?? {}) as Row);
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-${Math.random().toString(36).slice(2, 8)}` }, { status: 202 });
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") return runSuite(imp.pointer as Row, "judge");
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability" && (body?.pointer ?? imp?.pointer)?.shape === "shellResult") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    if (url.startsWith("http://shell.test")) {
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='[^']*'/, `ROOT='${join(CLONES, VESSEL)}'`);
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: join(CLONES, VESSEL), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      lastShellOutput = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      return Response.json({ stdout: lastShellOutput });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [dueRhythm()], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { suiteRuns = []; logged = []; controlDefault = false; holderServesReports = true; delete process.env["GAP_STORE_ENDPOINT"]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { delete process.env["GAP_STORE_ENDPOINT"]; expect(execGuard?.restore() ?? []).toEqual([]); });

const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
const stored = (id: string): Promise<Row | undefined> => asHolder(() => holderRow(id));
async function seed(id: string): Promise<void> {
  const summary = `fixture ${id}: ${SITE} \`resolveTemplateInputLintScan\` misses a template's unused input`;
  const w = await asHolder(() => sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never));
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
}
/** One check-supply tick on the FORWARDING node: its gap reads and writes go to HOLDER. */
async function forwardingTick(now: number): Promise<void> {
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  try { await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never); } finally { delete process.env["GAP_STORE_ENDPOINT"]; }
}
/** One tick on the HOLDER (the store held here). */
async function holderTick(now: number): Promise<void> {
  await asHolder(() => supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never));
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
/** Seed a gap, dispatch for it, land `check` as its check file, and let the FORWARDING node hand it off and settle it. */
async function landOnForwardingNode(prefix: string, check: string): Promise<{ id: string; afterHandOff: Row; row: Row }> {
  const id = T(prefix);
  await seed(id);
  await forwardingTick(later());
  expect(ledgerOf(await stored(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id), edit_site: SITE });
  writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), check);
  landCheck(join(CLONES, VESSEL), checkPathOf(id));
  await forwardingTick(later()); // the hand-off: the holder measures the check in its own turn
  const afterHandOff = (await stored(id))!;
  await forwardingTick(later()); // the settlement, from the holder's stamp and the holder's report
  return { id, afterHandOff, row: (await stored(id))! };
}

// First, so the holder's own tick meets only this test's rows.
describe("[CONTROL] on the holder (no GAP_STORE_ENDPOINT) the gates are unchanged", () => {
  it("[CONTROL] a right-reason red check arms on the holder, and 333be5f's check is refused there", async () => {
    const good = T("loc-genuine");
    const bad = T("loc-333");
    await seed(good);
    await seed(bad);
    await holderTick(later());
    writeFileSync(join(CLONES, VESSEL, checkPathOf(good)), fixture("genuine-red.check.ts.txt"));
    landCheck(join(CLONES, VESSEL), checkPathOf(good));
    writeFileSync(join(CLONES, VESSEL, checkPathOf(bad)), fixture("333be5f-template-input-lint-harness-check-scenario.check.ts.txt"));
    landCheck(join(CLONES, VESSEL), checkPathOf(bad));
    await holderTick(later());
    const g = await stored(good);
    expect(ledgerOf(g)["state"]).toBe("armed");
    expect(metaOf(g)["predicate_birth_verdict"]).toBe("present");
    const b = await stored(bad);
    expect(ledgerOf(b)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(b)["reason"])).toContain("check_asserts_contract_mismatch:shape");
    expect(suiteRuns.every((r) => r.on_holder && r.via === "judge")).toBe(true); // nothing was read through a forward
  });
});

describe("a forwarding node judges a handed-off check by the same gates, from the holder's report", () => {
  it("[MUST-FAIL] 333be5f's check (verbatim) handed off from a forwarding node is NOT armed: check_asserts_contract_mismatch:shape", async () => {
    const { id, afterHandOff, row } = await landOnForwardingNode("fwd-333", fixture("333be5f-template-input-lint-harness-check-scenario.check.ts.txt"));
    expect(metaOf(afterHandOff)["predicate_birth_verdict"]).toBe("present"); // the holder read it red: the verdict alone would arm it
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toContain("check_asserts_contract_mismatch:shape");
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull(); // taken back off the row: unarmed, asked again
    expect(ledgerOf(row)["first_failure"]).toMatchObject({ error: "error: expect(received).toBe(expected)", expected: "\"template_input_lint_issues\"", received: "\"templateInputLintReport\"" });
    // The report was the holder's run, read through the forward; this node ran nothing itself.
    const runs = suiteRuns.filter((r) => r.test_file === checkPathOf(id));
    expect(runs.map((r) => r.via)).toEqual(["judge", "holder_url"]);
    expect(runs.every((r) => r.on_holder)).toBe(true);
  });

  it("[MUST-FAIL] a check red on a body field its resolver never sets, handed off from a forwarding node, is NOT armed", async () => {
    const { row } = await landOnForwardingNode("fwd-body", fixture("body-field.check.ts.txt"));
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toContain("check_asserts_contract_mismatch:body.unusedInputs");
  });

  it("[MUST-FAIL] a check red for the wrong reason (a TypeError, not an assertion), handed off from a forwarding node, is NOT armed", async () => {
    const { afterHandOff, row } = await landOnForwardingNode("fwd-wrong", WRONG_REASON);
    expect(metaOf(afterHandOff)["predicate_birth_verdict"]).toBe("present");
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).not.toContain("check_asserts_contract_mismatch");
    expect(ledgerOf(row)["last_verdict"]).toBe("present");
  });

  it("[CONTROL] a right-reason red check handed off from a forwarding node arms", async () => {
    const { row } = await landOnForwardingNode("fwd-genuine", fixture("genuine-red.check.ts.txt"));
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(metaOf(row)["edit_site"]).toBe(SITE);
    expect(metaOf(row)["predicate_birth_verdict"]).toBe("present");
    expect(sg.predicateSuspect(metaOf(row))).toBeNull();
  });

  it("[MUST-FAIL] a check armed from a forwarding node keeps its first failure (error line, Expected, Received) on the ledger", async () => {
    const { row } = await landOnForwardingNode("fwd-first", fixture("genuine-red.check.ts.txt"));
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(ledgerOf(row)["first_failure"]).toEqual({ name: "genuine > flags the unused input", error: "error: expect(received).toBe(expected)", expected: "1", received: "0" });
  });

  it("[MUST-FAIL] a holder whose report cannot be read arms nothing: the row waits, and arms once the report is read", async () => {
    holderServesReports = false;
    const { id, afterHandOff, row } = await landOnForwardingNode("fwd-unread", fixture("genuine-red.check.ts.txt"));
    expect(metaOf(afterHandOff)["predicate_birth_verdict"]).toBe("present");
    expect(ledgerOf(row)["state"]).toBe("goal_dispatched"); // not armed on the verdict alone, not refused either
    expect(ledgerOf(row)["armed_at"]).toBeUndefined();
    holderServesReports = true;
    await forwardingTick(later());
    const armed = await stored(id);
    expect(ledgerOf(armed)["state"]).toBe("armed");
  });
});

describe("a forwarding node refuses a handed-off check with no control, by default", () => {
  const CONTROL_TEST = `  test('a template with no inputs is still scanned (control)', async () => {
    const result = await mod.resolveTemplateInputLintScan({ type: 'template_input_lint_scan', dry_run: true, _templates: [] });
    expect(result.shape).toBe('templateInputLintReport');
  });
});`;
  it("[MUST-FAIL] with require_control unset, a right-reason red check with no control is NOT armed: check_no_control, counted in the control line", async () => {
    controlDefault = true;
    const { afterHandOff, row } = await landOnForwardingNode("fwd-nocontrol", fixture("genuine-red.check.ts.txt"));
    expect(metaOf(afterHandOff)["predicate_birth_verdict"]).toBe("present");
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toStartWith("check_no_control:");
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull();
    expect(logged.some((l) => /^\[check-supply\] control: check_no_control=1 armed_with_control=0 control_titles=0 armed=0 require_control=on /.test(l))).toBe(true);
  });
  it("[CONTROL] with require_control unset, the same check plus a green control arms from a forwarding node, counted", async () => {
    controlDefault = true;
    const withControl = fixture("genuine-red.check.ts.txt").replace(/\n\}\);\s*$/, `\n${CONTROL_TEST}\n`);
    expect(withControl).toContain("(control)");
    const { row } = await landOnForwardingNode("fwd-withcontrol", withControl);
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(ledgerOf(row)["control_titles"]).toEqual(["a template with no inputs is still scanned (control)"]);
    expect(logged.some((l) => /^\[check-supply\] control: check_no_control=0 armed_with_control=1 control_titles=1 armed=1 require_control=on /.test(l))).toBe(true);
  });
});
