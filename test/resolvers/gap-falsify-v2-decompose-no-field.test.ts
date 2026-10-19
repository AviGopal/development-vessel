// THE ARM STEP AND THE JUDGE AGREE ON A test_suite CHECK THAT NAMES NO FIELD (gap-check-judge.ts
// testSuiteWholeFileDefault; gap-admission.ts validateShapeCheck; qa ruling, 2026-10-19). The judge answers such a
// check of one test_file by its whole-file default (the named tests' requested_not_passing, else every case of the
// file); the decomposition arm step refused it as "names no zero_field/nonzero_field, so it could never be judged".
// Two judges of one check disagreed. This file drives the same check through both and asserts they agree.
//
// The harness is gap-falsify-v2-decompose.test.ts's (the real decomposeGap, validation, judge and store; the LLM and
// descriptions injected; globalThis.fetch for discovery and the vessel's resolve), with a test_suite answer that also
// reports whole-file counts. That accepted file is not edited.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gf2-decompose-nofield-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fCredit = await import("../../src/judge/gap-attempt-credit.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, __setFleetVocabularyForTests } = sg;
const { decomposeGap } = g2f;
const { evaluateGapCheck } = await import("../../src/judge/gap-check-judge.js");
const { bumpFailedAttempts } = g2fCredit;
const { __resetPolicyReadsForTests } = g2fPolicy;

const RUN = Math.random().toString(36).slice(2, 8);
const CLONES = join(ROOT, "clones");
const ADVERTISED = new Set(["test_suite", "widget_frame_report", "poolImpulse", "uiPanel_write"]);
const tree: Record<string, "pass" | "fail"> = { "widget counts rejected frames": "fail", "widget already passes": "pass" };
const DESCRIPTIONS: Record<string, string> = {
  widget_frame_report: "counts widget frames rejected by the frame validator (defects)",
  unrelated_report: "reports the weather",
  uiPanel_write: "writes a ui panel",
};
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let testSuiteCalls = 0;
let llmLookups = 0;
let runGoalCalls = 0;
let frameDefects = 2;
let wholeFileFails = 1;
let llmMode: "none" | "serve" = "none";
let frameReportCalls = 0;
const FWD = "http://holder.test/v2/impulses/resolve";
const forwarded: Array<Record<string, unknown>> = [];
let llmReply: Record<string, unknown> = {};

function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      if (body.pointer.shape === "llm_completion") { llmLookups++; return Response.json({ content: { vessels: llmMode === "serve" ? [{ endpoint: "http://llm.test", resolve_endpoint: "/resolve" }] : [] } }); }
      const vessels = ADVERTISED.has(body.pointer.shape) ? [{ vesselId: "dv", endpoint: "http://node.test", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }] : [];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: vessels.length > 0 } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (url === FWD) {
      const fp = body?.impulse?.pointer ?? {};
      if (fp.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [] } });
      forwarded.push(fp);
      return Response.json({ shape: "substrateGapWriteResult", body: { action: "created" } });
    }
    if (url.endsWith("/run-goal")) { runGoalCalls++; return Response.json({ ok: true }); }
    if (url === "http://llm.test/resolve" && body?.type === "llm_completion") return Response.json({ content: JSON.stringify(llmReply) });
    if (url.endsWith("/registry/shape-descriptions")) return Response.json({ shape_descriptions: DESCRIPTIONS });
    const p = body?.impulse?.pointer;
    if (p?.type === "test_suite") {
      testSuiteCalls++;
      const only = (p.only_tests ?? []) as string[];
      const notPassing = only.filter((t) => tree[t] !== "pass").length;
      // Whole-file counts too: two passing cases plus wholeFileFails failing ones.
      if (only.length === 0) return Response.json({ shape: "test_suite", body: { ran: true, total: 2 + wholeFileFails, pass: 2, fail: wholeFileFails, skip: 0, requested_not_passing: null } });
      return Response.json({ shape: "test_suite", body: { ran: true, requested_not_passing: notPassing } });
    }
    if (p?.type === "widget_frame_report") frameReportCalls++;
    if (p?.type === "widget_frame_report") return Response.json({ shape: "widget_frame_report", body: { defects: frameDefects } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const TS_CHECK = (name: string, file = "test/widget.test.ts") => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: file, only_tests: [name] }, zero_field: "requested_not_passing" } });
async function parentGap(suffix: string, meta: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = `gf2-parent-${suffix}-${RUN}`;
  const gap = { id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary: `The widget frame validator counts rejected frames wrong (${suffix})`, classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", ...meta } };
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never);
  return gap;
}
async function row(id: string): Promise<Record<string, unknown> | null> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  return ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((x) => x.id === id) ?? null;
}
const metaOf = (g: Record<string, unknown> | null) => ((g?.classification_metadata ?? {}) as Record<string, unknown>);
function stubLlm(reply: Record<string, unknown>, prompts: string[] = []) {
  return async (prompt: string) => { prompts.push(prompt); return JSON.stringify(reply); };
}
const deps = (reply: Record<string, unknown>, prompts: string[] = []) => ({ llm: stubLlm(reply, prompts), shapeDescriptions: async () => DESCRIPTIONS });

// Leave the shared gap store as this file found it (test/resolvers/gap-store-snapshot.ts).
let gapStore: { restore: () => Promise<void> } | null = null;
beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), __settleBirthEvaluationsForTests);
  // The fixture shapes exist only in this file's discovery stub, not in any fleet config, so the
  // classifier's filesystem vocabulary must not judge them: pin "cannot judge" on every host.
  __setFleetVocabularyForTests({ v: null });
  for (const k of ["VESSELS_CLONE_ROOT", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
  mkdirSync(join(CLONES, "fixture-vessel", "src"), { recursive: true });
  mkdirSync(join(CLONES, "fixture-vessel", "test"), { recursive: true });
  writeFileSync(join(CLONES, "fixture-vessel", "src", "widget.ts"), "export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; }\n");
  writeFileSync(join(CLONES, "fixture-vessel", "test", "widget.test.ts"), 'import { it } from "bun:test";\nit("widget counts rejected frames", () => {});\nit("widget already passes", () => {});\nit("unrelated gadget test", () => {});\n');
  install();
  __resetPolicyReadsForTests();
});
beforeEach(() => { frameDefects = 2; });
afterAll(async () => {
  await gapStore?.restore();
  __setFleetVocabularyForTests(null);
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const NOFIELD = (input: Record<string, unknown>) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", ...input } } });
/** The judge alone on the same check, on the same transport. */
const judgeAlone = (check: Record<string, unknown>) => evaluateGapCheck({ id: `gf2-nofield-judge-${RUN}`, classification_metadata: { ...check, falsifier: "class2" } });

describe("a test_suite check naming no field: the arm step agrees with the judge", () => {
  it("MUST-FAIL: named tests, no field: the judge reads present, and the arm step writes it (in the explicit form)", async () => {
    const check = NOFIELD({ only_tests: ["widget counts rejected frames"] });
    expect(await judgeAlone(check)).toBe("present");
    const parent = await parentGap("nofield-named");
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: check, steps: [] }) });
    await __settleBirthEvaluationsForTests();
    expect(d.parent_check).toBe("written");
    const m = metaOf(await row(String(parent.id)));
    expect(m.evidence_resolve).toMatchObject({ shape: "test_suite", zero_field: "requested_not_passing", input: { only_tests: ["widget counts rejected frames"] } });
    expect(m.predicate_birth_verdict).toBe("present");
  });

  it("MUST-FAIL: the whole file, no field, a failing case: the judge reads present, and the arm step writes it with no field", async () => {
    wholeFileFails = 1;
    const check = NOFIELD({});
    expect(await judgeAlone(check)).toBe("present");
    const parent = await parentGap("nofield-whole");
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: check, steps: [] }) });
    await __settleBirthEvaluationsForTests();
    expect(d.parent_check).toBe("written");
    const m = metaOf(await row(String(parent.id)));
    expect((m.evidence_resolve as Record<string, unknown>).zero_field).toBeUndefined();
    expect(((m.evidence_resolve as { input?: Record<string, unknown> }).input ?? {}).only_tests).toBeUndefined();
    expect(m.predicate_birth_verdict).toBe("present");
  });

  it("MUST-FAIL (a step): a no-field whole-file step check the judge reads present is armed as a step", async () => {
    wholeFileFails = 1;
    const parent = await parentGap("nofield-step");
    const d = await decomposeGap(parent, { parentCheck: false, deps: deps({ steps: [{ edit_site: "repos/fixture-vessel/src/widget.ts", change: "countRejected must use validateFrame", falsifier: NOFIELD({}) }] }) });
    await __settleBirthEvaluationsForTests();
    expect(d.written).toEqual([`${String(parent.id)}-step-1`]);
  });

  it("control: the whole file all passing: the judge reads absent, and the arm step refuses it as absent (agreeing)", async () => {
    wholeFileFails = 0;
    const check = NOFIELD({});
    expect(await judgeAlone(check)).toBe("absent");
    const parent = await parentGap("nofield-green");
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: check, steps: [] }) });
    expect(d.parent_check).toMatch(/reads absent on the current tree/);
    wholeFileFails = 1;
  });

  it("control: no field and no test_file (a whole-suite run): the judge reads unknown, and the arm step refuses it", async () => {
    const check = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel" } } };
    expect(await judgeAlone(check)).toBe("unknown");
    const parent = await parentGap("nofield-suite");
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: check, steps: [] }) });
    expect(d.parent_check).toMatch(/names no zero_field\/nonzero_field/);
  });

  it("control: another named field is still refused, and an invented test name still fails the source check", async () => {
    const p1 = await parentGap("nofield-other");
    const d1 = await decomposeGap(p1, { parentCheck: true, deps: deps({ parent_check: { ...NOFIELD({ only_tests: ["widget counts rejected frames"] }), evidence_resolve: { ...NOFIELD({ only_tests: ["widget counts rejected frames"] }).evidence_resolve, zero_field: "fail" } }, steps: [] }) });
    expect(d1.parent_check).toMatch(/judged by zero_field requested_not_passing/);
    const p2 = await parentGap("nofield-invented");
    const d2 = await decomposeGap(p2, { parentCheck: true, deps: deps({ parent_check: NOFIELD({ only_tests: ["widget counts phantom frames"] }), steps: [] }) });
    expect(d2.parent_check).toMatch(/is not in/);
  });
});
